const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');
const { crearServidor, configuracion } = require('../services/pagos-mock/server');
const { firmar } = require('../src/lib/firma');

// Integración del webhook de pago de punta a punta: pagos-mock real → POST /webhooks/pagos →
// MongoDB, y también notificaciones firmadas a mano para los casos de borde.
// Se omite sin MONGODB_URI_TEST (ver helpers/mongo.js).
const MONGO = configuracionMongo('webhooks');
if (!MONGO) {
  test('integración del webhook de pago con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');
const SECRETO = 'secreto-de-prueba';

let emisor;
let server;
let base;
let pasarela;
let Evento;
let Compra;
let Asistente;
let outbox;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  process.env.WEBHOOK_SECRET = SECRETO;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Asistente = require('../src/models/Asistente');
  outbox = require('../src/lib/outbox');
  await Promise.all([Compra.createIndexes(), Asistente.createIndexes()]);
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (pasarela) await new Promise((resolve) => pasarela.close(resolve));
  await mongoose.disconnect();
  await emisor.close();
});

// La pasarela notifica a esta misma api. Con `webhook: false` solo resuelve el pago (webhook "perdido")
// y las pruebas envían la notificación a mano.
async function levantarPasarela({ webhook = true } = {}) {
  if (pasarela) await new Promise((resolve) => pasarela.close(resolve));
  pasarela = crearServidor(configuracion({
    PORT: '0', WEBHOOK_URL: `${base}/webhooks/pagos`, WEBHOOK_SECRET: SECRETO, PAGO_DEMORA_MS: '10',
    WEBHOOK_BACKOFF_MS: '20', WEBHOOK_HABILITADO: String(webhook)
  }), { log: () => {} });
  await new Promise((resolve) => pasarela.listen(0, '127.0.0.1', resolve));
  process.env.PAGOS_URL = `http://127.0.0.1:${pasarela.address().port}`;
}

beforeEach(async () => {
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Asistente.deleteMany({})]);
});

