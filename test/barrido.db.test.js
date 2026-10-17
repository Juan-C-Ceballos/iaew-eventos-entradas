const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { configuracionMongo } = require('./helpers/mongo');
const { crearServidor, configuracion } = require('../services/pagos-mock/server');

// El barrido del worker contra MongoDB real y la pasarela simulada real: vencimientos,
// conciliación de pagos cuyo webhook nunca llegó, cierre de eventos, cascadas pendientes y
// reconciliación de cupo. Se omite sin MONGODB_URI_TEST (ver helpers/mongo.js).
const MONGO = configuracionMongo('barrido');
if (!MONGO) {
  test('integración del barrido con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');

let Evento;
let Compra;
let Entrada;
let barrido;
let outbox;
let pasarela;
let urlPasarela;

before(async () => {
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Entrada = require('../src/models/Entrada');
  barrido = require('../src/lib/barrido');
  outbox = require('../src/lib/outbox');
  await Promise.all([Compra.createIndexes(), Entrada.createIndexes()]);
  // Sin webhook: la pasarela resuelve el pago pero no notifica, que es el caso que concilia el barrido.
  pasarela = crearServidor(configuracion({ PORT: '0', WEBHOOK_HABILITADO: 'false', PAGO_DEMORA_MS: '10' }), { log: () => {} });
  await new Promise((resolve) => pasarela.listen(0, '127.0.0.1', resolve));
  urlPasarela = `http://127.0.0.1:${pasarela.address().port}`;
  process.env.PAGOS_URL = urlPasarela;
});

after(async () => {
  await new Promise((resolve) => pasarela.close(resolve));
  await mongoose.disconnect();
});

beforeEach(async () => {
  process.env.PAGOS_URL = urlPasarela;
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Entrada.deleteMany({})]);
});

const minutos = (n) => new Date(Date.now() + n * 60 * 1000);
const horas = (n) => minutos(n * 60);
const silencioso = { log: () => {}, warn: () => {}, error: () => {} };
const pasada = (opciones = {}) => barrido.crearBarrido({ log: silencioso, ...opciones }).pasada();

const crearEvento = (extra = {}) => {
  const capacidad = extra.capacidad ?? 10;
  return Evento.create({ nombre: 'Recital', fecha: horas(24 * 30), lugar: 'Córdoba', capacidad, cupoDisponible: capacidad, precio: 100, estado: 'publicado', ...extra });
};
const cupoDe = async (evento) => (await Evento.findById(evento._id).lean()).cupoDisponible;
const compraDe = (compra) => Compra.findById(compra._id).lean();

