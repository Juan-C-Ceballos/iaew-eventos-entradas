const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTH0_DOMAIN ||= 'tenant-de-prueba.us.auth0.com';
process.env.AUTH0_AUDIENCE ||= 'https://iaew-eventos-api';
const app = require('../src/app');

let server;
let base;

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => server.close(resolve)));

function assertError(body, code) {
  assert.equal(body.code, code);
  for (const field of ['error', 'code', 'retryable', 'action']) assert.ok(field in body, `falta ${field}`);
}

test('GET /health responde ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /api-docs/openapi.json publica el contrato OpenAPI 3.1', async () => {
  const res = await fetch(`${base}/api-docs/openapi.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.openapi, '3.1.0');
  assert.ok(body.paths['/compras']);
});

test('GET /api-docs/ sirve Swagger UI', async () => {
  const res = await fetch(`${base}/api-docs/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('GET /token-info sin token responde 401 TOKEN_INVALID', async () => {
  const res = await fetch(`${base}/token-info`);
  assert.equal(res.status, 401);
  assertError(await res.json(), 'TOKEN_INVALID');
});

test('una operación del contrato aún no implementada responde 501', async () => {
  const res = await fetch(`${base}/compras/66f000000000000000000001/pagar`, { method: 'POST' });
  assert.equal(res.status, 501);
  assertError(await res.json(), 'NOT_IMPLEMENTED');
});

test('una ruta fuera del contrato responde 404 ROUTE_NOT_FOUND', async () => {
  const res = await fetch(`${base}/no-existe`);
  assert.equal(res.status, 404);
  assertError(await res.json(), 'ROUTE_NOT_FOUND');
});

test('un cuerpo JSON mal formado responde 400 INVALID_JSON', async () => {
  const res = await fetch(`${base}/eventos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"nombre":' });
  assert.equal(res.status, 400);
  assertError(await res.json(), 'INVALID_JSON');
});

test('el middleware de x-api-key valida la clave en tiempo constante', () => {
  const { requireApiKey } = require('../src/middleware/apiKey');
  const previa = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = 'clave-de-prueba';
  try {
    const correr = (clave) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let siguio = false;
      requireApiKey({ header: () => clave }, res, () => { siguio = true; });
      return { res, siguio };
    };
    assert.equal(correr('clave-de-prueba').siguio, true);
    const ausente = correr(undefined);
    assert.equal(ausente.res.statusCode, 401);
    assertError(ausente.res.body, 'API_KEY_INVALID');
    const incorrecta = correr('otra-clave-mas-larga-que-la-esperada');
    assert.equal(incorrecta.res.statusCode, 401);
    assertError(incorrecta.res.body, 'API_KEY_INVALID');
    delete process.env.INTERNAL_API_KEY;
    const sinConfigurar = correr('x');
    assert.equal(sinConfigurar.res.statusCode, 500);
    assertError(sinConfigurar.res.body, 'API_KEY_NOT_CONFIGURED');
  } finally {
    if (previa === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = previa;
  }
});
