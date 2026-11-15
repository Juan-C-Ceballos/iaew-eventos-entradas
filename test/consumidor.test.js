const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { crearManejador, ErrorPermanente, validarEntradaComprada } = require('../src/lib/consumidor');
const rabbit = require('../src/lib/rabbit');
const { generarCodigoEntrada } = require('../src/lib/codigoEntrada');

const EVENTO = {
  eventId: '3f5204d4-8952-4a3f-92ea-0a6222151299', type: 'entrada.comprada', version: 1,
  occurredAt: '2026-10-03T15:02:04.500Z', correlationId: 'corr-1', data: { compraId: '6702a1b2c3d4e5f601234567' }
};

const mensaje = (contenido = EVENTO, headers = { 'x-retry-count': 0 }) => ({
  content: Buffer.from(typeof contenido === 'string' ? contenido : JSON.stringify(contenido)),
  fields: { deliveryTag: 1 },
  properties: { messageId: 'msg-1', correlationId: 'corr-1', type: 'entrada.comprada', contentType: 'application/json', headers }
});

// Canal falso que registra el orden de las operaciones: confirmar el original antes de haber
// publicado el reintento o la DLQ perdería el mensaje.
function entorno({ procesar, maxRetries = 3, publicarFalla = false } = {}) {
  const operaciones = [];
  const canal = Object.assign(new EventEmitter(), { ack: () => operaciones.push('ack') });
  const broker = {
    publicarReintento: async (c, msg, opciones) => {
      if (publicarFalla) throw new Error('broker caído');
      operaciones.push(`reintento:${rabbit.intentosDe(msg) + 1}:${opciones.retryDelayMs}:${opciones.error.message}`);
      return rabbit.intentosDe(msg) + 1;
    },
    publicarEnDlq: async (c, msg, opciones) => {
      if (publicarFalla) throw new Error('broker caído');
      operaciones.push(`dlq:${opciones.reason}`);
    }
  };
  let fatal = null;
  const log = { log: () => {}, warn: () => {}, error: () => {} };
  const manejar = crearManejador({ procesar, maxRetries, retryDelayMs: 250, broker, log, alFallarEnrutamiento: (error) => { fatal = error; } });
  return { canal, manejar, operaciones, fatal: () => fatal };
}

test('un mensaje procesado se confirma después de persistir', async () => {
  const vistos = [];
  const { canal, manejar, operaciones } = entorno({ procesar: async (evento) => { vistos.push(evento); operaciones.push('procesar'); return { resultado: 'emitidas' }; } });
  await manejar(canal, mensaje());
  assert.deepEqual(vistos, [EVENTO]);
  assert.deepEqual(operaciones, ['procesar', 'ack']);
});

test('un JSON inválido o un mensaje fuera del contrato van directo a la DLQ, sin procesar', async () => {
  const { canal, manejar, operaciones } = entorno({ procesar: async () => assert.fail('no debe procesar') });
  await manejar(canal, mensaje('{no es json'));
  await manejar(canal, mensaje({ ...EVENTO, version: 2 }));
  await manejar(canal, mensaje({ ...EVENTO, extra: true }));
  await manejar(canal, mensaje({ ...EVENTO, data: { compraId: 'xyz' } }));
  assert.deepEqual(operaciones, ['dlq:invalid_json', 'ack', 'dlq:contract_invalid', 'ack', 'dlq:contract_invalid', 'ack', 'dlq:contract_invalid', 'ack']);
});

test('un error permanente va a la DLQ con su motivo, sin reintentos', async () => {
  const { canal, manejar, operaciones } = entorno({ procesar: async () => { throw new ErrorPermanente('no existe', 'compra_not_found'); } });
  await manejar(canal, mensaje());
  assert.deepEqual(operaciones, ['dlq:compra_not_found', 'ack']);
});

test('un error transitorio se reencola con x-retry-count + 1 y recién después se confirma el original', async () => {
  const { canal, manejar, operaciones } = entorno({ procesar: async () => { throw new Error('mongo caído'); } });
  await manejar(canal, mensaje(EVENTO, { 'x-retry-count': 0 }));
  await manejar(canal, mensaje(EVENTO, { 'x-retry-count': 2 }));
  assert.deepEqual(operaciones, ['reintento:1:250:mongo caído', 'ack', 'reintento:3:250:mongo caído', 'ack']);
});

test('un mensaje sin x-retry-count cuenta como intento 0', async () => {
  const { canal, manejar, operaciones } = entorno({ procesar: async () => { throw new Error('falla'); } });
  await manejar(canal, mensaje(EVENTO, undefined));
  assert.deepEqual(operaciones, ['reintento:1:250:falla', 'ack']);
});

