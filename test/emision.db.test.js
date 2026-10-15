const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');

// Emisión de entradas contra MongoDB real: la idempotencia depende de los índices únicos y de
// los upserts, que no se pueden comprobar con dobles. Se omite sin MONGODB_URI_TEST.
const MONGO = configuracionMongo('emision');
if (!MONGO) {
  test('integración de la emisión de entradas con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');

let emisor;
let server;
let base;
let Evento;
let Compra;
let Entrada;
let EventoProcesado;
let emision;
let ErrorPermanente;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Entrada = require('../src/models/Entrada');
  EventoProcesado = require('../src/models/EventoProcesado');
  emision = require('../src/services/emision');
  ({ ErrorPermanente } = require('../src/lib/consumidor'));
  await Promise.all([Compra.createIndexes(), Entrada.createIndexes(), EventoProcesado.createIndexes()]);
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
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Entrada.deleteMany({}), EventoProcesado.deleteMany({})]);
});

const CLIENTE = 'canal@clients';
const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
const crearEvento = (extra = {}) => Evento.create({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad: 10, cupoDisponible: 10, precio: 25000, estado: 'publicado', ...extra });

// Una compra ya pagada, con el sobre que dejó el webhook en el outbox.
async function compraPagada(evento, { cantidad = 3, estado = 'pagada' } = {}) {
  const _id = new mongoose.Types.ObjectId();
  const sobre = { eventId: crypto.randomUUID(), type: 'entrada.comprada', version: 1, occurredAt: new Date().toISOString(), correlationId: 'corr-1', data: { compraId: String(_id) } };
  await Compra.collection.insertOne({
    _id, eventoId: evento._id, asistenteId: new mongoose.Types.ObjectId(), creadaPor: CLIENTE, cantidad, estado,
    asistente: { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' },
    emisionEvento: sobre, emisionEstado: 'pendiente', createdAt: new Date(), updatedAt: new Date()
  });
  return { compra: { _id }, sobre };
}

const entradasDe = (compra) => Entrada.find({ compraId: compra._id }).sort({ numero: 1 }).lean();

async function api(ruta) {
  const res = await fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${emisor.token({ scope: 'buy:entradas', sub: CLIENTE })}` } });
  return { status: res.status, cuerpo: await res.json() };
}

test('emite una entrada por unidad, con código único y titular sin email, y la compra queda emitida', async () => {
  const { compra, sobre } = await compraPagada(await crearEvento());
  assert.deepEqual((await api(`/compras/${compra._id}/entradas`)).cuerpo, [], 'vacío antes de procesar');

  assert.deepEqual(await emision.emitirEntradasDeCompra(sobre), { resultado: 'emitidas', cantidad: 3 });

  const entradas = await entradasDe(compra);
  assert.deepEqual(entradas.map((e) => e.numero), [1, 2, 3]);
  assert.equal(new Set(entradas.map((e) => e.codigo)).size, 3);
  assert.ok(entradas.every((e) => /^ENT-[A-Z0-9]{12}$/.test(e.codigo) && e.estado === 'emitida'));
  assert.deepEqual(entradas[0].titular, { nombre: 'Ana Pérez', documento: '40123456' });
  assert.equal('email' in entradas[0].titular, false);

  const guardada = await Compra.findById(compra._id).lean();
  assert.equal(guardada.emisionEstado, 'emitida');
  assert.ok(guardada.emitidaEn);
  assert.equal(await EventoProcesado.countDocuments({ eventId: sobre.eventId }), 1);

  // El efecto visible del flujo asincrónico: GET /compras/{id}/entradas pasa de [] a N.
  const visibles = await api(`/compras/${compra._id}/entradas`);
  assert.equal(visibles.cuerpo.length, 3);
  assert.equal((await api(`/compras/${compra._id}`)).cuerpo.emisionEstado, 'emitida');
});

test('el mismo mensaje entregado dos veces no duplica entradas', async () => {
  const { compra, sobre } = await compraPagada(await crearEvento());
  await emision.emitirEntradasDeCompra(sobre);
  const codigos = (await entradasDe(compra)).map((e) => e.codigo);

  assert.deepEqual(await emision.emitirEntradasDeCompra(sobre), { resultado: 'duplicado' });
  assert.deepEqual((await entradasDe(compra)).map((e) => e.codigo), codigos);
});

test('la segunda barrera: otro eventId de la misma compra tampoco duplica ni cambia los códigos', async () => {
  const { compra, sobre } = await compraPagada(await crearEvento());
  await emision.emitirEntradasDeCompra(sobre);
  const codigos = (await entradasDe(compra)).map((e) => e.codigo);

  const otro = { ...sobre, eventId: crypto.randomUUID() };
  assert.deepEqual(await emision.emitirEntradasDeCompra(otro), { resultado: 'emitidas', cantidad: 3 });
  assert.deepEqual((await entradasDe(compra)).map((e) => e.codigo), codigos, 'las entradas ya emitidas no cambian');
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 3);
});

test('8 entregas simultáneas del mismo mensaje emiten exactamente N entradas', async () => {
  const { compra, sobre } = await compraPagada(await crearEvento(), { cantidad: 5 });
  const resultados = await Promise.all(Array.from({ length: 8 }, () => emision.emitirEntradasDeCompra(sobre)));

  assert.ok(resultados.every((r) => ['emitidas', 'duplicado'].includes(r.resultado)));
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 5);
  assert.equal(new Set((await entradasDe(compra)).map((e) => e.numero)).size, 5);
  assert.equal(await EventoProcesado.countDocuments({ eventId: sobre.eventId }), 1);
});

test('si el evento está cancelado, las entradas se emiten ya anuladas', async () => {
  const { compra, sobre } = await compraPagada(await crearEvento({ estado: 'cancelado' }), { cantidad: 2 });
  await emision.emitirEntradasDeCompra(sobre);
  assert.deepEqual((await entradasDe(compra)).map((e) => e.estado), ['anulada', 'anulada']);
  assert.equal((await Compra.findById(compra._id).lean()).emisionEstado, 'emitida', 'la emisión terminó');
});

test('una compra inexistente o no pagada es un error permanente y no emite nada', async () => {
  const evento = await crearEvento();
  const inexistente = { eventId: crypto.randomUUID(), type: 'entrada.comprada', version: 1, occurredAt: new Date().toISOString(), correlationId: 'c', data: { compraId: String(new mongoose.Types.ObjectId()) } };
  await assert.rejects(emision.emitirEntradasDeCompra(inexistente), (error) => error instanceof ErrorPermanente && error.razon === 'compra_not_found');

  const { compra, sobre } = await compraPagada(evento, { estado: 'pago_pendiente' });
  await assert.rejects(emision.emitirEntradasDeCompra(sobre), (error) => error instanceof ErrorPermanente && error.razon === 'compra_not_paid');
  assert.equal(await Entrada.countDocuments({ compraId: compra._id }), 0);
  assert.equal(await EventoProcesado.countDocuments({}), 0, 'un mensaje fallido no se marca como procesado');
});

test('cancelar el evento después de emitir anula las entradas (cascada) y la deja procesada', async () => {
  const evento = await crearEvento();
  const { compra, sobre } = await compraPagada(evento);
  await emision.emitirEntradasDeCompra(sobre);
  await Compra.updateOne({ _id: compra._id }, { $set: { emisionPublicadaEn: new Date() } });

  const eventos = require('../src/services/eventos');
  await Evento.updateOne({ _id: evento._id }, { $set: { estado: 'cancelado' } });
  assert.equal(await eventos.cancelarEventoCascada(evento._id), true, 'sin emisiones pendientes, la cascada termina');
  assert.deepEqual((await entradasDe(compra)).map((e) => e.estado), ['anulada', 'anulada', 'anulada']);
  assert.equal((await Compra.findById(compra._id).lean()).reembolsoPendiente, true);
});
