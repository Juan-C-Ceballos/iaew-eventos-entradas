const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { operaciones } = require('../src/lib/contrato');

// Cada operación de docs/openapi.json tiene su ruta montada y con la seguridad que declara. Se
// llama a todas sin credenciales: lo que importa es que NO respondan 404 ROUTE_NOT_FOUND (ruta
// sin montar) y que las protegidas rechacen antes de tocar la base.
let server;
let base;

before(async () => {
  process.env.AUTH0_DOMAIN ||= 'tenant-de-prueba.us.auth0.com';
  process.env.INTERNAL_API_KEY = 'clave-de-prueba';
  process.env.WEBHOOK_SECRET = 'secreto-de-prueba';
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const ID = '66f000000000000000000001';
const rutaConcreta = (openapiPath) => openapiPath.replace('{id}', ID).replace('{codigo}', 'ENT-7K2M9Q4XA1B3');

test('el contrato declara operaciones y cada una tiene su ruta (nunca 404 ROUTE_NOT_FOUND ni 501)', async () => {
  const todas = operaciones();
  assert.ok(todas.length >= 18, `operaciones detectadas: ${todas.length}`);
  for (const { method, openapiPath } of todas) {
    const res = await fetch(`${base}${rutaConcreta(openapiPath)}`, {
      method: method.toUpperCase(),
      headers: method === 'get' || method === 'delete' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'get' || method === 'delete' ? undefined : '{}'
    });
    const cuerpo = await res.json().catch(() => ({}));
    assert.notEqual(cuerpo.code, 'ROUTE_NOT_FOUND', `${method.toUpperCase()} ${openapiPath} no está montada`);
    assert.notEqual(res.status, 501, `${method.toUpperCase()} ${openapiPath} sigue sin implementar`);
  }
});

test('las operaciones protegidas rechazan sin credenciales según su esquema de seguridad', async () => {
  const esperado = { oauth2: 401, apiKey: 401, webhookFirma: 401 };
  const { openapi } = require('../src/lib/contrato');
  for (const { method, openapiPath } of operaciones()) {
    const seguridad = openapi.paths[openapiPath][method].security;
    if (!seguridad.length) continue; // /health es pública
    const esquema = Object.keys(seguridad[0])[0];
    const res = await fetch(`${base}${rutaConcreta(openapiPath)}`, {
      method: method.toUpperCase(),
      headers: method === 'get' || method === 'delete' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'get' || method === 'delete' ? undefined : '{}'
    });
    assert.equal(res.status, esperado[esquema], `${method.toUpperCase()} ${openapiPath} (${esquema})`);
  }
});

test('una ruta que no está en el contrato sigue siendo 404 ROUTE_NOT_FOUND', async () => {
  const res = await fetch(`${base}/no-existe`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'ROUTE_NOT_FOUND');
});
