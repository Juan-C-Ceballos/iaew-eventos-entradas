const amqp = require('amqplib');

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
let channelPromise;

function rabbitUrl() {
  if (process.env.RABBIT_URL) return process.env.RABBIT_URL;
  const user = encodeURIComponent(process.env.RABBIT_USER || 'iaew');
  const pass = encodeURIComponent(process.env.RABBIT_PASS || 'iaew-local');
  return `amqp://${user}:${pass}@localhost:5672`;
}

// La topología no depende de ninguna variable de entorno: api y worker la declaran de forma
// idempotente y con los mismos argumentos, así que no importa quién arranque primero ni qué
// valor tenga RETRY_DELAY_MS en cada servicio. El retraso del reintento viaja como `expiration`
// de cada mensaje que el worker publica en RETRY_EXCHANGE (ver docs/eventos/README.md).
async function declararTopologia(activeChannel) {
  await activeChannel.assertExchange(EXCHANGE, 'direct', { durable: true });
  await activeChannel.assertExchange(RETRY_EXCHANGE, 'direct', { durable: true });
  await activeChannel.assertExchange(DLX, 'direct', { durable: true });
  await activeChannel.assertQueue(QUEUE, { durable: true });
  await activeChannel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  await activeChannel.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEY
    }
  });
  await activeChannel.bindQueue(RETRY_QUEUE, RETRY_EXCHANGE, ROUTING_KEY);
  await activeChannel.assertQueue(DLQ, { durable: true });
  await activeChannel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);
}

async function abrirCanal() {
  const activeConnection = await amqp.connect(rabbitUrl());
  connection = activeConnection;
  activeConnection.on('error', (error) => console.error('Conexión RabbitMQ falló:', error.message));
  activeConnection.on('close', () => {
    if (connection === activeConnection) { connection = undefined; channelPromise = undefined; }
  });
  try {
    const activeChannel = await activeConnection.createConfirmChannel();
    // Sin este listener, un error del canal (por ejemplo una precondición fallida) sería una
    // excepción no capturada y tiraría abajo el proceso.
    activeChannel.on('error', (error) => console.error('Canal RabbitMQ falló:', error.message));
    // Un canal cerrado no se reutiliza: se cierra la conexión y el próximo uso abre una nueva.
    activeChannel.on('close', () => {
      if (connection !== activeConnection) return;
      connection = undefined;
      channelPromise = undefined;
      activeConnection.close().catch(() => {});
    });
    await declararTopologia(activeChannel);
    return activeChannel;
  } catch (error) {
    if (connection === activeConnection) { connection = undefined; channelPromise = undefined; }
    await activeConnection.close().catch(() => {});
    throw error;
  }
}

// Se memoiza la promesa (no el canal) para que dos llamadas simultáneas no abran dos conexiones.
function getChannel() {
  if (!channelPromise) {
    const intento = abrirCanal();
    channelPromise = intento;
    intento.catch(() => { if (channelPromise === intento) channelPromise = undefined; });
  }
  return channelPromise;
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
  channelPromise = undefined;
  if (!activeConnection) return;
  try {
    await activeConnection.close();
  } catch (error) {
    if (error?.name !== 'IllegalOperationError') throw error;
  }
}

module.exports = {
  EXCHANGE, ROUTING_KEY, QUEUE, RETRY_EXCHANGE, RETRY_QUEUE, DLX, DLQ_ROUTING_KEY, DLQ,
  declararTopologia, getChannel, publishEntradaComprada, closeRabbit
};
