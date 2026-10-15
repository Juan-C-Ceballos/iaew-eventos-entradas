const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearEmisor } = require('./helpers/emisor');

let emisor;
let server;
let base;

// El issuer debe conocerse antes de cargar la app: el middleware lee el entorno al importarse.
before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  const express = require('express');
  const { requireScope, manejarErrorAuth } = require('../src/middleware/auth0');
  const { sendError } = require('../src/lib/errors');

  const app = express();
  app.get('/solo-lectura', ...requireScope('read:eventos'), (req, res) => res.json({ sub: req.auth.payload.sub }));
  app.use(manejarErrorAuth);
  app.use((err, req, res, next) => sendError(res, 500, 'Error interno', 'INTERNAL_ERROR', true, 'Reintentar más tarde')); // eslint-disable-line no-unused-vars

  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await emisor.close();
});

const pedir = (token) => fetch(`${base}/solo-lectura`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('un token válido con el scope requerido pasa', async () => {
  const res = await pedir(emisor.token({ scope: 'read:eventos buy:entradas', sub: 'canal@clients' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sub: 'canal@clients' });
});

test('sin token responde 401 TOKEN_INVALID', async () => {
  const res = await pedir();
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'TOKEN_INVALID');
});

test('un token sin el scope requerido responde 403 SCOPE_REQUIRED', async () => {
  const res = await pedir(emisor.token({ scope: 'buy:entradas' }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'SCOPE_REQUIRED');
});

test('un token vencido responde 401', async () => {
  const res = await pedir(emisor.token({ scope: 'read:eventos', expiraEnSegundos: -60 }));
  assert.equal(res.status, 401);
});

test('un token con otra audience responde 401', async () => {
  const res = await pedir(emisor.token({ scope: 'read:eventos', aud: 'https://otra-api' }));
  assert.equal(res.status, 401);
});

test('un token con otro issuer responde 401', async () => {
  const res = await pedir(emisor.token({ scope: 'read:eventos', iss: 'http://127.0.0.1:1' }));
  assert.equal(res.status, 401);
});

test('un token firmado con otra clave responde 401', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await pedir(emisor.token({ scope: 'read:eventos', privateKey }));
  assert.equal(res.status, 401);
});
