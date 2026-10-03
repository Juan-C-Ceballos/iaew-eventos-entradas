const amqp = require('amqplib');
const { retryConfig } = require('./config');

// Topología documentada en docs/eventos/README.md y ADR 0005.
const EXCHANGE = 'entradas.exchange';
const ROUTING_KEY = 'entrada.comprada';
const QUEUE = 'emision.entrada-comprada';
const RETRY_EXCHANGE = 'entradas.retry.exchange';
const RETRY_QUEUE = 'emision.entrada-comprada.retry';
const DLX = 'entradas.dlx';
const DLQ_ROUTING_KEY = 'entrada.comprada.dlq';
const DLQ = 'emision.entrada-comprada.dlq';

let connection;
let channel;

function rabbitUrl() {
  if (process.env.RABBIT_URL) return process.env.RABBIT_URL;
  const user = encodeURIComponent(process.env.RABBIT_USER || 'iaew');
  const pass = encodeURIComponent(process.env.RABBIT_PASS || 'iaew-local');
  return `amqp://${user}:${pass}@localhost:5672`;
}

async function getChannel() {
  if (channel) return channel;
  connection = await amqp.connect(rabbitUrl());
  connection.on('error', (error) => console.error('Conexión RabbitMQ falló:', error.message));
  connection.on('close', () => { connection = undefined; channel = undefined; });
  channel = await connection.createConfirmChannel();
  const { retryDelayMs } = retryConfig();

  await channel.assertExchange(EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(RETRY_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(DLX, 'direct', { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  await channel.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': retryDelayMs,
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEY
    }
  });
  await channel.bindQueue(RETRY_QUEUE, RETRY_EXCHANGE, ROUTING_KEY);
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);
  return channel;
}

async function confirmedPublish(activeChannel, exchange, routingKey, content, options) {
  const accepted = activeChannel.publish(exchange, routingKey, content, options);
  if (!accepted) throw new Error('RabbitMQ aplicó back-pressure al publicar');
  await activeChannel.waitForConfirms();
}

async function publishEntradaComprada(event) {
  const activeChannel = await getChannel();
  await confirmedPublish(activeChannel, EXCHANGE, ROUTING_KEY, Buffer.from(JSON.stringify(event)), {
    contentType: 'application/json', persistent: true, messageId: event.eventId,
    correlationId: event.correlationId, type: event.type, headers: { 'x-retry-count': 0 }
  });
}

async function closeRabbit() {
  const activeConnection = connection;
  connection = undefined;
  channel = undefined;
  if (!activeConnection) return;
  try {
    await activeConnection.close();
  } catch (error) {
    if (error?.name !== 'IllegalOperationError') throw error;
  }
}

module.exports = {
  EXCHANGE, ROUTING_KEY, QUEUE, RETRY_EXCHANGE, RETRY_QUEUE, DLX, DLQ_ROUTING_KEY, DLQ,
  getChannel, publishEntradaComprada, closeRabbit
};
