const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');

// Integración contra MongoDB real: las garantías de atomicidad (updates condicionales) no se
// pueden comprobar con dobles. Se omite sin MONGODB_URI_TEST (ver helpers/mongo.js).
const MONGO = configuracionMongo('eventos');
if (!MONGO) {
  test('integración de eventos con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');

let emisor;
let server;
let base;
let Evento;
let Compra;
let Entrada;
let eventosService;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Entrada = require('../src/models/Entrada');
  eventosService = require('../src/services/eventos');
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
  await Promise.all([Evento.deleteMany({}), Compra.deleteMany({}), Entrada.deleteMany({})]);
});

const SCOPES = 'read:eventos write:eventos admin:eventos';
async function api(metodo, ruta, cuerpo) {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${emisor.token({ scope: SCOPES })}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const texto = await res.text();
  return { status: res.status, cuerpo: texto ? JSON.parse(texto) : null, cabeceras: res.headers };
}

const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
const datosEvento = (extra = {}) => ({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad: 10, precio: 100, ...extra });
const crear = async (extra) => (await api('POST', '/eventos', datosEvento(extra))).cuerpo;

test('CRUD: crear, leer, listar con filtro y orden, y eliminar', async () => {
  const creado = await api('POST', '/eventos', datosEvento({ nombre: 'Tarde', fecha: enDias(40) }));
  assert.equal(creado.status, 201);
  assert.equal(creado.cuerpo.estado, 'borrador');
  assert.equal(creado.cuerpo.cupoDisponible, 10);
  assert.equal(creado.cabeceras.get('location'), `/eventos/${creado.cuerpo._id}`);
  assert.equal('__v' in creado.cuerpo, false);

  await crear({ nombre: 'Temprano', fecha: enDias(10), estado: 'publicado' });

  const todos = await api('GET', '/eventos');
  assert.deepEqual(todos.cuerpo.map((e) => e.nombre), ['Temprano', 'Tarde'], 'ordenados por fecha ascendente');
  assert.deepEqual((await api('GET', '/eventos?estado=publicado')).cuerpo.map((e) => e.nombre), ['Temprano']);

  assert.equal((await api('GET', `/eventos/${creado.cuerpo._id}`)).cuerpo.nombre, 'Tarde');
  assert.equal((await api('GET', '/eventos/66f0000000000000000000ff')).cuerpo.code, 'EVENT_NOT_FOUND');

  assert.equal((await api('DELETE', `/eventos/${creado.cuerpo._id}`)).status, 204);
  assert.equal((await api('DELETE', `/eventos/${creado.cuerpo._id}`)).status, 404);
});

test('PATCH: publicar, finalizar y las transiciones inválidas', async () => {
  const { _id } = await crear();
  assert.equal((await api('PATCH', `/eventos/${_id}`, { estado: 'publicado' })).cuerpo.estado, 'publicado');
  const invalida = await api('PATCH', `/eventos/${_id}`, { estado: 'borrador' });
  assert.equal(invalida.status, 409);
  assert.equal(invalida.cuerpo.code, 'INVALID_STATE_TRANSITION');
  assert.equal((await api('PATCH', `/eventos/${_id}`, { estado: 'finalizado' })).cuerpo.estado, 'finalizado');
  assert.equal((await api('PATCH', `/eventos/${_id}`, { nombre: 'Tarde' })).status, 409, 'un evento finalizado no se modifica');
});

test('PATCH de capacidad: mueve el cupo y respeta lo reservado', async () => {
  const { _id } = await crear({ estado: 'publicado' });
  await Evento.updateOne({ _id }, { $set: { cupoDisponible: 6 } }); // 4 reservadas

  const debajo = await api('PATCH', `/eventos/${_id}`, { capacidad: 3 });
  assert.equal(debajo.status, 409);
  assert.equal(debajo.cuerpo.code, 'CAPACITY_BELOW_SOLD');
  assert.deepEqual(debajo.cuerpo.details, { capacidad: 3, reservadasOVendidas: 4 });

  const justo = await api('PATCH', `/eventos/${_id}`, { capacidad: 4 });
  assert.deepEqual([justo.cuerpo.capacidad, justo.cuerpo.cupoDisponible], [4, 0]);
  const mas = await api('PATCH', `/eventos/${_id}`, { capacidad: 20 });
  assert.deepEqual([mas.cuerpo.capacidad, mas.cuerpo.cupoDisponible], [20, 16]);
});

