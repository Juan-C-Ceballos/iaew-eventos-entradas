const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { crearServidor, configuracion, firmar } = require('../services/pagos-mock/server');

const SECRETO = 'secreto-de-prueba';
const COMPRA_ID = '6702a1b2c3d4e5f601234567';
const OTRA_COMPRA = '6702a1b2c3d4e5f601234568';

let mock;
let urlMock;
let receptor;
let recibidas;
let respuestasDelReceptor;

// Receptor de webhooks falso: guarda lo que llega y responde con la secuencia de estados pedida.
function crearReceptor() {
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      recibidas.push({ cabeceras: req.headers, cuerpo: Buffer.concat(partes).toString('utf8') });
      res.writeHead(respuestasDelReceptor.shift() ?? 200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve(servidor)));
}

async function levantarMock(env = {}) {
  const config = configuracion({
    PORT: '0', WEBHOOK_URL: `http://127.0.0.1:${receptor.address().port}`, WEBHOOK_SECRET: SECRETO,
    PAGO_DEMORA_MS: '10', WEBHOOK_BACKOFF_MS: '5', WEBHOOK_REINTENTOS: '3', ...env
  });
  mock = crearServidor(config, { log: () => {} });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  urlMock = `http://127.0.0.1:${mock.address().port}`;
}

beforeEach(async () => {
  recibidas = [];
  respuestasDelReceptor = [];
  receptor = await crearReceptor();
});

afterEach(async () => {
  await new Promise((resolve) => mock.close(resolve));
  await new Promise((resolve) => receptor.close(resolve));
});

