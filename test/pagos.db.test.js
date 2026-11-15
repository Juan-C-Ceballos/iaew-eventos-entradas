const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');
const { crearServidor, configuracion } = require('../services/pagos-mock/server');

// Integración de POST /compras/{id}/pagar contra MongoDB y la pasarela simulada reales.
// Se omite sin MONGODB_URI_TEST (ver helpers/mongo.js).
const MONGO = configuracionMongo('pagos');
if (!MONGO) {
  test('integración de pagos con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');

let emisor;
let server;
let base;
let pasarela;
let urlPasarela;
let Evento;
let Compra;
let Asistente;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Asistente = require('../src/models/Asistente');
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

// La pasarela se levanta sin webhook (el webhook es de la Fase 4): solo se prueba el pedido de cobro.
async function levantarPasarela() {
  pasarela = crearServidor(configuracion({ PORT: '0', WEBHOOK_HABILITADO: 'false', PAGO_DEMORA_MS: '10' }), { log: () => {} });
  await new Promise((resolve) => pasarela.listen(0, '127.0.0.1', resolve));
  urlPasarela = `http://127.0.0.1:${pasarela.address().port}`;
  process.env.PAGOS_URL = urlPasarela;
}

// Un puerto donde no escucha nadie: simula la pasarela caída.
function puertoLibre() {
  return new Promise((resolve) => {
    const servidor = net.createServer();
    servidor.listen(0, '127.0.0.1', () => { const { port } = servidor.address(); servidor.close(() => resolve(port)); });
  });
}

beforeEach(async () => {
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Asistente.deleteMany({})]);
  if (pasarela) await new Promise((resolve) => pasarela.close(resolve));
  await levantarPasarela();
});