test('PATCH concurrente de capacidad: el cupo y la capacidad se mantienen consistentes', async () => {
  const { _id } = await crear({ estado: 'publicado', capacidad: 50 });
  const respuestas = await Promise.all(Array.from({ length: 30 }, (_, i) => api('PATCH', `/eventos/${_id}`, { capacidad: 20 + i })));
  assert.ok(respuestas.every((r) => [200, 409].includes(r.status)), respuestas.map((r) => r.status).join());
  const final = await Evento.findById(_id).lean();
  assert.equal(final.cupoDisponible, final.capacidad, 'sin reservas, cupo = capacidad');
});

test('cancelar: corta la venta, aplica la cascada y es idempotente', async () => {
  const { _id } = await crear({ estado: 'publicado' });
  // Inserción directa en la colección: se arma el estado a mano, sin pasar por los validadores.
  const eventoId = new mongoose.Types.ObjectId(_id);
  const comun = { eventoId, creadaPor: 'canal@clients' };
  await Compra.collection.insertMany([
    { ...comun, estado: 'pendiente' },
    { ...comun, estado: 'pagada', emisionEstado: 'emitida' },
    { ...comun, estado: 'pago_pendiente' }
  ]);
  const [pendiente, pagada, pagoPendiente] = await Compra.find({ eventoId }).sort({ _id: 1 }).lean();
  await Entrada.collection.insertMany([
    { eventoId, compraId: pagada._id, numero: 1, estado: 'emitida' },
    { eventoId, compraId: pagada._id, numero: 2, estado: 'usada' }
  ]);

  const cancelado = await api('POST', `/eventos/${_id}/cancelar`);
  assert.equal(cancelado.status, 200);
  assert.equal(cancelado.cuerpo.estado, 'cancelado');
  assert.equal(cancelado.cuerpo.cancelacionProcesadaEn, undefined, 'queda un pago por resolverse');

  assert.equal((await Compra.findById(pendiente._id).lean()).estado, 'cancelada');
  const cobrada = await Compra.findById(pagada._id).lean();
  assert.deepEqual([cobrada.estado, cobrada.reembolsoPendiente], ['pagada', true]);
  assert.equal((await Compra.findById(pagoPendiente._id).lean()).estado, 'pago_pendiente', 'lo resuelve el webhook o la conciliación');
  assert.deepEqual((await Entrada.find({}).sort({ numero: 1 }).lean()).map((e) => e.estado), ['anulada', 'usada']);

  // La pasarela resuelve el pago: al retomar la cascada, el evento queda procesado.
  await Compra.updateOne({ _id: pagoPendiente._id }, { $set: { estado: 'rechazada' } });
  assert.equal(await eventosService.cancelarEventoCascada(_id), true);
  assert.ok((await Evento.findById(_id).lean()).cancelacionProcesadaEn);

  const otraVez = await api('POST', `/eventos/${_id}/cancelar`);
  assert.equal(otraVez.status, 200);
  assert.equal(otraVez.cuerpo.estado, 'cancelado');
});

test('cancelar desde borrador es 409 y un evento cancelado no se publica ni se modifica', async () => {
  const borrador = await crear();
  const res = await api('POST', `/eventos/${borrador._id}/cancelar`);
  assert.equal(res.status, 409);
  assert.equal(res.cuerpo.code, 'INVALID_STATE_TRANSITION');

  const publicado = await crear({ estado: 'publicado' });
  await api('POST', `/eventos/${publicado._id}/cancelar`);
  assert.equal((await api('PATCH', `/eventos/${publicado._id}`, { precio: 1 })).status, 409);
});

test('DELETE: un evento con compras responde 409 EVENT_HAS_SALES y uno con cupo reservado también', async () => {
  const conCompra = await crear({ estado: 'publicado' });
  await Compra.collection.insertOne({ eventoId: new mongoose.Types.ObjectId(conCompra._id), estado: 'cancelada', creadaPor: 'canal@clients' });
  const res = await api('DELETE', `/eventos/${conCompra._id}`);
  assert.equal(res.status, 409);
  assert.equal(res.cuerpo.code, 'EVENT_HAS_SALES');

  const reservado = await crear({ estado: 'publicado' });
  await Evento.updateOne({ _id: reservado._id }, { $inc: { cupoDisponible: -1 } }); // reserva sin compra todavía
  assert.equal((await api('DELETE', `/eventos/${reservado._id}`)).cuerpo.code, 'EVENT_HAS_SALES');
  assert.ok(await Evento.exists({ _id: reservado._id }));
});
