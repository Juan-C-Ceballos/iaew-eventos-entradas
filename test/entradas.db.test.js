const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { crearEmisor } = require('./helpers/emisor');
const { configuracionMongo } = require('./helpers/mongo');

// Control de acceso y reporte contra MongoDB real: que una entrada no entre dos veces solo se
// comprueba con validaciones concurrentes de verdad. Se omite sin MONGODB_URI_TEST.
const MONGO = configuracionMongo('entradas');
if (!MONGO) {
  test('integración del control de acceso y el reporte con MongoDB (definir MONGODB_URI_TEST para correrla)', { skip: true }, () => {});
  return;
}

const mongoose = require('mongoose');
const CLAVE = 'clave-interna-de-prueba';

let emisor;
let server;
let base;
let Evento;
let Compra;
let Entrada;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  process.env.INTERNAL_API_KEY = CLAVE;
  await mongoose.connect(MONGO.uri, { dbName: MONGO.dbName, autoIndex: false });
  Evento = require('../src/models/Evento');
  Compra = require('../src/models/Compra');
  Entrada = require('../src/models/Entrada');
  await Promise.all([Compra.createIndexes(), Entrada.createIndexes()]);
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

const enDias = (dias) => new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
const crearEvento = (extra = {}) => Evento.create({ nombre: 'Recital', fecha: enDias(30), lugar: 'Córdoba', capacidad: 10, cupoDisponible: 10, precio: 25000, estado: 'publicado', ...extra });

let contador = 0;
async function crearEntrada(evento, extra = {}) {
  contador += 1;
  const codigo = `ENT-${String(contador).padStart(12, '0').replace(/0/g, 'A')}`;
  await Entrada.collection.insertOne({
    codigo, compraId: new mongoose.Types.ObjectId(), eventoId: evento._id, asistenteId: new mongoose.Types.ObjectId(), numero: 1,
    titular: { nombre: 'Ana Pérez', documento: '40123456' }, estado: 'emitida', emitidaEn: new Date(), createdAt: new Date(), updatedAt: new Date(), ...extra
  });
  return codigo;
}

async function puerta(metodo, ruta, { cuerpo, sub = 'puerta-a@clients' } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${emisor.token({ scope: 'validate:entradas', sub })}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: res.status, cuerpo: await res.json() };
}
const validar = (codigo, evento, sub) => puerta('POST', `/entradas/${codigo}/validar`, { cuerpo: { eventoId: String(evento._id) }, sub });

test('GET /entradas/{codigo} devuelve la entrada con su titular y sin el email', async () => {
  const evento = await crearEvento();
  const codigo = await crearEntrada(evento);
  const res = await puerta('GET', `/entradas/${codigo}`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.cuerpo.codigo, res.cuerpo.estado, res.cuerpo.titular], [codigo, 'emitida', { nombre: 'Ana Pérez', documento: '40123456' }]);
  assert.equal('__v' in res.cuerpo, false);

  const inexistente = await puerta('GET', '/entradas/ENT-ZZZZZZZZZZZZ');
  assert.deepEqual([inexistente.status, inexistente.cuerpo.code], [404, 'TICKET_NOT_FOUND']);
});

test('validar: el acceso se permite una vez, queda usada y registra quién y cuándo', async () => {
  const evento = await crearEvento();
  const codigo = await crearEntrada(evento);

  const primera = await validar(codigo, evento, 'puerta-a@clients');
  assert.equal(primera.status, 200);
  assert.equal(primera.cuerpo.resultado, 'acceso_permitido');
  assert.deepEqual([primera.cuerpo.entrada.estado, primera.cuerpo.entrada.validadaPor], ['usada', 'puerta-a@clients']);
  assert.ok(primera.cuerpo.entrada.usadaEn);

  const reingreso = await validar(codigo, evento, 'puerta-b@clients');
  assert.deepEqual([reingreso.status, reingreso.cuerpo.code], [409, 'TICKET_ALREADY_USED']);
  assert.equal(reingreso.cuerpo.details.usadaEn, primera.cuerpo.entrada.usadaEn);
  assert.equal((await Entrada.findOne({ codigo }).lean()).validadaPor, 'puerta-a@clients', 'la segunda puerta no pisa el registro');
});

