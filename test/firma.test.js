const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { firmar, verificarFirma } = require('../src/lib/firma');
const { firmar: firmarPasarela } = require('../services/pagos-mock/server');
const { webhookConfig } = require('../src/lib/config');
const { ApiError, esBaseNoDisponible } = require('../src/lib/errors');

const SECRETO = 'secreto-de-prueba';
const AHORA = new Date('2026-11-01T12:00:00.000Z');
const TS = String(Math.floor(AHORA.getTime() / 1000));
const CUERPO = Buffer.from('{"notificacionId":"abc","type":"pago.aprobado"}');

const verificar = (cambios = {}) => verificarFirma({
  secreto: SECRETO, timestamp: TS, cuerpo: CUERPO, firma: firmar(SECRETO, TS, CUERPO), toleranciaSegundos: 300, ahora: AHORA, ...cambios
});
const rechazaCon = (codigo) => (error) => error instanceof ApiError && error.status === 401 && error.code === codigo;

test('la firma es sha256= + HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")', () => {
  const esperada = `sha256=${crypto.createHmac('sha256', SECRETO).update(`${TS}.${CUERPO.toString()}`).digest('hex')}`;
  assert.equal(firmar(SECRETO, TS, CUERPO), esperada);
  assert.equal(firmar(SECRETO, TS, CUERPO.toString()), esperada, 'acepta el cuerpo como texto o como bytes');
});

test('la api verifica lo que firma la pasarela simulada (mismo algoritmo en los dos extremos)', () => {
  assert.equal(firmarPasarela(SECRETO, TS, CUERPO.toString()), firmar(SECRETO, TS, CUERPO));
  assert.doesNotThrow(() => verificar({ firma: firmarPasarela(SECRETO, TS, CUERPO.toString()) }));
});

test('una firma correcta dentro de la ventana se acepta', () => {
  assert.doesNotThrow(() => verificar());
});

test('un cuerpo alterado, otro secreto o un timestamp distinto invalidan la firma', () => {
  assert.throws(() => verificar({ cuerpo: Buffer.from('{"notificacionId":"abc","type":"pago.rechazado"}') }), rechazaCon('WEBHOOK_SIGNATURE_INVALID'));
  assert.throws(() => verificar({ firma: firmar('otro-secreto', TS, CUERPO) }), rechazaCon('WEBHOOK_SIGNATURE_INVALID'));
  assert.throws(() => verificar({ timestamp: String(Number(TS) + 1) }), rechazaCon('WEBHOOK_SIGNATURE_INVALID'));
});

test('firma o timestamp ausentes o con formato inválido son 401 WEBHOOK_SIGNATURE_INVALID', () => {
  for (const cambios of [
    { firma: undefined }, { firma: '' }, { firma: 'sha256=' }, { firma: 'md5=abc' }, { firma: firmar(SECRETO, TS, CUERPO).slice(7) },
    { timestamp: undefined }, { timestamp: '123' }, { timestamp: '1791990125000' }, { timestamp: 'abcdefghij' },
    { cuerpo: undefined }
  ]) {
    assert.throws(() => verificar(cambios), rechazaCon('WEBHOOK_SIGNATURE_INVALID'), JSON.stringify(cambios));
  }
});

test('un timestamp fuera de ±tolerancia es 401 WEBHOOK_TIMESTAMP_EXPIRED, aunque la firma sea válida', () => {
  const con = (segundos) => {
    const timestamp = String(Number(TS) + segundos);
    return { timestamp, firma: firmar(SECRETO, timestamp, CUERPO) };
  };
  assert.doesNotThrow(() => verificar(con(-300)), 'justo en el límite');
  assert.doesNotThrow(() => verificar(con(300)));
  assert.throws(() => verificar(con(-301)), rechazaCon('WEBHOOK_TIMESTAMP_EXPIRED'));
  assert.throws(() => verificar(con(301)), rechazaCon('WEBHOOK_TIMESTAMP_EXPIRED'));
  assert.doesNotThrow(() => verificar({ ...con(-3600), toleranciaSegundos: 7200 }), 'con más tolerancia sí pasa');
});

test('webhookConfig lee el secreto y la tolerancia (300 s por defecto) y valida el rango', () => {
  assert.deepEqual(webhookConfig({ WEBHOOK_SECRET: 's' }), { secreto: 's', toleranciaSegundos: 300 });
  assert.equal(webhookConfig({ WEBHOOK_SECRET: 's', WEBHOOK_TOLERANCIA_SEGUNDOS: '60' }).toleranciaSegundos, 60);
  assert.throws(() => webhookConfig({ WEBHOOK_TOLERANCIA_SEGUNDOS: '0' }), /WEBHOOK_TOLERANCIA_SEGUNDOS debe ser un entero/);
});

test('esBaseNoDisponible reconoce los errores de conexión de MongoDB y no otros', () => {
  for (const name of ['MongoNetworkError', 'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNotConnectedError']) {
    assert.equal(esBaseNoDisponible(Object.assign(new Error('x'), { name })), true, name);
  }
  assert.equal(esBaseNoDisponible(new Error('Operation `compras.findOne()` buffering timed out after 10000ms')), true);
  assert.equal(esBaseNoDisponible(new Error('otra cosa')), false);
  assert.equal(esBaseNoDisponible(Object.assign(new Error('dup'), { name: 'MongoServerError', code: 11000 })), false);
  assert.equal(esBaseNoDisponible(undefined), false);
});
