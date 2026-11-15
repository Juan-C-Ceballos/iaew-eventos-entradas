const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');

// Integración contra MongoDB real: la reserva atómica y la idempotencia solo se pueden
// comprobar con requests concurrentes de verdad. Se omite sin MONGODB_URI_TEST (ver helpers/mongo.js).
const MONGO = configuracionMongo('compras');
if (!MONGO) {
  test('integración de compras con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');

let emisor;
let server;
let base;
let Evento;
let Compra;
let Asistente;
let Entrada;
let comprasService;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Asistente = require('../src/models/Asistente');
  Entrada = require('../src/models/Entrada');
  comprasService = require('../src/services/compras');
  // Los índices únicos (idempotencia por cliente, DNI) son los que producen E11000 en las carreras.
  await Promise.all([Compra.createIndexes(), Asistente.createIndexes(), Entrada.createIndexes()]);
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await emisor.close();
});

beforeEach(async () => {
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Asistente.deleteMany({}), Entrada.deleteMany({})]);
});

const CLIENTE_A = 'canal-a@clients';
const CLIENTE_B = 'canal-b@clients';
const ANA = { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' };

async function api(metodo, ruta, { cuerpo, clave, sub = CLIENTE_A } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${emisor.token({ scope: 'buy:entradas', sub })}`,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...(clave ? { 'Idempotency-Key': clave } : {})
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const texto = await res.text();
  return { status: res.status, cuerpo: texto ? JSON.parse(texto) : null, cabeceras: res.headers };
}

const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
const crearEvento = (extra = {}) => {
  const capacidad = extra.capacidad ?? 10;
  return Evento.create({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad, cupoDisponible: capacidad, precio: 100, estado: 'publicado', ...extra });
};
const pedido = (evento, extra = {}) => ({ eventoId: String(evento._id), cantidad: 1, asistente: ANA, ...extra });
const comprar = (evento, clave, opciones = {}) => api('POST', '/compras', { cuerpo: pedido(evento, opciones.datos), clave, sub: opciones.sub });
const cupoDe = async (evento) => (await Evento.findById(evento._id).lean()).cupoDisponible;

test('reservar: crea la compra pendiente, descuenta el cupo y no expone datos internos', async () => {
  const evento = await crearEvento({ precio: 25000 });
  const res = await api('POST', '/compras', { cuerpo: pedido(evento, { cantidad: 2 }), clave: 'compra:ana:0001' });

  assert.equal(res.status, 201);
  assert.equal(res.cabeceras.get('idempotency-replayed'), 'false');
  assert.deepEqual(res.cuerpo.idempotencia, { key: 'compra:ana:0001', replayed: false });
  const { compra } = res.cuerpo;
  assert.equal(compra.estado, 'pendiente');
  assert.equal(compra.total, 50000);
  assert.equal(compra.precioUnitario, 25000);
  assert.equal(compra.creadaPor, CLIENTE_A);
  assert.deepEqual(compra.asistente, ANA);
  assert.ok(new Date(compra.reservaExpiraEn) > new Date());
  for (const interno of ['idempotencyKey', 'idempotencyFingerprint', 'emisionEvento', 'emisionPublicadaEn', '__v']) {
    assert.equal(interno in compra, false, `no debe exponer ${interno}`);
  }
  assert.equal(await cupoDe(evento), 8);
  assert.equal(await Asistente.countDocuments({ documento: ANA.documento }), 1);

  const leida = await api('GET', `/compras/${compra._id}`);
  assert.equal(leida.status, 200);
  assert.equal(leida.cuerpo._id, compra._id);
});

test('idempotencia: repetir la solicitud devuelve la compra original sin reservar de nuevo', async () => {
  const evento = await crearEvento();
  const primera = await comprar(evento, 'clave-repetida-1');
  const segunda = await comprar(evento, 'clave-repetida-1');

  assert.equal(segunda.status, 201);
  assert.equal(segunda.cabeceras.get('idempotency-replayed'), 'true');
  assert.equal(segunda.cuerpo.idempotencia.replayed, true);
  assert.equal(segunda.cuerpo.compra._id, primera.cuerpo.compra._id);
  assert.equal(await cupoDe(evento), 9, 'el cupo se descontó una sola vez');

  const otroOrden = await api('POST', '/compras', { clave: 'clave-repetida-1', cuerpo: { asistente: ANA, cantidad: 1, eventoId: String(evento._id) } });
  assert.equal(otroOrden.cuerpo.idempotencia.replayed, true, 'el orden de los campos no cambia la huella');
});

test('idempotencia: la misma clave con otro cuerpo es 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
  const evento = await crearEvento();
  await comprar(evento, 'clave-repetida-2');
  const distinta = await comprar(evento, 'clave-repetida-2', { datos: { cantidad: 3 } });
  assert.equal(distinta.status, 409);
  assert.equal(distinta.cuerpo.code, 'IDEMPOTENCY_KEY_MISMATCH');
  assert.equal(await cupoDe(evento), 9);
});

test('idempotencia: la clave es única por cliente, no global', async () => {
  const evento = await crearEvento();
  const a = await comprar(evento, 'clave-compartida-1', { sub: CLIENTE_A });
  const b = await comprar(evento, 'clave-compartida-1', { sub: CLIENTE_B });
  assert.equal(b.status, 201);
  assert.equal(b.cuerpo.idempotencia.replayed, false, 'B no recibe la compra de A como replay');
  assert.notEqual(b.cuerpo.compra._id, a.cuerpo.compra._id);
  assert.equal(b.cuerpo.compra.creadaPor, CLIENTE_B);
  assert.equal(await cupoDe(evento), 8);
});

test('sobreventa: 25 reservas simultáneas sobre un evento de 2 lugares dejan exactamente 2', async () => {
  const evento = await crearEvento({ capacidad: 2 });
  const respuestas = await Promise.all(Array.from({ length: 25 }, (_, i) => comprar(evento, `carrera-${String(i).padStart(3, '0')}-clave`)));

  const exitosas = respuestas.filter((r) => r.status === 201);
  const agotadas = respuestas.filter((r) => r.status === 409);
  assert.equal(exitosas.length, 2);
  assert.equal(agotadas.length, 23);
  assert.ok(agotadas.every((r) => r.cuerpo.code === 'EVENT_SOLD_OUT'));
  assert.equal(await cupoDe(evento), 0);
  assert.equal(await Compra.countDocuments({ eventoId: evento._id }), 2);
});

test('idempotencia: 10 solicitudes simultáneas con la misma clave crean una sola compra', async () => {
  const evento = await crearEvento();
  const respuestas = await Promise.all(Array.from({ length: 10 }, () => comprar(evento, 'misma-clave-en-paralelo')));

  assert.ok(respuestas.every((r) => r.status === 201), respuestas.map((r) => `${r.status}:${r.cuerpo.code ?? ''}`).join());
  assert.equal(new Set(respuestas.map((r) => r.cuerpo.compra._id)).size, 1);
  assert.equal(respuestas.filter((r) => !r.cuerpo.idempotencia.replayed).length, 1, 'solo una crea la compra');
  assert.equal(await Compra.countDocuments({ eventoId: evento._id }), 1);
  assert.equal(await cupoDe(evento), 9, 'las que perdieron la carrera devolvieron su cupo');
});

test('rechazos: evento inexistente, no publicado, ya comenzado y sin cupo suficiente', async () => {
  const inexistente = await api('POST', '/compras', { cuerpo: { eventoId: '66f0000000000000000000ff', cantidad: 1, asistente: ANA }, clave: 'rechazo-inexistente' });
  assert.equal(inexistente.cuerpo.code, 'EVENT_NOT_FOUND');
  assert.equal(inexistente.status, 404);

  const borrador = await crearEvento({ estado: 'borrador' });
  const noPublicado = await comprar(borrador, 'rechazo-borrador-1');
  assert.deepEqual([noPublicado.status, noPublicado.cuerpo.code, noPublicado.cuerpo.details], [409, 'EVENT_NOT_PUBLISHED', { estado: 'borrador' }]);

  const empezado = await crearEvento({ fecha: enDias(-1) });
  const yaComenzo = await comprar(empezado, 'rechazo-empezado-1');
  assert.deepEqual([yaComenzo.status, yaComenzo.cuerpo.code], [409, 'EVENT_ALREADY_STARTED']);
  assert.equal(await cupoDe(empezado), 10, 'no se tocó el cupo');

  const chico = await crearEvento({ capacidad: 2 });
  const demasiadas = await comprar(chico, 'rechazo-cupo-0001', { datos: { cantidad: 3 } });
  assert.deepEqual([demasiadas.status, demasiadas.cuerpo.code], [409, 'EVENT_SOLD_OUT']);
  assert.deepEqual(demasiadas.cuerpo.details, { eventoId: String(chico._id), cupoDisponible: 2, solicitado: 3 });
  assert.equal(await cupoDe(chico), 2);
});

test('titularidad: un cliente no ve ni opera las compras de otro', async () => {
  const evento = await crearEvento();
  const deA = (await comprar(evento, 'compra-de-a-0001', { sub: CLIENTE_A })).cuerpo.compra;
  await comprar(evento, 'compra-de-b-0001', { sub: CLIENTE_B });

  for (const [metodo, ruta] of [['GET', `/compras/${deA._id}`], ['POST', `/compras/${deA._id}/cancelar`], ['GET', `/compras/${deA._id}/entradas`]]) {
    const res = await api(metodo, ruta, { sub: CLIENTE_B });
    assert.equal(res.status, 404, `${metodo} ${ruta}`);
    assert.equal(res.cuerpo.code, 'PURCHASE_NOT_FOUND');
  }
  assert.equal((await Compra.findById(deA._id).lean()).estado, 'pendiente', 'B no pudo cancelarla');

  const lista = await api('GET', '/compras', { sub: CLIENTE_A });
  assert.deepEqual(lista.cuerpo.map((c) => c._id), [deA._id]);
});

test('listar: más nuevas primero y filtros por evento y estado', async () => {
  const uno = await crearEvento();
  const otro = await crearEvento();
  const primera = (await comprar(uno, 'listado-0000001')).cuerpo.compra;
  const segunda = (await comprar(otro, 'listado-0000002')).cuerpo.compra;
  await Compra.updateOne({ _id: primera._id }, { $set: { estado: 'pagada' } });

  assert.deepEqual((await api('GET', '/compras')).cuerpo.map((c) => c._id), [segunda._id, primera._id]);
  assert.deepEqual((await api('GET', `/compras?eventoId=${uno._id}`)).cuerpo.map((c) => c._id), [primera._id]);
  assert.deepEqual((await api('GET', '/compras?estado=pagada')).cuerpo.map((c) => c._id), [primera._id]);
});

test('cancelar: libera el cupo una sola vez y repetirla devuelve la compra cancelada', async () => {
  const evento = await crearEvento();
  const { _id } = (await comprar(evento, 'cancelar-0000001', { datos: { cantidad: 4 } })).cuerpo.compra;
  assert.equal(await cupoDe(evento), 6);

  const primera = await api('POST', `/compras/${_id}/cancelar`);
  assert.deepEqual([primera.status, primera.cuerpo.estado], [200, 'cancelada']);
  assert.equal(await cupoDe(evento), 10);

  const repetida = await api('POST', `/compras/${_id}/cancelar`);
  assert.deepEqual([repetida.status, repetida.cuerpo.estado], [200, 'cancelada']);
  assert.equal(await cupoDe(evento), 10, 'no se libera dos veces');
});

test('cancelar: 10 cancelaciones simultáneas liberan el cupo una sola vez', async () => {
  const evento = await crearEvento();
  const { _id } = (await comprar(evento, 'cancelar-paralelo-1', { datos: { cantidad: 3 } })).cuerpo.compra;
  const respuestas = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/compras/${_id}/cancelar`)));
  assert.ok(respuestas.every((r) => r.status === 200 && r.cuerpo.estado === 'cancelada'));
  assert.equal(await cupoDe(evento), 10);
});

