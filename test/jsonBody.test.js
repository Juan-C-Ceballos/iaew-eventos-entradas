const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { jsonBody } = require('../src/lib/jsonBody');

let server;
let base;

before(() => new Promise((resolve) => {
  const app = express();
  app.use(jsonBody);
  app.post('/eco', (req, res) => res.json({ parseado: req.body, crudo: req.rawBody.toString('utf8') }));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));

after(() => new Promise((resolve) => server.close(resolve)));

test('conserva el cuerpo crudo tal como llegó, con sus espacios y el orden de las claves', async () => {
  const crudo = '{ "type":"pago.aprobado",   "data":{"compraId":"6702a1b2c3d4e5f601234567","monto":50000} }';
  const res = await fetch(`${base}/eco`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: crudo });
  const cuerpo = await res.json();
  assert.equal(cuerpo.crudo, crudo);
  assert.equal(cuerpo.parseado.type, 'pago.aprobado');
});

test('la firma HMAC sobre el cuerpo crudo no coincide con la del JSON vuelto a serializar', async () => {
  const secreto = 'secreto-de-prueba';
  const timestamp = '1791990125';
  const hmac = (texto) => crypto.createHmac('sha256', secreto).update(`${timestamp}.${texto}`).digest('hex');
  const crudo = '{ "type": "pago.aprobado" }';
  const res = await fetch(`${base}/eco`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: crudo });
  const { parseado, crudo: recibido } = await res.json();
  assert.equal(hmac(recibido), hmac(crudo));
  assert.notEqual(hmac(JSON.stringify(parseado)), hmac(crudo));
});

test('un JSON inválido sigue fallando con entity.parse.failed', async () => {
  const res = await fetch(`${base}/eco`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":' });
  assert.equal(res.status, 400);
});
