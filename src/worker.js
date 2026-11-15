require('dotenv').config();
// Antes de cargar el logger: el nombre del servicio sale en cada línea de log.
process.env.SERVICE_NAME = 'worker';
const { getChannel, consumirEntradaComprada, closeRabbit, QUEUE } = require('./lib/rabbit');
const { retryConfig, plazosConfig } = require('./lib/config');
const { crearManejador } = require('./lib/consumidor');
const { iniciarBarrido } = require('./lib/barrido');
const { emitirEntradasDeCompra } = require('./services/emision');
const { connectDb, closeDb } = require('./db');
const { logger } = require('./lib/logger');
const { integerFromEnv } = require('./lib/config');
const { iniciarServidorMetricas } = require('./lib/servidorMetricas');

// Consumidor de `entrada.comprada` (ADR 0005), que emite las entradas de cada compra pagada, y
// barrido periódico (ADR 0010 y 0011): vencimientos, conciliación de pagos, cierre de eventos,
// cascada de cancelaciones y reconciliación de cupo.
let cerrando = false;
let consumidor;
let detenerBarrido = async () => {};
let enCurso = Promise.resolve();
let servidorMetricas;

async function startWorker() {
  // Falla al arrancar si RETRY_DELAY_MS o MAX_RETRIES son inválidos, en vez de descubrirlo en el primer reintento.
  const { retryDelayMs, maxRetries } = retryConfig();
  const { barridoIntervaloMs, eventoFinalizaTrasHoras } = plazosConfig();

  await connectDb();
  const channel = await getChannel();
  // Sin conexión al broker el worker no sirve: sale con error y Compose lo reinicia. Un mensaje
  // sin confirmar vuelve a la cola cuando el canal se cierra.
  channel.on('close', () => {
    if (cerrando) return;
    logger.error('Se perdió la conexión con RabbitMQ; el worker se reinicia');
    process.exit(1);
  });

  const manejar = crearManejador({
    procesar: (evento) => emitirEntradasDeCompra(evento),
    maxRetries,
    retryDelayMs,
    alFallarEnrutamiento: () => process.exit(1)
  });
  // Con prefetch(1) hay a lo sumo un mensaje en curso: se guarda su promesa para esperarlo al apagar.
  consumidor = await consumirEntradaComprada((canal, msg) => { enCurso = manejar(canal, msg); });
  detenerBarrido = iniciarBarrido({ intervaloMs: barridoIntervaloMs, eventoFinalizaTrasHoras });
  const metricsPort = integerFromEnv('METRICS_PORT', 9464, { min: 1, max: 65535 });
  servidorMetricas = await iniciarServidorMetricas({ port: metricsPort });
  logger.info({ cola: QUEUE, maxRetries, retryDelayMs, barridoIntervaloMs, eventoFinalizaTrasHoras, metricsPort }, 'Worker listo');
}

async function detener() {
  cerrando = true;
  // Se deja de recibir mensajes nuevos; el que está en curso termina antes de cerrar (prefetch 1).
  await consumidor?.detener().catch(() => {});
  await enCurso;
  await detenerBarrido();
  await closeRabbit();
  await closeDb();
  await new Promise((resolve) => (servidorMetricas ? servidorMetricas.close(resolve) : resolve()));
}

if (require.main === module) {
  startWorker().catch((error) => { logger.error({ err: error }, 'No se pudo iniciar el worker'); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => { await detener(); process.exit(0); });
  }
}

module.exports = { startWorker, detener };