test('reingreso: 20 puertas validando la misma entrada a la vez, entra una sola', async () => {
  const evento = await crearEvento();
  const codigo = await crearEntrada(evento);
  const respuestas = await Promise.all(Array.from({ length: 20 }, (_, i) => validar(codigo, evento, `puerta-${i}@clients`)));

  assert.equal(respuestas.filter((r) => r.status === 200).length, 1);
  assert.equal(respuestas.filter((r) => r.status === 409 && r.cuerpo.code === 'TICKET_ALREADY_USED').length, 19);
  const guardada = await Entrada.findOne({ codigo }).lean();
  const ganadora = respuestas.find((r) => r.status === 200).cuerpo.entrada;
  assert.equal(guardada.validadaPor, ganadora.validadaPor, 'quedó registrada la puerta que ganó');
});

test('validar: una entrada de otro evento no entra por esta puerta', async () => {
  const eventoA = await crearEvento();
  const eventoB = await crearEvento();
  const codigo = await crearEntrada(eventoA);
  const res = await validar(codigo, eventoB);
  assert.deepEqual([res.status, res.cuerpo.code], [409, 'TICKET_WRONG_EVENT']);
  assert.deepEqual(res.cuerpo.details, { eventoEntrada: String(eventoA._id) });
  assert.equal((await Entrada.findOne({ codigo }).lean()).estado, 'emitida', 'sigue sin usar');
  assert.equal((await validar(codigo, eventoA)).status, 200, 'por su puerta sí');
});

test('validar: un evento cancelado, finalizado o en borrador no admite ingresos', async () => {
  for (const estado of ['cancelado', 'finalizado', 'borrador']) {
    const evento = await crearEvento({ estado });
    const codigo = await crearEntrada(evento);
    const res = await validar(codigo, evento);
    assert.deepEqual([res.status, res.cuerpo.code, res.cuerpo.details], [409, 'EVENT_NOT_ACTIVE', { estado }], estado);
    assert.equal((await Entrada.findOne({ codigo }).lean()).estado, 'emitida');
  }
});

test('validar: una entrada anulada responde TICKET_VOIDED', async () => {
  const evento = await crearEvento();
  const codigo = await crearEntrada(evento, { estado: 'anulada' });
  const res = await validar(codigo, evento);
  assert.deepEqual([res.status, res.cuerpo.code], [409, 'TICKET_VOIDED']);
});

test('validar: el evento sigue admitiendo ingresos después de empezar (hasta que finaliza)', async () => {
  const evento = await crearEvento({ fecha: enDias(-0.1) }); // empezó hace unas horas, todavía publicado
  const codigo = await crearEntrada(evento);
  assert.equal((await validar(codigo, evento)).status, 200);
});

async function reporte(clave = CLAVE) {
  const res = await fetch(`${base}/internal/reportes/ventas`, { headers: { 'x-api-key': clave } });
  return { status: res.status, cuerpo: await res.json() };
}

test('reporte: ventas y recaudación por evento, solo de compras pagadas', async () => {
  const recital = await crearEvento({ nombre: 'Recital', fecha: enDias(10), capacidad: 500, cupoDisponible: 493 });
  const jazz = await crearEvento({ nombre: 'Jazz', fecha: enDias(20), capacidad: 2, cupoDisponible: 2 });
  const compra = (evento, estado, cantidad, total) => ({
    _id: new mongoose.Types.ObjectId(), eventoId: evento._id, estado, cantidad, total, creadaPor: 'canal@clients',
    idempotencyKey: `k-${new mongoose.Types.ObjectId()}`, idempotencyFingerprint: 'h', createdAt: new Date(), updatedAt: new Date()
  });
  await Compra.collection.insertMany([
    compra(recital, 'pagada', 2, 50000), compra(recital, 'pagada', 3, 75000.5),
    compra(recital, 'pendiente', 2, 50000), compra(recital, 'rechazada', 1, 25000), compra(recital, 'cancelada', 1, 25000)
  ]);

  const res = await reporte();
  assert.equal(res.status, 200);
  assert.ok(Date.now() - new Date(res.cuerpo.generadoEn) < 5000);
  assert.deepEqual(res.cuerpo.eventos, [
    { eventoId: String(recital._id), nombre: 'Recital', capacidad: 500, cupoDisponible: 493, entradasVendidas: 5, recaudado: 125000.5 },
    { eventoId: String(jazz._id), nombre: 'Jazz', capacidad: 2, cupoDisponible: 2, entradasVendidas: 0, recaudado: 0 }
  ], 'ordenados por fecha; el cupo 493 = 500 − (5 pagadas + 2 pendientes)');
});

test('reporte: con la clave incorrecta es 401 y no consulta la base', async () => {
  await crearEvento();
  const res = await reporte('clave-equivocada');
  assert.deepEqual([res.status, res.cuerpo.code], [401, 'API_KEY_INVALID']);
});