const CLIENTE_A = 'canal-a@clients';
const CLIENTE_B = 'canal-b@clients';
const ANA = { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' };

async function api(metodo, ruta, { cuerpo, clave, sub = CLIENTE_A, cabeceras = {} } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${emisor.token({ scope: 'buy:entradas', sub })}`,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...(clave ? { 'Idempotency-Key': clave } : {}),
      ...cabeceras
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const texto = await res.text();
  return { status: res.status, cuerpo: texto ? JSON.parse(texto) : null, cabeceras: res.headers };
}

const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
const crearEvento = (extra = {}) => Evento.create({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad: 10, cupoDisponible: 10, precio: 25000, estado: 'publicado', ...extra });

let contador = 0;
async function reservar(evento, { sub = CLIENTE_A, cantidad = 2 } = {}) {
  contador += 1;
  const res = await api('POST', '/compras', { cuerpo: { eventoId: String(evento._id), cantidad, asistente: ANA }, clave: `reserva-${contador}-0000`, sub });
  return res.cuerpo.compra;
}
const pagar = (compra, clave, opciones = {}) => api('POST', `/compras/${compra._id}/pagar`, { clave, cuerpo: opciones.cuerpo ?? {}, sub: opciones.sub, cabeceras: opciones.cabeceras });
const consultarPasarela = async (compra) => {
  const res = await fetch(`${urlPasarela}/pagos?compraId=${compra._id}`);
  return res.status === 200 ? res.json() : null;
};

test('pagar: pasa la compra a pago_pendiente, fija el vencimiento y pide el cobro a la pasarela', async () => {
  const evento = await crearEvento();
  const compra = await reservar(evento);
  const res = await pagar(compra, 'pago:compra-1:v1', { cabeceras: { 'X-Correlation-Id': 'demo-pago-1' } });

  assert.equal(res.status, 202);
  assert.equal(res.cabeceras.get('idempotency-replayed'), 'false');
  assert.equal(res.cabeceras.get('x-correlation-id'), 'demo-pago-1');
  assert.deepEqual(res.cuerpo.idempotencia, { key: 'pago:compra-1:v1', replayed: false });
  const pagada = res.cuerpo.compra;
  assert.equal(pagada.estado, 'pago_pendiente');
  assert.equal(pagada.pago.estado, 'pendiente');
  assert.match(pagada.pago.referenciaExterna, /^PAY-[0-9a-f]{8}$/);
  assert.ok(pagada.pago.solicitadoEn);
  assert.equal('idempotencyKey' in pagada.pago, false, 'la clave del pago es interna');
  const minutos = (new Date(pagada.pagoExpiraEn) - Date.now()) / 60000;
  assert.ok(minutos > 29 && minutos <= 30, `pagoExpiraEn a ${minutos} minutos`);

  const enPasarela = await consultarPasarela(compra);
  assert.deepEqual([enPasarela.monto, enPasarela.referenciaExterna], [50000, pagada.pago.referenciaExterna]);
});

test('pagar: repetir con la misma clave devuelve el 202 original sin otro cobro', async () => {
  const compra = await reservar(await crearEvento());
  const primera = await pagar(compra, 'pago:compra-2:v1');
  const segunda = await pagar(compra, 'pago:compra-2:v1');
  assert.equal(segunda.status, 202);
  assert.equal(segunda.cabeceras.get('idempotency-replayed'), 'true');
  assert.equal(segunda.cuerpo.idempotencia.replayed, true);
  assert.equal(segunda.cuerpo.compra.pago.referenciaExterna, primera.cuerpo.compra.pago.referenciaExterna);
});

test('pagar: otra clave sobre una compra ya en pago_pendiente es 409 PURCHASE_INVALID_STATE', async () => {
  const compra = await reservar(await crearEvento());
  await pagar(compra, 'pago:compra-3:v1');
  const otra = await pagar(compra, 'pago:compra-3:v2');
  assert.equal(otra.status, 409);
  assert.equal(otra.cuerpo.code, 'PURCHASE_INVALID_STATE');
  assert.deepEqual(otra.cuerpo.details, { estado: 'pago_pendiente' });
});

test('pagar con la pasarela caída: 503, la compra sigue en pago_pendiente y reintentar con la misma clave completa el cobro', async () => {
  const compra = await reservar(await crearEvento());
  process.env.PAGOS_URL = `http://127.0.0.1:${await puertoLibre()}`;
  const fallido = await pagar(compra, 'pago:compra-4:v1');
  assert.equal(fallido.status, 503);
  assert.equal(fallido.cuerpo.code, 'PAYMENT_PROVIDER_UNAVAILABLE');
  assert.equal(fallido.cuerpo.retryable, true);

  const guardada = await Compra.findById(compra._id).lean();
  assert.equal(guardada.estado, 'pago_pendiente', 'no vuelve a pendiente: un timeout es ambiguo');
  assert.ok(guardada.pagoExpiraEn);
  assert.equal(guardada.pago.referenciaExterna, undefined);

  const otraClave = await pagar(compra, 'pago:compra-4:v2');
  assert.equal(otraClave.cuerpo.code, 'PURCHASE_INVALID_STATE');

  process.env.PAGOS_URL = urlPasarela;
  const reintento = await pagar(compra, 'pago:compra-4:v1');
  assert.equal(reintento.status, 202);
  assert.equal(reintento.cuerpo.idempotencia.replayed, true);
  assert.match(reintento.cuerpo.compra.pago.referenciaExterna, /^PAY-/);
});

test('pagar con la reserva vencida: 409 RESERVATION_EXPIRED, la compra expira y se libera el cupo', async () => {
  const evento = await crearEvento();
  const compra = await reservar(evento, { cantidad: 3 });
  assert.equal((await Evento.findById(evento._id).lean()).cupoDisponible, 7);
  await Compra.updateOne({ _id: compra._id }, { $set: { reservaExpiraEn: new Date(Date.now() - 1000) } });

  const res = await pagar(compra, 'pago:compra-5:v1');
  assert.equal(res.status, 409);
  assert.equal(res.cuerpo.code, 'RESERVATION_EXPIRED');
  assert.equal((await Compra.findById(compra._id).lean()).estado, 'expirada');
  assert.equal((await Evento.findById(evento._id).lean()).cupoDisponible, 10);
  assert.equal(await consultarPasarela(compra), null, 'no se pidió ningún cobro');

  const otraVez = await pagar(compra, 'pago:compra-5:v1');
  assert.equal(otraVez.cuerpo.code, 'PURCHASE_INVALID_STATE');
  assert.equal((await Evento.findById(evento._id).lean()).cupoDisponible, 10, 'no se libera dos veces');
});