test('agotados los reintentos, el mensaje va a la DLQ', async () => {
  const { canal, manejar, operaciones } = entorno({ procesar: async () => { throw new Error('sigue fallando'); }, maxRetries: 3 });
  await manejar(canal, mensaje(EVENTO, { 'x-retry-count': 3 }));
  assert.deepEqual(operaciones, ['dlq:max_retries_exceeded', 'ack']);
});

test('con MAX_RETRIES=0 el primer error ya va a la DLQ', async () => {
  const { canal, manejar, operaciones } = entorno({ procesar: async () => { throw new Error('falla'); }, maxRetries: 0 });
  await manejar(canal, mensaje());
  assert.deepEqual(operaciones, ['dlq:max_retries_exceeded', 'ack']);
});

test('si no se puede reencolar ni derivar, el mensaje NO se confirma y se avisa para reiniciar el worker', async () => {
  for (const procesar of [async () => { throw new Error('falla'); }, async () => { throw new ErrorPermanente('x', 'compra_not_found'); }]) {
    const { canal, manejar, operaciones, fatal } = entorno({ procesar, publicarFalla: true });
    await manejar(canal, mensaje());
    assert.deepEqual(operaciones, [], 'sin ack: el mensaje vuelve a la cola cuando se cierra el canal');
    assert.match(fatal().message, /broker caído/);
  }
  const jsonRoto = entorno({ procesar: async () => {}, publicarFalla: true });
  await jsonRoto.manejar(jsonRoto.canal, mensaje('{roto'));
  assert.deepEqual(jsonRoto.operaciones, []);
  assert.ok(jsonRoto.fatal());
});

test('el esquema del contrato acepta el ejemplo y rechaza lo que no es entrada.comprada v1', () => {
  assert.equal(validarEntradaComprada(EVENTO), true);
  assert.equal(validarEntradaComprada({ ...EVENTO, type: 'otra.cosa' }), false);
  assert.equal(validarEntradaComprada({ ...EVENTO, eventId: 'no-uuid' }), false);
});

test('los códigos de entrada tienen el formato ENT-XXXXXXXXXXXX y no se repiten', () => {
  const codigos = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const codigo = generarCodigoEntrada();
    assert.match(codigo, /^ENT-[A-Z0-9]{12}$/);
    codigos.add(codigo);
  }
  assert.equal(codigos.size, 2000);
});

test('publicarReintento y publicarEnDlq usan los exchanges, la espera y los headers del contrato', async () => {
  const publicados = [];
  const canal = {
    publish: (exchange, key, contenido, opciones) => { publicados.push({ exchange, key, contenido, opciones }); return true; },
    waitForConfirms: async () => {}
  };
  const msg = mensaje(EVENTO, { 'x-retry-count': 1 });

  const intento = await rabbit.publicarReintento(canal, msg, { retryDelayMs: 3000, error: new Error('mongo caído') });
  assert.equal(intento, 2);
  const [reintento] = publicados;
  assert.deepEqual([reintento.exchange, reintento.key], [rabbit.RETRY_EXCHANGE, rabbit.ROUTING_KEY]);
  assert.equal(reintento.opciones.expiration, '3000');
  assert.equal(reintento.opciones.persistent, true);
  assert.equal(reintento.opciones.messageId, 'msg-1');
  assert.deepEqual([reintento.opciones.headers['x-retry-count'], reintento.opciones.headers['x-last-error']], [2, 'mongo caído']);
  assert.equal(reintento.contenido, msg.content, 'el cuerpo no se modifica');

  await rabbit.publicarEnDlq(canal, msg, { reason: 'max_retries_exceeded', error: new Error('x'.repeat(900)) });
  const dlq = publicados[1];
  assert.deepEqual([dlq.exchange, dlq.key], [rabbit.DLX, rabbit.DLQ_ROUTING_KEY]);
  assert.equal(dlq.opciones.headers['x-dlq-reason'], 'max_retries_exceeded');
  assert.equal(dlq.opciones.headers['x-last-error'].length, 500, 'el error se acota');
  assert.equal(dlq.opciones.headers['x-retry-count'], 1, 'conserva el contador');
});

test('si el broker aplica back-pressure al reencolar, la publicación falla (y el mensaje no se confirma)', async () => {
  const canal = { publish: () => false, waitForConfirms: async () => {} };
  await assert.rejects(rabbit.publicarReintento(canal, mensaje(), { retryDelayMs: 1, error: new Error('x') }), /back-pressure/);
});
