const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');

// El flujo asincrónico de punta a punta con un RabbitMQ y un MongoDB reales:
// compra pagada → relay del outbox → broker → consumidor → entradas emitidas, más los caminos de
// retry y DLQ. Se omite sin MONGODB_URI_TEST y RABBIT_URL_TEST, por ejemplo:
//   docker compose up -d mongodb rabbitmq
//   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/iaew_eventos_test \
//   RABBIT_URL_TEST=amqp://iaew:iaew-local@127.0.0.1:5672 npm test
// ATENCIÓN: la prueba vacía las colas de entrada.comprada (principal, retry y DLQ) del broker
// indicado: usar uno de pruebas.
const MONGO = configuracionMongo('worker');
const RABBIT_URL = process.env.RABBIT_URL_TEST;
if (!MONGO || !RABBIT_URL) {
  test('flujo asincrónico con RabbitMQ y MongoDB (definir MONGODB_URI_TEST y RABBIT_URL_TEST para correrlo)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');

const RETRY_DELAY_MS = 150;
const MAX_RETRIES = 3;
const CLIENTE = 'canal@clients';

let emisor;
let server;
let base;
let Evento;
let Compra;
let Entrada;
let EventoProcesado;
let rabbit;
let outbox;
let emision;
let consumidor;
let procesarActual;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  process.env.RABBIT_URL = RABBIT_URL;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Entrada = require('../src/models/Entrada');
  EventoProcesado = require('../src/models/EventoProcesado');
  rabbit = require('../src/lib/rabbit');
  outbox = require('../src/lib/outbox');
  emision = require('../src/services/emision');
  const { crearManejador } = require('../src/lib/consumidor');
  await Promise.all([Compra.createIndexes(), Entrada.createIndexes(), EventoProcesado.createIndexes()]);

  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // El mismo manejador que usa el worker; `procesarActual` permite inyectar fallos por prueba.
  procesarActual = (evento) => emision.emitirEntradasDeCompra(evento);
  const manejar = crearManejador({
    procesar: (evento) => procesarActual(evento),
    maxRetries: MAX_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
    log: { log: () => {}, warn: () => {}, error: () => {} },
    alFallarEnrutamiento: (error) => { throw error; }
  });
  consumidor = await rabbit.consumirEntradaComprada((canal, msg) => { manejar(canal, msg); });
});

after(async () => {
  await consumidor?.detener().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await rabbit.closeRabbit();
  await mongoose.disconnect();
  await emisor.close();
});

beforeEach(async () => {
  procesarActual = (evento) => emision.emitirEntradasDeCompra(evento);
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Entrada.deleteMany({}), EventoProcesado.deleteMany({})]);
  const canal = await rabbit.getChannel();
  for (const cola of [rabbit.QUEUE, rabbit.RETRY_QUEUE, rabbit.DLQ]) await canal.purgeQueue(cola);
});

const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
const crearEvento = (extra = {}) => Evento.create({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad: 10, cupoDisponible: 10, precio: 25000, estado: 'publicado', ...extra });

