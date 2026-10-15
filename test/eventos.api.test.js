const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { crearEmisor } = require('./helpers/emisor');

// Estas pruebas cubren lo que la API resuelve antes de tocar la base: autenticación, scopes y
// validación. El flujo completo contra MongoDB está en eventos.db.test.js.
let emisor;
let server;
let base;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await emisor.close();
});

const ID = '66f000000000000000000001';
const llamar = (metodo, ruta, { scope, cuerpo } = {}) => {
  const conCuerpo = cuerpo !== undefined && metodo !== 'GET'; // fetch no admite cuerpo en GET
  return fetch(`${base}${ruta}`, {
    method: metodo,
    headers: {
      ...(scope !== undefined ? { Authorization: `Bearer ${emisor.token({ scope })}` } : {}),
      ...(conCuerpo ? { 'Content-Type': 'application/json' } : {})
    },
    body: conCuerpo ? JSON.stringify(cuerpo) : undefined
  });
};

const OPERACIONES = [
  ['GET', '/eventos', 'read:eventos'],
  ['POST', '/eventos', 'write:eventos'],
  ['GET', `/eventos/${ID}`, 'read:eventos'],
  ['PATCH', `/eventos/${ID}`, 'write:eventos'],
  ['DELETE', `/eventos/${ID}`, 'admin:eventos'],
  ['POST', `/eventos/${ID}/cancelar`, 'write:eventos']
];

test('cada operación de eventos exige el scope del contrato: 401 sin token, 403 con otro scope', async () => {
  for (const [metodo, ruta, scope] of OPERACIONES) {
    const sinToken = await llamar(metodo, ruta, { cuerpo: {} });
    assert.equal(sinToken.status, 401, `${metodo} ${ruta} sin token`);
    assert.equal((await sinToken.json()).code, 'TOKEN_INVALID');

    const otroScope = scope === 'read:eventos' ? 'buy:entradas' : 'read:eventos';
    const prohibido = await llamar(metodo, ruta, { scope: otroScope, cuerpo: {} });
    assert.equal(prohibido.status, 403, `${metodo} ${ruta} con ${otroScope}`);
    assert.equal((await prohibido.json()).code, 'SCOPE_REQUIRED');
  }
});

test('los scopes del contrato coinciden con los de las rutas montadas', () => {
  const { openapi } = require('../src/lib/contrato');
  for (const [metodo, ruta, scope] of OPERACIONES) {
    const rutaContrato = ruta.replace(ID, '{id}');
    const declarado = openapi.paths[rutaContrato][metodo.toLowerCase()].security[0].oauth2;
    assert.deepEqual(declarado, [scope], `${metodo} ${rutaContrato}`);
  }
});

test('un id mal formado responde 400 INVALID_ID', async () => {
  for (const [metodo, scope, ruta] of [['GET', 'read:eventos', '/eventos/abc'], ['PATCH', 'write:eventos', '/eventos/abc'], ['DELETE', 'admin:eventos', '/eventos/xyz'], ['POST', 'write:eventos', '/eventos/1/cancelar']]) {
    const res = await llamar(metodo, ruta, { scope, cuerpo: {} });
    assert.equal(res.status, 400, `${metodo} ${ruta}`);
    assert.equal((await res.json()).code, 'INVALID_ID');
  }
});

test('POST /eventos con datos inválidos responde 400 VALIDATION_ERROR con details por campo', async () => {
  const res = await llamar('POST', '/eventos', { scope: 'write:eventos', cuerpo: { nombre: '', capacidad: 0, precio: -1, extra: true } });
  assert.equal(res.status, 400);
  const cuerpo = await res.json();
  assert.equal(cuerpo.code, 'VALIDATION_ERROR');
  assert.equal(cuerpo.retryable, false);
  assert.ok(cuerpo.action);
  assert.deepEqual(Object.keys(cuerpo.details).sort(), ['capacidad', 'extra', 'fecha', 'lugar', 'nombre', 'precio']);
});

test('POST /eventos con fecha pasada responde 400 VALIDATION_ERROR', async () => {
  const res = await llamar('POST', '/eventos', { scope: 'write:eventos', cuerpo: { nombre: 'Viejo', fecha: '2020-01-01T10:00:00.000Z', lugar: 'Córdoba', capacidad: 10, precio: 5 } });
  assert.equal(res.status, 400);
  const cuerpo = await res.json();
  assert.equal(cuerpo.code, 'VALIDATION_ERROR');
  assert.deepEqual(cuerpo.details, { fecha: 'Debe ser una fecha futura' });
});

test('PATCH /eventos/{id} no acepta cancelar ni un cuerpo vacío', async () => {
  const cancelar = await llamar('PATCH', `/eventos/${ID}`, { scope: 'write:eventos', cuerpo: { estado: 'cancelado' } });
  assert.equal(cancelar.status, 400);
  assert.equal((await cancelar.json()).code, 'VALIDATION_ERROR');
  const vacio = await llamar('PATCH', `/eventos/${ID}`, { scope: 'write:eventos', cuerpo: {} });
  assert.equal(vacio.status, 400);
});

test('GET /eventos con un estado desconocido responde 400 VALIDATION_ERROR', async () => {
  const res = await llamar('GET', '/eventos?estado=raro', { scope: 'read:eventos' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'VALIDATION_ERROR');
});

test('las demás operaciones del contrato siguen respondiendo 501', async () => {
  const res = await llamar('GET', '/compras', { scope: 'buy:entradas' });
  assert.equal(res.status, 501);
});
