const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describirToken } = require('../src/lib/token');

const AHORA_MS = Date.parse('2026-10-05T12:00:00.000Z');
const payload = {
  iss: 'https://tenant.us.auth0.com/',
  aud: 'https://iaew-eventos-api',
  sub: 'AbCdEf123456@clients',
  scope: 'read:eventos buy:entradas',
  iat: AHORA_MS / 1000 - 600,
  exp: AHORA_MS / 1000 + 3000
};

test('describirToken muestra el emisor, los scopes y la vigencia', () => {
  assert.deepEqual(describirToken(payload, AHORA_MS), {
    issuer: 'https://tenant.us.auth0.com/',
    audience: 'https://iaew-eventos-api',
    subject: 'AbCdEf123456@clients',
    scopes: 'read:eventos buy:entradas',
    issuedAt: '2026-10-05T11:50:00.000Z',
    expiresAt: '2026-10-05T12:50:00.000Z',
    expiresInSeconds: 3000
  });
});

test('un token ya vencido informa 0 segundos restantes, nunca negativos', () => {
  assert.equal(describirToken({ ...payload, exp: AHORA_MS / 1000 - 5 }, AHORA_MS).expiresInSeconds, 0);
});

test('si el payload no trae iat ni exp, esos campos quedan sin definir', () => {
  const resumen = describirToken({ iss: 'x', aud: 'y', sub: 'z', scope: '' }, AHORA_MS);
  assert.equal(resumen.issuedAt, undefined);
  assert.equal(resumen.expiresAt, undefined);
  assert.equal(resumen.expiresInSeconds, undefined);
});