// Una compra pagada con el sobre en el outbox, tal como la deja el webhook.
async function compraPagada(evento, { cantidad = 2 } = {}) {
  const _id = new mongoose.Types.ObjectId();
  const sobre = { eventId: crypto.randomUUID(), type: 'entrada.comprada', version: 1, occurredAt: new Date().toISOString(), correlationId: `corr-${_id}`, data: { compraId: String(_id) } };
  await Compra.collection.insertOne({
    _id, eventoId: evento._id, asistenteId: new mongoose.Types.ObjectId(), creadaPor: CLIENTE, cantidad, estado: 'pagada',
    asistente: { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' },
    emisionEvento: sobre, emisionEstado: 'pendiente', createdAt: new Date(), updatedAt: new Date()
  });
  return { _id, sobre };
}

async function esperar(condicion, { intentos = 100, cadaMs = 50 } = {}) {
  for (let i = 0; i < intentos; i += 1) {
    const valor = await condicion();
    if (valor) return valor;
    await new Promise((resolve) => setTimeout(resolve, cadaMs));
  }
  throw new Error('la condición no se cumplió a tiempo');
}

// Lee un mensaje de la DLQ (la consola de RabbitMQ en la demo).
async function mensajeEnDlq() {
  const canal = await rabbit.getChannel();
  return esperar(async () => (await canal.get(rabbit.DLQ, { noAck: true })) || null);
}

async function publicarCrudo(contenido, messageId = crypto.randomUUID()) {
  const canal = await rabbit.getChannel();
  canal.publish(rabbit.EXCHANGE, rabbit.ROUTING_KEY, Buffer.from(contenido), { persistent: true, contentType: 'application/json', messageId, headers: { 'x-retry-count': 0 } });
  await canal.waitForConfirms();
}

const entradasDe = (compra) => Entrada.find({ compraId: compra._id }).sort({ numero: 1 }).lean();
const emitida = (compra) => async () => (await Compra.findById(compra._id).lean()).emisionEstado === 'emitida';

test('de punta a punta: el relay del outbox publica, el consumidor emite las entradas y la API las muestra', async () => {
  const compra = await compraPagada(await crearEvento(), { cantidad: 3 });

  assert.equal(await outbox.publicarPendientes(), 1, 'el relay publica el evento pendiente');
  assert.ok((await Compra.findById(compra._id).lean()).emisionPublicadaEn, 'y lo marca como publicado');

  await esperar(emitida(compra));
  const entradas = await entradasDe(compra);
  assert.equal(entradas.length, 3);
  assert.ok(entradas.every((e) => e.estado === 'emitida' && /^ENT-[A-Z0-9]{12}$/.test(e.codigo)));

  const res = await fetch(`${base}/compras/${compra._id}/entradas`, { headers: { Authorization: `Bearer ${emisor.token({ scope: 'buy:entradas', sub: CLIENTE })}` } });
  assert.equal((await res.json()).length, 3, 'GET /compras/{id}/entradas pasó de [] a 3');

  const canal = await rabbit.getChannel();
  assert.equal((await canal.checkQueue(rabbit.DLQ)).messageCount, 0);
  assert.equal((await canal.checkQueue(rabbit.QUEUE)).messageCount, 0, 'la cola quedó vacía: todo se confirmó');
});

test('un mensaje publicado dos veces (relay republicó) emite las entradas una sola vez', async () => {
  const compra = await compraPagada(await crearEvento());
  await rabbit.publishEntradaComprada(compra.sobre);
  await rabbit.publishEntradaComprada(compra.sobre);

  await esperar(emitida(compra));
  await esperar(async () => (await (await rabbit.getChannel()).checkQueue(rabbit.QUEUE)).messageCount === 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 2);
  assert.equal(await EventoProcesado.countDocuments({ eventId: compra.sobre.eventId }), 1);
});

test('un fallo transitorio pasa por la cola de retry y se completa al reintentar', async () => {
  const compra = await compraPagada(await crearEvento());
  const momentos = [];
  procesarActual = async (evento) => {
    momentos.push(Date.now());
    if (momentos.length <= 2) throw new Error('mongo caído (simulado)');
    return emision.emitirEntradasDeCompra(evento);
  };
  await rabbit.publishEntradaComprada(compra.sobre);

  await esperar(emitida(compra));
  assert.equal(momentos.length, 3, 'dos fallos y un éxito');
  assert.ok(momentos[1] - momentos[0] >= RETRY_DELAY_MS * 0.8, `esperó ${momentos[1] - momentos[0]} ms antes del reintento`);
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 2);
  assert.equal((await (await rabbit.getChannel()).checkQueue(rabbit.DLQ)).messageCount, 0);
});

test('agotados los reintentos, el mensaje queda en la DLQ con su motivo y el contador', async () => {
  const compra = await compraPagada(await crearEvento());
  let intentos = 0;
  procesarActual = async () => { intentos += 1; throw new Error('falla persistente (simulada)'); };
  await rabbit.publishEntradaComprada(compra.sobre);

  const enDlq = await mensajeEnDlq();
  assert.equal(intentos, MAX_RETRIES + 1, 'el intento original y MAX_RETRIES reintentos');
  assert.equal(enDlq.properties.headers['x-dlq-reason'], 'max_retries_exceeded');
  assert.equal(enDlq.properties.headers['x-retry-count'], MAX_RETRIES);
  assert.match(enDlq.properties.headers['x-last-error'], /falla persistente/);
  assert.equal(JSON.parse(enDlq.content).eventId, compra.sobre.eventId, 'el mensaje original se conserva');
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 0);
});

test('un mensaje que no es JSON o no cumple el contrato va directo a la DLQ', async () => {
  await publicarCrudo('{esto no es json');
  assert.equal((await mensajeEnDlq()).properties.headers['x-dlq-reason'], 'invalid_json');

  await publicarCrudo(JSON.stringify({ eventId: 'no-uuid', type: 'entrada.comprada' }));
  assert.equal((await mensajeEnDlq()).properties.headers['x-dlq-reason'], 'contract_invalid');
});

test('una compra inexistente es un error permanente: a la DLQ sin reintentos', async () => {
  let intentos = 0;
  procesarActual = async (evento) => { intentos += 1; return emision.emitirEntradasDeCompra(evento); };
  const sobre = { eventId: crypto.randomUUID(), type: 'entrada.comprada', version: 1, occurredAt: new Date().toISOString(), correlationId: 'c', data: { compraId: String(new mongoose.Types.ObjectId()) } };
  await rabbit.publishEntradaComprada(sobre);

  const enDlq = await mensajeEnDlq();
  assert.equal(enDlq.properties.headers['x-dlq-reason'], 'compra_not_found');
  assert.equal(intentos, 1, 'no se reintentó');
});

test('con RabbitMQ no disponible para el relay, la compra queda pendiente y se publica al volver', async () => {
  const compra = await compraPagada(await crearEvento());
  const fallo = async () => { throw new Error('broker caído (simulado)'); };
  await assert.rejects(outbox.publicarPendientes({ publish: fallo }), /broker caído/);
  const pendiente = await Compra.findById(compra._id).lean();
  assert.equal(pendiente.emisionPublicadaEn, undefined, 'sigue pendiente de publicar');
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 0);

  assert.equal(await outbox.publicarPendientes(), 1);
  await esperar(emitida(compra));
});
