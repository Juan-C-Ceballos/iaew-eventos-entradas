const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { firmar } = require('../src/lib/firma');

// Lo que el webhook resuelve antes de tocar el estado de las compras: firma, ventana de tiempo,
// formato del cuerpo y la respuesta cuando MongoDB no está. El flujo completo está en webhooks.db.test.js.
const SECRETO = 'secreto-de-prueba';
let server;
let base;
let secretoPrevio;

before(async () => {
  secretoPrevio = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = SECRETO;
  process.env.AUTH0_DOMAIN ||= 'tenant-de-prueba.us.auth0.com';
  // Sin conexión, las operaciones de Mongoose esperan 10 s antes de fallar: se acorta para probar el 503.
  mongoose.set('bufferTimeoutMS', 200);
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (secretoPrevio === undefined) delete process.env.WEBHOOK_SECRET; else process.env.WEBHOOK_SECRET = secretoPrevio;
});

const NOTIFICACION = {
  notificacionId: '0b8f5a8e-1d2c-4c39-9a51-3f1b7f0c2d11',
  type: 'pago.aprobado',
  occurredAt: '2026-10-03T15:02:04.000Z',
  data: { compraId: '6702a1b2c3d4e5f601234567', referenciaExterna: 'PAY-7f3c2a91', monto: 50000 }
};

const ahoraEnSegundos = () => Math.floor(Date.now() / 1000);

// Envía el cuerpo firmado tal cual; `cambios` permite romper la firma, el timestamp o las cabeceras.
function enviar(cuerpo = NOTIFICACION, { secreto = SECRETO, timestamp = String(ahoraEnSegundos()), firma, cabeceras = {} } = {}) {
  const texto = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
  return fetch(`${base}/webhooks/pagos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pago-Timestamp': timestamp,
      'X-Pago-Firma': firma ?? firmar(secreto, timestamp, texto),
      ...cabeceras
    },
    body: texto
  });
}

const codigoDe = async (res) => (await res.json()).code;

test('sin firma o sin timestamp responde 401 WEBHOOK_SIGNATURE_INVALID', async () => {
  const sinFirma = await fetch(`${base}/webhooks/pagos`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pago-Timestamp': String(ahoraEnSegundos()) }, body: JSON.stringify(NOTIFICACION) });
  assert.equal(sinFirma.status, 401);
  assert.equal(await codigoDe(sinFirma), 'WEBHOOK_SIGNATURE_INVALID');

  const sinTimestamp = await fetch(`${base}/webhooks/pagos`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pago-Firma': 'sha256=abc' }, body: JSON.stringify(NOTIFICACION) });
  assert.equal(sinTimestamp.status, 401);
});

test('una firma hecha con otro secreto o sobre otro cuerpo responde 401 WEBHOOK_SIGNATURE_INVALID', async () => {
  const otroSecreto = await enviar(NOTIFICACION, { secreto: 'secreto-equivocado' });
  assert.equal(otroSecreto.status, 401);
  assert.equal(await codigoDe(otroSecreto), 'WEBHOOK_SIGNATURE_INVALID');

  const timestamp = String(ahoraEnSegundos());
  const otroCuerpo = await enviar(NOTIFICACION, { timestamp, firma: firmar(SECRETO, timestamp, JSON.stringify({ ...NOTIFICACION, type: 'pago.rechazado' })) });
  assert.equal(await codigoDe(otroCuerpo), 'WEBHOOK_SIGNATURE_INVALID');
});

test('la firma se calcula sobre los bytes recibidos, no sobre el JSON reserializado', async () => {
  // Mismo contenido pero con otros espacios: firmado el original, el reserializado no coincidiría.
  const original = '{ "notificacionId": "0b8f5a8e-1d2c-4c39-9a51-3f1b7f0c2d11",   "type": "pago.aprobado" }';
  const timestamp = String(ahoraEnSegundos());
  const reserializado = JSON.stringify(JSON.parse(original));
  const res = await enviar(original, { timestamp, firma: firmar(SECRETO, timestamp, reserializado) });
  assert.equal(res.status, 401);
  assert.equal(await codigoDe(res), 'WEBHOOK_SIGNATURE_INVALID');
});

test('un timestamp fuera de la ventana responde 401 WEBHOOK_TIMESTAMP_EXPIRED', async () => {
  for (const desvio of [-301, 301, -86400]) {
    const res = await enviar(NOTIFICACION, { timestamp: String(ahoraEnSegundos() + desvio) });
    assert.equal(res.status, 401, `desvío ${desvio}`);
    assert.equal(await codigoDe(res), 'WEBHOOK_TIMESTAMP_EXPIRED');
  }
});

test('con la firma válida, un cuerpo mal formado responde 400 VALIDATION_ERROR con details', async () => {
  const res = await enviar({ notificacionId: 'no-es-uuid', type: 'pago.reembolsado', occurredAt: 'ayer', data: { compraId: 'xyz', monto: -1, extra: 1 } });
  assert.equal(res.status, 400);
  const cuerpo = await res.json();
  assert.equal(cuerpo.code, 'VALIDATION_ERROR');
  assert.deepEqual(Object.keys(cuerpo.details).sort(), ['data.compraId', 'data.extra', 'data.monto', 'data.referenciaExterna', 'notificacionId', 'occurredAt', 'type']);
});

test('sin secreto configurado responde 500 WEBHOOK_SECRET_NOT_CONFIGURED', async () => {
  delete process.env.WEBHOOK_SECRET;
  try {
    const res = await enviar();
    assert.equal(res.status, 500);
    assert.equal(await codigoDe(res), 'WEBHOOK_SECRET_NOT_CONFIGURED');
  } finally {
    process.env.WEBHOOK_SECRET = SECRETO;
  }
});

test('si MongoDB no responde, la notificación firmada recibe 503 DATABASE_UNAVAILABLE para que la pasarela reintente', async () => {
  const consola = console.error;
  console.error = () => {};
  try {
    const res = await enviar();
    assert.equal(res.status, 503);
    const cuerpo = await res.json();
    assert.deepEqual([cuerpo.code, cuerpo.retryable], ['DATABASE_UNAVAILABLE', true]);
  } finally {
    console.error = consola;
  }
});

test('el webhook no usa OAuth: una firma válida pasa sin Authorization y un Bearer no reemplaza la firma', async () => {
  const conBearer = await fetch(`${base}/webhooks/pagos`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' }, body: JSON.stringify(NOTIFICACION) });
  assert.equal(conBearer.status, 401);
  assert.equal(await codigoDe(conBearer), 'WEBHOOK_SIGNATURE_INVALID');
});