// Una compra armada a mano, sin pasar por la API.
async function insertarCompra(evento, campos) {
  const _id = new mongoose.Types.ObjectId();
  await Compra.collection.insertOne({
    _id, eventoId: evento._id, asistenteId: new mongoose.Types.ObjectId(), creadaPor: 'canal@clients', cantidad: 2, precioUnitario: 100, total: 200,
    // El índice único (creadaPor, idempotencyKey) no admite dos compras sin clave.
    idempotencyKey: `raw-${_id}`, idempotencyFingerprint: 'huella',
    asistente: { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' }, reembolsoPendiente: false,
    createdAt: new Date(), updatedAt: new Date(), ...campos
  });
  return { _id, total: campos.total ?? 200 };
}
const pagoVencido = (evento, campos = {}) => insertarCompra(evento, {
  estado: 'pago_pendiente', reservaExpiraEn: minutos(-60), pagoExpiraEn: minutos(-1),
  pago: { estado: 'pendiente', idempotencyKey: `pago-${new mongoose.Types.ObjectId()}`, solicitadoEn: minutos(-31) }, ...campos
});

// Le pide un cobro a la pasarela real, como haría /pagar.
async function cobrarEnPasarela(compra, escenario) {
  const res = await fetch(`${urlPasarela}/pagos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ compraId: String(compra._id), monto: compra.total, escenario }) });
  assert.ok([200, 201].includes(res.status));
  await new Promise((resolve) => setTimeout(resolve, 60)); // PAGO_DEMORA_MS
}

test('reservas: las vencidas pasan a expirada y devuelven el cupo; las vigentes no se tocan', async () => {
  const evento = await crearEvento({ cupoDisponible: 3 });
  const vencidaA = await insertarCompra(evento, { estado: 'pendiente', cantidad: 2, reservaExpiraEn: minutos(-5) });
  const vencidaB = await insertarCompra(evento, { estado: 'pendiente', cantidad: 3, reservaExpiraEn: minutos(-1) });
  const vigente = await insertarCompra(evento, { estado: 'pendiente', cantidad: 2, reservaExpiraEn: minutos(10) });

  assert.equal((await pasada()).reservasExpiradas, 2);
  assert.deepEqual([(await compraDe(vencidaA)).estado, (await compraDe(vencidaB)).estado, (await compraDe(vigente)).estado], ['expirada', 'expirada', 'pendiente']);
  assert.equal(await cupoDe(evento), 3 + 2 + 3);
  assert.equal((await pasada()).reservasExpiradas, 0, 'repetir no libera dos veces');
  assert.equal(await cupoDe(evento), 8);
});

test('reservas: 5 barridos simultáneos devuelven el cupo una sola vez', async () => {
  const evento = await crearEvento({ cupoDisponible: 7 });
  await insertarCompra(evento, { estado: 'pendiente', cantidad: 3, reservaExpiraEn: minutos(-5) });
  await Promise.all(Array.from({ length: 5 }, () => pasada()));
  assert.equal(await cupoDe(evento), 10);
});

test('conciliación: resuelve según la pasarela cuando el webhook nunca llegó', async () => {
  const evento = await crearEvento({ cupoDisponible: 4 });
  const aprobada = await pagoVencido(evento);
  const rechazada = await pagoVencido(evento);
  const desconocida = await pagoVencido(evento);
  const sinVencer = await pagoVencido(evento, { pagoExpiraEn: minutos(20) });
  await cobrarEnPasarela(aprobada, 'aprobado');
  await cobrarEnPasarela(rechazada, 'rechazado');
  await cobrarEnPasarela(sinVencer, 'aprobado');

  const { pagos } = await pasada();
  assert.deepEqual(pagos, { pagadas: 1, rechazadas: 1, expiradas: 1, pendientes: 0, sinRespuesta: 0 });

  const pagada = await compraDe(aprobada);
  assert.deepEqual([pagada.estado, pagada.pago.estado, pagada.emisionEstado], ['pagada', 'aprobado', 'pendiente']);
  assert.match(pagada.pago.referenciaExterna, /^PAY-/);
  assert.match(pagada.emisionEvento.correlationId, /^barrido-/);
  assert.equal(pagada.emisionEvento.data.compraId, String(aprobada._id));

  const rech = await compraDe(rechazada);
  assert.deepEqual([rech.estado, rech.pago.motivoRechazo], ['rechazada', 'fondos_insuficientes']);

  const exp = await compraDe(desconocida);
  assert.deepEqual([exp.estado, exp.pago.motivoRechazo], ['expirada', 'pago_no_registrado_en_la_pasarela']);

  assert.equal((await compraDe(sinVencer)).estado, 'pago_pendiente', 'todavía no venció');

  // Rechazada y expirada devolvieron 2 + 2 de cupo; la aprobada lo conserva.
  assert.equal(await cupoDe(evento), 4 + 2 + 2);

  // El relay del outbox encuentra la compra que concilió el barrido.
  const publicados = [];
  await outbox.publicarPendientes({ publish: async (sobre) => publicados.push(sobre) });
  assert.ok(publicados.some((sobre) => sobre.data.compraId === String(aprobada._id)));
});

test('conciliación: si la pasarela todavía está procesando el pago, no se toca la compra', async () => {
  const lenta = crearServidor(configuracion({ PORT: '0', WEBHOOK_HABILITADO: 'false', PAGO_DEMORA_MS: '60000' }), { log: () => {} });
  await new Promise((resolve) => lenta.listen(0, '127.0.0.1', resolve));
  try {
    process.env.PAGOS_URL = `http://127.0.0.1:${lenta.address().port}`;
    const evento = await crearEvento({ cupoDisponible: 8 });
    const compra = await pagoVencido(evento);
    await fetch(`${process.env.PAGOS_URL}/pagos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ compraId: String(compra._id), monto: 200 }) });

    assert.deepEqual((await pasada()).pagos, { pagadas: 0, rechazadas: 0, expiradas: 0, pendientes: 1, sinRespuesta: 0 });
    assert.equal((await compraDe(compra)).estado, 'pago_pendiente', 'se vuelve a consultar en el próximo barrido');
    assert.equal(await cupoDe(evento), 8);
  } finally {
    await new Promise((resolve) => lenta.close(resolve));
  }
});

test('conciliación: 6 barridos simultáneos sobre el mismo pago aprobado lo registran una sola vez', async () => {
  const evento = await crearEvento({ cupoDisponible: 8 });
  const compra = await pagoVencido(evento);
  await cobrarEnPasarela(compra, 'aprobado');

  const resultados = await Promise.all(Array.from({ length: 6 }, () => pasada()));
  assert.equal(resultados.reduce((suma, r) => suma + r.pagos.pagadas, 0), 1);
  assert.equal((await compraDe(compra)).estado, 'pagada');
  assert.equal(await cupoDe(evento), 8);
});

test('conciliación: con la pasarela caída no se expira nada y el resto del barrido sigue', async () => {
  const evento = await crearEvento({ cupoDisponible: 5 });
  const sinRespuesta = await pagoVencido(evento);
  const otraSinRespuesta = await pagoVencido(evento);
  const vencida = await insertarCompra(evento, { estado: 'pendiente', cantidad: 3, reservaExpiraEn: minutos(-5) });
  const puerto = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  process.env.PAGOS_URL = `http://127.0.0.1:${puerto}`;

  const resultados = await pasada();
  // El paso se corta en la primera consulta fallida: las dos compras quedan sin respuesta (ADR 0013).
  assert.equal(resultados.pagos.sinRespuesta, 2);
  assert.equal((await compraDe(sinRespuesta)).estado, 'pago_pendiente', 'ante la duda no se concluye nada');
  assert.equal((await compraDe(otraSinRespuesta)).estado, 'pago_pendiente');
  assert.equal((await compraDe(vencida)).estado, 'expirada', 'la reserva vencida se resolvió igual');
  assert.equal(await cupoDe(evento), 5 + 3);

  // Cuando la pasarela vuelve y no conoce los pagos, recién ahí expiran.
  process.env.PAGOS_URL = urlPasarela;
  assert.equal((await pasada()).pagos.expiradas, 2);
  assert.equal((await compraDe(sinRespuesta)).estado, 'expirada');
  assert.equal((await compraDe(otraSinRespuesta)).estado, 'expirada');
});

test('un pago aprobado que llega después de expirar queda marcado para reembolso', async () => {
  const evento = await crearEvento({ cupoDisponible: 8 });
  const compra = await pagoVencido(evento);
  await pasada(); // la pasarela no la conoce: expira y libera
  assert.equal((await compraDe(compra)).estado, 'expirada');

  const { registrarPagoAprobado } = require('../src/services/pagos');
  const consola = console.error;
  console.error = () => {};
  try {
    const { resultado } = await registrarPagoAprobado(compra._id, { referenciaExterna: 'PAY-tardio', correlationId: 'c' });
    assert.equal(resultado, 'conflicto');
  } finally {
    console.error = consola;
  }
  assert.equal((await compraDe(compra)).reembolsoPendiente, true);
  assert.equal(await cupoDe(evento), 10);
});

test('eventos: los publicados que terminaron hace más del plazo pasan a finalizado', async () => {
  const viejo = await crearEvento({ fecha: horas(-13) });
  const reciente = await crearEvento({ fecha: horas(-5) });
  const futuro = await crearEvento();
  const borrador = await crearEvento({ estado: 'borrador', fecha: horas(-48) });
  const cancelado = await crearEvento({ estado: 'cancelado', fecha: horas(-48) });

  assert.equal((await pasada({ eventoFinalizaTrasHoras: 12 })).eventosFinalizados, 1);
  const estados = async (...eventos) => Promise.all(eventos.map(async (e) => (await Evento.findById(e._id).lean()).estado));
  assert.deepEqual(await estados(viejo, reciente, futuro, borrador, cancelado), ['finalizado', 'publicado', 'publicado', 'borrador', 'cancelado']);
  assert.equal((await pasada({ eventoFinalizaTrasHoras: 12 })).eventosFinalizados, 0);
  assert.equal((await pasada({ eventoFinalizaTrasHoras: 4 })).eventosFinalizados, 1, 'con un plazo menor, el reciente también');
});

test('cancelaciones: se retoma la cascada hasta que no queda nada pendiente', async () => {
  const evento = await crearEvento({ estado: 'cancelado' });
  const pendiente = await insertarCompra(evento, { estado: 'pendiente', reservaExpiraEn: minutos(10) });
  const conPago = await insertarCompra(evento, { estado: 'pago_pendiente', reservaExpiraEn: minutos(10), pagoExpiraEn: minutos(20), pago: { estado: 'pendiente', idempotencyKey: 'pago-x-00000' } });
  const pagada = await insertarCompra(evento, { estado: 'pagada', emisionEstado: 'emitida' });
  await Entrada.collection.insertMany([
    { codigo: 'ENT-AAAAAAAAAAAA', compraId: pagada._id, eventoId: evento._id, numero: 1, estado: 'emitida' },
    { codigo: 'ENT-BBBBBBBBBBBB', compraId: pagada._id, eventoId: evento._id, numero: 2, estado: 'usada' }
  ]);

  assert.equal((await pasada()).cancelacionesCompletadas, 0, 'hay un pago por resolverse');
  assert.equal((await compraDe(pendiente)).estado, 'cancelada');
  assert.equal((await compraDe(pagada)).reembolsoPendiente, true);
  assert.deepEqual((await Entrada.find({}).sort({ numero: 1 }).lean()).map((e) => e.estado), ['anulada', 'usada']);
  assert.equal((await Evento.findById(evento._id).lean()).cancelacionProcesadaEn, undefined);

  // El pago se resuelve (rechazado): la próxima pasada completa la cascada.
  await Compra.updateOne({ _id: conPago._id }, { $set: { estado: 'rechazada' } });
  assert.equal((await pasada()).cancelacionesCompletadas, 1);
  assert.ok((await Evento.findById(evento._id).lean()).cancelacionProcesadaEn);
  assert.equal((await pasada()).cancelacionesCompletadas, 0, 'ya está procesada');
});

test('cupo: una diferencia persistente se corrige en el segundo barrido, no en el primero', async () => {
  // capacidad 10; ocupan cupo 2 (pendiente) + 3 (pagada); las demás no cuentan.
  const evento = await crearEvento({ cupoDisponible: 4 });
  await insertarCompra(evento, { estado: 'pendiente', cantidad: 2, reservaExpiraEn: minutos(10) });
  await insertarCompra(evento, { estado: 'pagada', cantidad: 3, emisionEstado: 'emitida' });
  for (const estado of ['cancelada', 'expirada', 'rechazada']) await insertarCompra(evento, { estado, cantidad: 4 });
  const { pasada: pasadaConEstado } = barrido.crearBarrido({ log: silencioso });

  assert.equal((await pasadaConEstado()).cupo.observados, 1);
  assert.equal(await cupoDe(evento), 4, 'primera vez: solo se observa');
  assert.equal((await pasadaConEstado()).cupo.corregidos, 1);
  assert.equal(await cupoDe(evento), 5);
  assert.deepEqual((await pasadaConEstado()).cupo, { corregidos: 0, observados: 0 });
});

test('cupo: no se corrige un evento cancelado ni uno con más compras que lugares', async () => {
  const cancelado = await crearEvento({ estado: 'cancelado', cupoDisponible: 3 });
  const chico = await crearEvento({ capacidad: 2, cupoDisponible: 0 });
  await insertarCompra(chico, { estado: 'pagada', cantidad: 3, emisionEstado: 'emitida' });
  const { pasada: pasadaConEstado } = barrido.crearBarrido({ log: silencioso });
  await pasadaConEstado();
  await pasadaConEstado();
  assert.equal(await cupoDe(cancelado), 3);
  assert.equal(await cupoDe(chico), 0);
});

test('cupo: una reserva que se completa entre dos barridos no se "corrige"', async () => {
  const evento = await crearEvento({ cupoDisponible: 7 }); // descontó 3 y todavía no existe la compra
  const { pasada: pasadaConEstado } = barrido.crearBarrido({ log: silencioso });
  assert.equal((await pasadaConEstado()).cupo.observados, 1);
  await insertarCompra(evento, { estado: 'pendiente', cantidad: 3, reservaExpiraEn: minutos(10) }); // se crea la compra
  assert.deepEqual((await pasadaConEstado()).cupo, { corregidos: 0, observados: 0 });
  assert.equal(await cupoDe(evento), 7);
});