test('cancelar: una compra que ya inició el pago responde 409 PURCHASE_INVALID_STATE', async () => {
  const evento = await crearEvento();
  const { _id } = (await comprar(evento, 'cancelar-con-pago-1')).cuerpo.compra;
  await Compra.updateOne({ _id }, { $set: { estado: 'pago_pendiente' } });
  const res = await api('POST', `/compras/${_id}/cancelar`);
  assert.equal(res.status, 409);
  assert.equal(res.cuerpo.code, 'PURCHASE_INVALID_STATE');
  assert.deepEqual(res.cuerpo.details, { estado: 'pago_pendiente' });
  assert.equal(await cupoDe(evento), 9);
});

test('asistente: el directorio guarda los últimos datos y cada compra conserva su copia', async () => {
  const evento = await crearEvento();
  const primera = (await comprar(evento, 'snapshot-0000001')).cuerpo.compra;
  const nuevosDatos = { nombre: 'Ana P. de López', email: 'ana.lopez@example.com', documento: ANA.documento };
  const segunda = (await comprar(evento, 'snapshot-0000002', { datos: { asistente: nuevosDatos } })).cuerpo.compra;

  assert.equal(segunda.asistenteId, primera.asistenteId, 'mismo DNI, mismo asistente');
  assert.equal(await Asistente.countDocuments({}), 1);
  assert.equal((await Asistente.findOne({ documento: ANA.documento }).lean()).email, 'ana.lopez@example.com');
  assert.deepEqual((await api('GET', `/compras/${primera._id}`)).cuerpo.asistente, ANA, 'la primera compra no cambia');
});