const CLIENTE = 'canal@clients';
const ANA = { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' };

async function api(metodo, ruta, { cuerpo, clave, cabeceras = {} } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${emisor.token({ scope: 'buy:entradas', sub: CLIENTE })}`,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...(clave ? { 'Idempotency-Key': clave } : {}),
      ...cabeceras
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const texto = await res.text();
  return { status: res.status, cuerpo: texto ? JSON.parse(texto) : null };
}

const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
const crearEvento = (extra = {}) => Evento.create({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad: 10, cupoDisponible: 10, precio: 25000, estado: 'publicado', ...extra });
const cupoDe = async (evento) => (await Evento.findById(evento._id).lean()).cupoDisponible;
const compraDe = (compra) => Compra.findById(compra._id).lean();

let contador = 0;
async function reservar(evento, cantidad = 2) {
  contador += 1;
  return (await api('POST', '/compras', { cuerpo: { eventoId: String(evento._id), cantidad, asistente: ANA }, clave: `reserva-${contador}-0000` })).cuerpo.compra;
}
async function iniciarPago(compra, { escenario = 'aprobado', correlationId } = {}) {
  contador += 1;
  return api('POST', `/compras/${compra._id}/pagar`, { cuerpo: { escenario }, clave: `pago-${contador}-00000`, cabeceras: correlationId ? { 'X-Correlation-Id': correlationId } : {} });
}

// Una compra en pago_pendiente, sin que la pasarela haya notificado nada.
async function enPagoPendiente(evento, cantidad = 2) {
  await levantarPasarela({ webhook: false });
  const compra = await reservar(evento, cantidad);
  assert.equal((await iniciarPago(compra)).status, 202);
  return compra;
}

function notificacion(compra, type = 'pago.aprobado', extra = {}) {
  return {
    notificacionId: crypto.randomUUID(), type, occurredAt: new Date().toISOString(),
    data: { compraId: String(compra._id), referenciaExterna: `PAY-${crypto.randomBytes(4).toString('hex')}`, monto: compra.total, ...extra }
  };
}

async function webhook(cuerpo, cabeceras = {}) {
  const texto = JSON.stringify(cuerpo);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${base}/webhooks/pagos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pago-Timestamp': timestamp, 'X-Pago-Firma': firmar(SECRETO, timestamp, texto), ...cabeceras },
    body: texto
  });
  return { status: res.status, cuerpo: await res.json() };
}

async function esperar(condicion, { intentos = 60, cadaMs = 50 } = {}) {
  for (let i = 0; i < intentos; i += 1) {
    const valor = await condicion();
    if (valor) return valor;
    await new Promise((resolve) => setTimeout(resolve, cadaMs));
  }
  throw new Error('la condición no se cumplió a tiempo');
}

test('de punta a punta: pagar → la pasarela notifica → la compra queda pagada con el evento en el outbox', async () => {
  await levantarPasarela();
  const evento = await crearEvento();
  const compra = await reservar(evento);
  const pago = await iniciarPago(compra, { correlationId: 'demo-e2e-0001' });
  assert.equal(pago.status, 202);

  const pagada = await esperar(async () => { const c = await compraDe(compra); return c.estado === 'pagada' ? c : null; });
  assert.deepEqual([pagada.pago.estado, pagada.pago.referenciaExterna], ['aprobado', pago.cuerpo.compra.pago.referenciaExterna]);
  assert.ok(pagada.pago.procesadoEn);
  assert.equal(pagada.emisionEstado, 'pendiente');
  assert.equal(pagada.emisionPublicadaEn, undefined, 'todavía no lo publicó el relay');
  assert.deepEqual(
    { type: pagada.emisionEvento.type, version: pagada.emisionEvento.version, compraId: pagada.emisionEvento.data.compraId, correlationId: pagada.emisionEvento.correlationId },
    { type: 'entrada.comprada', version: 1, compraId: String(compra._id), correlationId: 'demo-e2e-0001' },
    'el correlation id de /pagar llega al evento a través de la pasarela y el webhook'
  );
  assert.equal(await cupoDe(evento), 8, 'el cupo sigue descontado');

  const visible = (await api('GET', `/compras/${compra._id}`)).cuerpo;
  assert.equal(visible.estado, 'pagada');
  assert.equal('emisionEvento' in visible, false, 'el outbox no se expone');

  // El relay existente encuentra y publica ese evento.
  const publicados = [];
  assert.equal(await outbox.publicarPendientes({ publish: async (evento) => publicados.push(evento) }), 1);
  assert.equal(publicados[0].eventId, pagada.emisionEvento.eventId);
  assert.ok((await compraDe(compra)).emisionPublicadaEn);
});

test('de punta a punta: el pago rechazado deja la compra rechazada y libera el cupo', async () => {
  await levantarPasarela();
  const evento = await crearEvento();
  const compra = await reservar(evento, 3);
  assert.equal(await cupoDe(evento), 7);
  await iniciarPago(compra, { escenario: 'rechazado' });

  const rechazada = await esperar(async () => { const c = await compraDe(compra); return c.estado === 'rechazada' ? c : null; });
  assert.deepEqual([rechazada.pago.estado, rechazada.pago.motivoRechazo], ['rechazado', 'fondos_insuficientes']);
  assert.equal(rechazada.emisionEvento, undefined, 'un pago rechazado no genera evento');
  assert.equal(await cupoDe(evento), 10);
});

test('una notificación repetida responde 200 con duplicado:true y no cambia nada', async () => {
  const evento = await crearEvento();
  const compra = await enPagoPendiente(evento);
  const aviso = notificacion(compra);

  const primera = await webhook(aviso);
  assert.deepEqual(primera, { status: 200, cuerpo: { recibido: true, duplicado: false, compraId: String(compra._id), estadoCompra: 'pagada' } });
  const eventId = (await compraDe(compra)).emisionEvento.eventId;

  const repetida = await webhook(aviso);
  assert.deepEqual([repetida.status, repetida.cuerpo.duplicado, repetida.cuerpo.estadoCompra], [200, true, 'pagada']);
  assert.equal((await compraDe(compra)).emisionEvento.eventId, eventId, 'no se genera otro evento');
});

test('10 notificaciones simultáneas de la misma compra registran un solo pago y un solo evento', async () => {
  const evento = await crearEvento();
  const compra = await enPagoPendiente(evento);
  const aviso = notificacion(compra);
  const respuestas = await Promise.all(Array.from({ length: 10 }, () => webhook(aviso)));

  assert.ok(respuestas.every((r) => r.status === 200), respuestas.map((r) => r.status).join());
  assert.equal(respuestas.filter((r) => !r.cuerpo.duplicado).length, 1);
  const pagada = await compraDe(compra);
  assert.equal(pagada.estado, 'pagada');
  assert.equal(await outbox.publicarPendientes({ publish: async () => {} }), 1, 'un único evento pendiente');
});

test('un rechazo sobre una compra ya pagada es 409 y no la toca (ni el cupo)', async () => {
  const evento = await crearEvento();
  const compra = await enPagoPendiente(evento);
  await webhook(notificacion(compra));
  const cupo = await cupoDe(evento);

  const contradictoria = await webhook(notificacion(compra, 'pago.rechazado', { motivo: 'fondos_insuficientes' }));
  assert.equal(contradictoria.status, 409);
  assert.equal(contradictoria.cuerpo.code, 'PURCHASE_INVALID_STATE');
  assert.deepEqual(contradictoria.cuerpo.details, { estado: 'pagada' });
  assert.equal((await compraDe(compra)).estado, 'pagada');
  assert.equal(await cupoDe(evento), cupo);
});

test('un rechazo repetido libera el cupo una sola vez', async () => {
  const evento = await crearEvento();
  const compra = await enPagoPendiente(evento, 3);
  const aviso = notificacion(compra, 'pago.rechazado', { motivo: 'fondos_insuficientes' });
  const respuestas = await Promise.all(Array.from({ length: 5 }, () => webhook(aviso)));
  assert.ok(respuestas.every((r) => r.status === 200));
  assert.equal(respuestas.filter((r) => !r.cuerpo.duplicado).length, 1);
  assert.equal(await cupoDe(evento), 10);
});

test('un pago aprobado tardío sobre una compra expirada es 409 y queda marcado para reembolso', async () => {
  await levantarPasarela({ webhook: false });
  const evento = await crearEvento();
  const compra = await reservar(evento);
  await Compra.updateOne({ _id: compra._id }, { $set: { reservaExpiraEn: new Date(Date.now() - 1000) } });
  assert.equal((await iniciarPago(compra)).cuerpo.code, 'RESERVATION_EXPIRED');
  assert.equal(await cupoDe(evento), 10);

  const consola = console.error;
  console.error = () => {};
  try {
    const tardio = await webhook(notificacion(compra));
    assert.equal(tardio.status, 409);
    assert.equal(tardio.cuerpo.code, 'PURCHASE_INVALID_STATE');
  } finally {
    console.error = consola;
  }
  const expirada = await compraDe(compra);
  assert.deepEqual([expirada.estado, expirada.reembolsoPendiente], ['expirada', true]);
  assert.equal(await cupoDe(evento), 10, 'el cupo ya estaba liberado y no cambia');
});

test('un pago aprobado sobre un evento cancelado deja la compra pagada con reembolsoPendiente', async () => {
  const evento = await crearEvento();
  const compra = await enPagoPendiente(evento);
  await Evento.updateOne({ _id: evento._id }, { $set: { estado: 'cancelado' } });

  const res = await webhook(notificacion(compra));
  assert.equal(res.status, 200);
  const pagada = await compraDe(compra);
  assert.deepEqual([pagada.estado, pagada.reembolsoPendiente], ['pagada', true]);
});

test('si el webhook llega antes de que /pagar guarde la referencia, se procesa y guarda la suya', async () => {
  const evento = await crearEvento();
  const compra = await reservar(evento);
  // Estado intermedio de /pagar: pago_pendiente persistido, referencia todavía sin guardar.
  await Compra.updateOne({ _id: compra._id }, { $set: { estado: 'pago_pendiente', pago: { estado: 'pendiente', idempotencyKey: 'pago-adelantado-1', solicitadoEn: new Date() }, pagoExpiraEn: enDias(1) } });

  const aviso = notificacion(compra, 'pago.aprobado', { referenciaExterna: 'PAY-adelantado' });
  assert.equal((await webhook(aviso)).status, 200);
  const pagada = await compraDe(compra);
  assert.deepEqual([pagada.estado, pagada.pago.referenciaExterna], ['pagada', 'PAY-adelantado']);

  // Cuando /pagar termina de guardar la referencia que le dio la pasarela, no pisa la del webhook.
  await Compra.updateOne({ _id: compra._id, 'pago.referenciaExterna': { $exists: false } }, { $set: { 'pago.referenciaExterna': 'PAY-otra' } });
  assert.equal((await compraDe(compra)).pago.referenciaExterna, 'PAY-adelantado');
});

test('una notificación de una compra inexistente es 404 y una de una compra sin pago iniciado es 409', async () => {
  const inexistente = await webhook({ ...notificacion({ _id: '6702a1b2c3d4e5f6012345ff', total: 1 }) });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.cuerpo.code, 'PURCHASE_NOT_FOUND');

  const evento = await crearEvento();
  const compra = await reservar(evento);
  const sinPago = await webhook(notificacion(compra));
  assert.equal(sinPago.status, 409);
  assert.deepEqual(sinPago.cuerpo.details, { estado: 'pendiente' });
  const intacta = await compraDe(compra);
  assert.deepEqual([intacta.estado, intacta.reembolsoPendiente], ['pendiente', false]);
});
