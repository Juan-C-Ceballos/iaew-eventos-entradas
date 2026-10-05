const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const amqp = require('amqplib');
const rabbit = require('../src/lib/rabbit');

function fakeConexion() {
  const canal = new EventEmitter();
  canal.exchanges = [];
  canal.queues = [];
  canal.assertExchange = async (nombre, tipo, opciones) => { canal.exchanges.push({ nombre, tipo, opciones }); };
  canal.assertQueue = async (nombre, opciones) => { canal.queues.push({ nombre, opciones }); };
  canal.bindQueue = async () => {};
  canal.publish = () => true;
  canal.waitForConfirms = async () => {};
  const conexion = new EventEmitter();
  conexion.cerrada = false;
  conexion.canal = canal;
  conexion.createConfirmChannel = async () => canal;
  conexion.close = async () => { conexion.cerrada = true; conexion.emit('close'); };
  return conexion;
}

let conexiones;

beforeEach(() => {
  conexiones = [];
  mock.method(amqp, 'connect', async () => {
    const conexion = fakeConexion();
    conexiones.push(conexion);
    return conexion;
  });
  mock.method(console, 'error', () => {});
});

afterEach(async () => {
  await rabbit.closeRabbit();
  mock.restoreAll();
  delete process.env.RETRY_DELAY_MS;
});

test('la topología no depende de RETRY_DELAY_MS: api y worker declaran lo mismo', async () => {
  delete process.env.RETRY_DELAY_MS;
  await rabbit.getChannel();
  const conDefault = conexiones[0].canal.queues;
  await rabbit.closeRabbit();

  process.env.RETRY_DELAY_MS = '9000';
  await rabbit.getChannel();
  assert.deepEqual(conexiones[1].canal.queues, conDefault);

  const retry = conDefault.find((q) => q.nombre === rabbit.RETRY_QUEUE);
  assert.equal(retry.opciones.arguments['x-message-ttl'], undefined);
  assert.equal(retry.opciones.arguments['x-dead-letter-exchange'], rabbit.EXCHANGE);
});

test('dos llamadas simultáneas abren una sola conexión', async () => {
  const [a, b] = await Promise.all([rabbit.getChannel(), rabbit.getChannel()]);
  assert.equal(a, b);
  assert.equal(conexiones.length, 1);
});

test('si la conexión falla, el siguiente intento vuelve a conectar', async () => {
  amqp.connect.mock.mockImplementationOnce(async () => { throw new Error('broker caído'); });
  await assert.rejects(rabbit.getChannel(), /broker caído/);
  await rabbit.getChannel();
  assert.equal(conexiones.length, 1);
});

test('un error del canal se registra y no tira el proceso', async () => {
  await rabbit.getChannel();
  const { canal } = conexiones[0];
  assert.doesNotThrow(() => canal.emit('error', new Error('PRECONDITION_FAILED')));
});

test('un canal cerrado cierra su conexión y el próximo uso abre una nueva', async () => {
  await rabbit.getChannel();
  const [primera] = conexiones;
  primera.canal.emit('close');
  assert.equal(primera.cerrada, true);

  await rabbit.getChannel();
  assert.equal(conexiones.length, 2);
});

test('publishEntradaComprada usa el mismo eventId como messageId', async () => {
  const publicados = [];
  const evento = { eventId: 'c0a8012e-7d1f-4b2a-9e55-1c2d3e4f5a6b', type: 'entrada.comprada', version: 1, occurredAt: new Date().toISOString(), correlationId: 'c1', data: { compraId: '6702a1b2c3d4e5f601234567' } };
  const canal = await rabbit.getChannel();
  canal.publish = (exchange, key, contenido, opciones) => { publicados.push({ exchange, key, opciones, cuerpo: JSON.parse(contenido) }); return true; };
  await rabbit.publishEntradaComprada(evento);
  assert.equal(publicados.length, 1);
  assert.equal(publicados[0].exchange, rabbit.EXCHANGE);
  assert.equal(publicados[0].opciones.messageId, evento.eventId);
  assert.deepEqual(publicados[0].cuerpo, evento);
});
