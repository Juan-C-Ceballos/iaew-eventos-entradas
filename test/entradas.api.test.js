const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { crearEmisor } = require('./helpers/emisor');

// Lo que resuelven las rutas de control de acceso y el reporte antes de tocar la base:
// autenticación, scopes, x-api-key y validación. El flujo completo está en entradas.db.test.js.
let emisor;
let server;
let base;
const CLAVE = 'clave-de-prueba-interna';

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  process.env.INTERNAL_API_KEY = CLAVE;
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await emisor.close();
});

const CODIGO = 'ENT-7K2M9Q4XA1B3';
const EVENTO_ID = '66f000000000000000000001';

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

test('el control de acceso exige validate:entradas: 401 sin token y 403 con los scopes de otro rol', async () => {
  for (const [metodo, ruta] of [['GET', `/entradas/${CODIGO}`], ['POST', `/entradas/${CODIGO}/validar`]]) {
    const sinToken = await llamar(metodo, ruta, { cuerpo: { eventoId: EVENTO_ID } });
    assert.equal(sinToken.status, 401, `${metodo} ${ruta}`);
    assert.equal((await sinToken.json()).code, 'TOKEN_INVALID');

    // El canal de venta y el organizador no pueden validar entradas.
    const otroRol = await llamar(metodo, ruta, { scope: 'read:eventos buy:entradas write:eventos admin:eventos', cuerpo: { eventoId: EVENTO_ID } });
    assert.equal(otroRol.status, 403, `${metodo} ${ruta}`);
    assert.equal((await otroRol.json()).code, 'SCOPE_REQUIRED');
  }
});

test('los scopes del contrato coinciden con los de las rutas montadas', () => {
  const { openapi } = require('../src/lib/contrato');
  assert.deepEqual(openapi.paths['/entradas/{codigo}'].get.security[0].oauth2, ['validate:entradas']);
  assert.deepEqual(openapi.paths['/entradas/{codigo}/validar'].post.security[0].oauth2, ['validate:entradas']);
});

test('POST /entradas/{codigo}/validar con datos inválidos responde 400 VALIDATION_ERROR', async () => {
  for (const cuerpo of [{}, { eventoId: 'xyz' }, { eventoId: EVENTO_ID, extra: true }]) {
    const res = await llamar('POST', `/entradas/${CODIGO}/validar`, { scope: 'validate:entradas', cuerpo });
    assert.equal(res.status, 400, JSON.stringify(cuerpo));
    const respuesta = await res.json();
    assert.equal(respuesta.code, 'VALIDATION_ERROR');
    assert.ok(respuesta.details);
  }
});

test('un código con formato inválido es 404 TICKET_NOT_FOUND sin consultar la base', async () => {
  for (const codigo of ['abc', 'ENT-corto', 'ent-7k2m9q4xa1b3', 'ENT-7K2M9Q4XA1B3X']) {
    const lectura = await llamar('GET', `/entradas/${codigo}`, { scope: 'validate:entradas' });
    assert.equal(lectura.status, 404, codigo);
    assert.equal((await lectura.json()).code, 'TICKET_NOT_FOUND');

    const validacion = await llamar('POST', `/entradas/${codigo}/validar`, { scope: 'validate:entradas', cuerpo: { eventoId: EVENTO_ID } });
    assert.equal(validacion.status, 404, codigo);
  }
});

test('el reporte interno exige x-api-key: ausente, vacía o incorrecta es 401 API_KEY_INVALID', async () => {
  for (const cabeceras of [{}, { 'x-api-key': '' }, { 'x-api-key': 'otra-clave' }, { 'x-api-key': `${CLAVE}x` }]) {
    const res = await llamar('GET', '/internal/reportes/ventas', { cabeceras });
    assert.equal(res.status, 401, JSON.stringify(cabeceras));
    assert.equal((await res.json()).code, 'API_KEY_INVALID');
  }
});

test('un token OAuth no reemplaza a la x-api-key en el endpoint interno', async () => {
  const res = await llamar('GET', '/internal/reportes/ventas', { scope: 'read:eventos write:eventos admin:eventos buy:entradas validate:entradas' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'API_KEY_INVALID');
});

test('sin INTERNAL_API_KEY configurada el endpoint interno responde 500 API_KEY_NOT_CONFIGURED', async () => {
  delete process.env.INTERNAL_API_KEY;
  try {
    const res = await llamar('GET', '/internal/reportes/ventas', { cabeceras: { 'x-api-key': CLAVE } });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'API_KEY_NOT_CONFIGURED');
  } finally {
    process.env.INTERNAL_API_KEY = CLAVE;
  }
});
