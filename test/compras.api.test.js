const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { crearEmisor } = require('./helpers/emisor');

// Lo que la API resuelve antes de tocar la base: autenticación, scopes, Idempotency-Key y
// validación. El flujo completo contra MongoDB está en compras.db.test.js.
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

const ID = '6702a1b2c3d4e5f601234567';
const COMPRA = { eventoId: '66f000000000000000000001', cantidad: 2, asistente: { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' } };

function llamar(metodo, ruta, { scope, cuerpo, cabeceras = {} } = {}) {
  const conCuerpo = cuerpo !== undefined && metodo !== 'GET';
  return fetch(`${base}${ruta}`, {
    method: metodo,
    headers: {
      ...(scope !== undefined ? { Authorization: `Bearer ${emisor.token({ scope })}` } : {}),
      ...(conCuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...cabeceras
    },
    body: conCuerpo ? JSON.stringify(cuerpo) : undefined
  });
}

const OPERACIONES = [
  ['POST', '/compras'],
  ['GET', '/compras'],
  ['GET', `/compras/${ID}`],
  ['POST', `/compras/${ID}/cancelar`],
  ['GET', `/compras/${ID}/entradas`]
];

test('cada operación de compras exige buy:entradas: 401 sin token, 403 con otro scope', async () => {
  for (const [metodo, ruta] of OPERACIONES) {
    const sinToken = await llamar(metodo, ruta, { cuerpo: COMPRA });
    assert.equal(sinToken.status, 401, `${metodo} ${ruta}`);
    assert.equal((await sinToken.json()).code, 'TOKEN_INVALID');

    const otroScope = await llamar(metodo, ruta, { scope: 'read:eventos write:eventos validate:entradas', cuerpo: COMPRA });
    assert.equal(otroScope.status, 403, `${metodo} ${ruta}`);
    assert.equal((await otroScope.json()).code, 'SCOPE_REQUIRED');
  }
});

test('los scopes del contrato coinciden con los de las rutas montadas', () => {
  const { openapi } = require('../src/lib/contrato');
  for (const [metodo, ruta] of OPERACIONES) {
    const rutaContrato = ruta.replace(ID, '{id}');
    assert.deepEqual(openapi.paths[rutaContrato][metodo.toLowerCase()].security[0].oauth2, ['buy:entradas'], `${metodo} ${rutaContrato}`);
  }
});

test('POST /compras sin Idempotency-Key responde 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
  const res = await llamar('POST', '/compras', { scope: 'buy:entradas', cuerpo: COMPRA });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('POST /compras con una Idempotency-Key inválida responde 400 IDEMPOTENCY_KEY_INVALID', async () => {
  for (const clave of ['corta', 'con espacios en medio', 'x'.repeat(129)]) {
    const res = await llamar('POST', '/compras', { scope: 'buy:entradas', cuerpo: COMPRA, cabeceras: { 'Idempotency-Key': clave } });
    assert.equal(res.status, 400, clave);
    assert.equal((await res.json()).code, 'IDEMPOTENCY_KEY_INVALID');
  }
});

test('POST /compras con datos inválidos responde 400 VALIDATION_ERROR con details', async () => {
  const cuerpo = { eventoId: 'xyz', cantidad: 11, asistente: { nombre: 'Ana', email: 'no-es-email', documento: '12' }, extra: true };
  const res = await llamar('POST', '/compras', { scope: 'buy:entradas', cuerpo, cabeceras: { 'Idempotency-Key': 'clave-valida-0001' } });
  assert.equal(res.status, 400);
  const respuesta = await res.json();
  assert.equal(respuesta.code, 'VALIDATION_ERROR');
  assert.equal(respuesta.error, 'Datos de compra inválidos');
  assert.deepEqual(Object.keys(respuesta.details).sort(), ['asistente.documento', 'asistente.email', 'cantidad', 'eventoId', 'extra']);
});

test('un id mal formado responde 400 INVALID_ID', async () => {
  for (const [metodo, ruta] of [['GET', '/compras/abc'], ['POST', '/compras/abc/cancelar'], ['GET', '/compras/1/entradas']]) {
    const res = await llamar(metodo, ruta, { scope: 'buy:entradas' });
    assert.equal(res.status, 400, `${metodo} ${ruta}`);
    assert.equal((await res.json()).code, 'INVALID_ID');
  }
});

test('GET /compras con filtros inválidos responde 400 VALIDATION_ERROR', async () => {
  const res = await llamar('GET', '/compras?estado=rara&eventoId=xyz', { scope: 'buy:entradas' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'VALIDATION_ERROR');
});

test('pagar sigue respondiendo 501 hasta la Fase 3', async () => {
  const res = await llamar('POST', `/compras/${ID}/pagar`, { scope: 'buy:entradas', cuerpo: {} });
  assert.equal(res.status, 501);
});