test('entradas: vacío hasta que el worker emite, después las entradas por número', async () => {
  const evento = await crearEvento();
  const compra = (await comprar(evento, 'entradas-0000001')).cuerpo.compra;
  assert.deepEqual((await api('GET', `/compras/${compra._id}/entradas`)).cuerpo, []);

  await Entrada.collection.insertMany([
    { codigo: 'ENT-BBBBBBBBBBBB', compraId: new mongoose.Types.ObjectId(compra._id), eventoId: evento._id, numero: 2, estado: 'emitida', __v: 0 },
    { codigo: 'ENT-AAAAAAAAAAAA', compraId: new mongoose.Types.ObjectId(compra._id), eventoId: evento._id, numero: 1, estado: 'emitida', __v: 0 }
  ]);
  const entradas = (await api('GET', `/compras/${compra._id}/entradas`)).cuerpo;
  assert.deepEqual(entradas.map((e) => e.numero), [1, 2]);
  assert.equal('__v' in entradas[0], false);
});

test('compensación: si falla el alta de la compra, el cupo vuelve al evento', async () => {
  const evento = await crearEvento();
  const CompraRota = { findOne: (...args) => Compra.findOne(...args), create: async () => { throw new Error('falla simulada'); } };
  await assert.rejects(
    comprasService.reservar(pedido(evento, { cantidad: 4 }), { clave: 'compensacion-0001', cliente: CLIENTE_A }, { Compra: CompraRota }),
    /falla simulada/
  );
  assert.equal(await cupoDe(evento), 10);
});