test('pagar: una compra cancelada o ajena no se puede pagar', async () => {
  const compra = await reservar(await crearEvento());
  await api('POST', `/compras/${compra._id}/cancelar`);
  const cancelada = await pagar(compra, 'pago:compra-6:v1');
  assert.deepEqual([cancelada.status, cancelada.cuerpo.code], [409, 'PURCHASE_INVALID_STATE']);

  const otra = await reservar(await crearEvento());
  const ajena = await pagar(otra, 'pago:compra-6:v2', { sub: CLIENTE_B });
  assert.deepEqual([ajena.status, ajena.cuerpo.code], [404, 'PURCHASE_NOT_FOUND']);
  assert.equal((await Compra.findById(otra._id).lean()).estado, 'pendiente');
});

test('pagar: la misma clave en otra compra del mismo cliente es 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
  const evento = await crearEvento();
  const primera = await reservar(evento);
  const segunda = await reservar(evento);
  assert.equal((await pagar(primera, 'pago:clave-unica:v1')).status, 202);
  const repetida = await pagar(segunda, 'pago:clave-unica:v1');
  assert.deepEqual([repetida.status, repetida.cuerpo.code], [409, 'IDEMPOTENCY_KEY_MISMATCH']);
  assert.equal((await Compra.findById(segunda._id).lean()).estado, 'pendiente', 'la segunda sigue pendiente');
});

test('pagar: la clave es única por cliente, dos clientes pueden usar la misma', async () => {
  const evento = await crearEvento();
  const deA = await reservar(evento, { sub: CLIENTE_A });
  const deB = await reservar(evento, { sub: CLIENTE_B });
  assert.equal((await pagar(deA, 'pago:clave-compartida:v1', { sub: CLIENTE_A })).status, 202);
  assert.equal((await pagar(deB, 'pago:clave-compartida:v1', { sub: CLIENTE_B })).status, 202);
});

test('pagar: 10 solicitudes simultáneas con la misma clave inician un solo pago', async () => {
  const compra = await reservar(await crearEvento());
  const respuestas = await Promise.all(Array.from({ length: 10 }, () => pagar(compra, 'pago:compra-7:v1')));
  assert.ok(respuestas.every((r) => r.status === 202), respuestas.map((r) => `${r.status}:${r.cuerpo.code ?? ''}`).join());
  assert.equal(new Set(respuestas.map((r) => r.cuerpo.compra.pago.referenciaExterna)).size, 1, 'una sola referencia');
  assert.equal(respuestas.filter((r) => !r.cuerpo.idempotencia.replayed).length, 1, 'solo una hizo la transición');
});

test('pagar: 10 solicitudes simultáneas con claves distintas, solo una gana', async () => {
  const compra = await reservar(await crearEvento());
  const respuestas = await Promise.all(Array.from({ length: 10 }, (_, i) => pagar(compra, `pago:compra-8:v${i}`)));
  assert.equal(respuestas.filter((r) => r.status === 202).length, 1);
  assert.ok(respuestas.filter((r) => r.status !== 202).every((r) => r.status === 409 && r.cuerpo.code === 'PURCHASE_INVALID_STATE'));
});

test('pagar: el escenario rechazado llega a la pasarela', async () => {
  const compra = await reservar(await crearEvento());
  assert.equal((await pagar(compra, 'pago:compra-9:v1', { cuerpo: { escenario: 'rechazado' } })).status, 202);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await consultarPasarela(compra)).estado, 'rechazado');
});