const pedirPago = (cuerpo, cabeceras = {}) => fetch(`${urlMock}/pagos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo) });
const esperarNotificaciones = async () => { await new Promise((r) => setTimeout(r, 60)); await mock.esperarNotificaciones(); };

test('POST /pagos crea el pago y es idempotente por compraId', async () => {
  await levantarMock();
  const primera = await pedirPago({ compraId: COMPRA_ID, monto: 50000 });
  assert.equal(primera.status, 201);
  const pago = await primera.json();
  assert.match(pago.referenciaExterna, /^PAY-[0-9a-f]{8}$/);
  assert.deepEqual([pago.compraId, pago.estado, pago.monto], [COMPRA_ID, 'pendiente', 50000]);

  const repetida = await pedirPago({ compraId: COMPRA_ID, monto: 50000 });
  assert.equal(repetida.status, 200);
  assert.equal((await repetida.json()).referenciaExterna, pago.referenciaExterna);
  await esperarNotificaciones();
  assert.equal(recibidas.length, 1, 'un solo cobro, una sola notificación');
});

test('POST /pagos valida compraId, monto y escenario', async () => {
  await levantarMock({ WEBHOOK_HABILITADO: 'false' });
  for (const cuerpo of [{ monto: 1 }, { compraId: 'xyz', monto: 1 }, { compraId: COMPRA_ID }, { compraId: COMPRA_ID, monto: -1 }, { compraId: COMPRA_ID, monto: 1, escenario: 'raro' }]) {
    const res = await pedirPago(cuerpo);
    assert.equal(res.status, 400, JSON.stringify(cuerpo));
    assert.equal((await res.json()).code, 'VALIDATION_ERROR');
  }
  const noJson = await fetch(`${urlMock}/pagos`, { method: 'POST', body: '{"compraId":' });
  assert.equal(noJson.status, 400);
  assert.equal((await noJson.json()).code, 'INVALID_JSON');
});

test('el pago aprobado se notifica firmado con HMAC sobre el cuerpo exacto', async () => {
  await levantarMock();
  const { referenciaExterna } = await (await pedirPago({ compraId: COMPRA_ID, monto: 50000 }, { 'X-Correlation-Id': 'corr-123' })).json();
  await esperarNotificaciones();

  assert.equal(recibidas.length, 1);
  const { cabeceras, cuerpo } = recibidas[0];
  const notificacion = JSON.parse(cuerpo);
  assert.equal(notificacion.type, 'pago.aprobado');
  assert.deepEqual(notificacion.data, { compraId: COMPRA_ID, referenciaExterna, monto: 50000 });
  assert.match(notificacion.notificacionId, /^[0-9a-f-]{36}$/);
  assert.match(cabeceras['x-pago-timestamp'], /^[0-9]{10}$/);
  assert.equal(cabeceras['x-correlation-id'], 'corr-123');

  const esperada = `sha256=${crypto.createHmac('sha256', SECRETO).update(`${cabeceras['x-pago-timestamp']}.${cuerpo}`).digest('hex')}`;
  assert.equal(cabeceras['x-pago-firma'], esperada);
  assert.equal(firmar(SECRETO, cabeceras['x-pago-timestamp'], cuerpo), esperada);
  assert.notEqual(firmar('otro-secreto', cabeceras['x-pago-timestamp'], cuerpo), esperada);
});

test('el escenario rechazado notifica pago.rechazado con el motivo', async () => {
  await levantarMock();
  await pedirPago({ compraId: COMPRA_ID, monto: 100, escenario: 'rechazado' });
  await esperarNotificaciones();
  const notificacion = JSON.parse(recibidas[0].cuerpo);
  assert.equal(notificacion.type, 'pago.rechazado');
  assert.equal(notificacion.data.motivo, 'fondos_insuficientes');

  const estado = await (await fetch(`${urlMock}/pagos?compraId=${COMPRA_ID}`)).json();
  assert.deepEqual([estado.estado, estado.motivo], ['rechazado', 'fondos_insuficientes']);
});

test('ante un 5xx de la api reintenta con el mismo cuerpo y una firma nueva', async () => {
  respuestasDelReceptor = [503, 500];
  await levantarMock();
  await pedirPago({ compraId: COMPRA_ID, monto: 100 });
  await new Promise((r) => setTimeout(r, 150));
  await esperarNotificaciones();

  assert.equal(recibidas.length, 3, 'dos fallos y un éxito');
  assert.equal(new Set(recibidas.map((r) => r.cuerpo)).size, 1, 'mismo cuerpo, misma notificacionId');
  for (const { cabeceras, cuerpo } of recibidas) {
    assert.equal(cabeceras['x-pago-firma'], firmar(SECRETO, cabeceras['x-pago-timestamp'], cuerpo));
  }
});

test('ante un 4xx no reintenta y al agotar los reintentos deja el pago resuelto para la conciliación', async () => {
  respuestasDelReceptor = [401];
  await levantarMock();
  await pedirPago({ compraId: COMPRA_ID, monto: 100 });
  await new Promise((r) => setTimeout(r, 60));
  await esperarNotificaciones();
  assert.equal(recibidas.length, 1, 'un 4xx no se reintenta');

  respuestasDelReceptor = [500, 500, 500, 500, 500];
  await pedirPago({ compraId: OTRA_COMPRA, monto: 100 });
  await new Promise((r) => setTimeout(r, 200));
  await esperarNotificaciones();
  assert.equal(recibidas.length, 1 + 4, 'el intento inicial y 3 reintentos');
  const estado = await (await fetch(`${urlMock}/pagos?compraId=${OTRA_COMPRA}`)).json();
  assert.equal(estado.estado, 'aprobado', 'la pasarela cobró aunque no pudo notificar');
});

test('con WEBHOOK_HABILITADO=false resuelve el pago pero no notifica', async () => {
  await levantarMock({ WEBHOOK_HABILITADO: 'false' });
  await pedirPago({ compraId: COMPRA_ID, monto: 100 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(recibidas.length, 0);
  const estado = await (await fetch(`${urlMock}/pagos?compraId=${COMPRA_ID}`)).json();
  assert.equal(estado.estado, 'aprobado');
});

test('GET /pagos?compraId= informa pendiente mientras se procesa, 404 si no la conoce y 400 si el id es inválido', async () => {
  await levantarMock({ PAGO_DEMORA_MS: '5000', WEBHOOK_HABILITADO: 'false' });
  await pedirPago({ compraId: COMPRA_ID, monto: 100 });
  const pendiente = await (await fetch(`${urlMock}/pagos?compraId=${COMPRA_ID}`)).json();
  assert.equal(pendiente.estado, 'pendiente');

  const desconocido = await fetch(`${urlMock}/pagos?compraId=${OTRA_COMPRA}`);
  assert.equal(desconocido.status, 404);
  assert.equal((await desconocido.json()).code, 'PAYMENT_NOT_FOUND');
  assert.equal((await fetch(`${urlMock}/pagos?compraId=xyz`)).status, 400);
  assert.equal((await fetch(`${urlMock}/pagos`)).status, 400);
});

test('GET /health y rutas inexistentes', async () => {
  await levantarMock();
  assert.deepEqual(await (await fetch(`${urlMock}/health`)).json(), { status: 'ok', servicio: 'pagos-mock' });
  assert.equal((await fetch(`${urlMock}/otra`)).status, 404);
});

test('la configuración rechaza valores inválidos y trae valores por defecto', () => {
  const porDefecto = configuracion({});
  assert.deepEqual([porDefecto.port, porDefecto.webhookHabilitado, porDefecto.pagoDemoraMs], [4000, true, 200]);
  assert.throws(() => configuracion({ PAGO_DEMORA_MS: 'abc' }), /PAGO_DEMORA_MS debe ser un entero/);
  assert.throws(() => configuracion({ WEBHOOK_REINTENTOS: '-1' }), /WEBHOOK_REINTENTOS/);
});
