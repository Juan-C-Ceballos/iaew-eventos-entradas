require('dotenv').config();
const { getChannel, consumirEntradaComprada, closeRabbit, QUEUE } = require('./lib/rabbit');
const { retryConfig, plazosConfig } = require('./lib/config');
const { crearManejador } = require('./lib/consumidor');
const { emitirEntradasDeCompra } = require('./services/emision');
const { connectDb, closeDb } = require('./db');

// Consumidor de `entrada.comprada` (ADR 0005): emite las entradas de cada compra pagada. El barrido
// periódico (vencimientos, conciliación de pagos y reconciliación de cupo) se suma en la Fase 6.
let cerrando = false;
let consumidor;
let enCurso = Promise.resolve();

async function startWorker() {
  // Falla al arrancar si RETRY_DELAY_MS o MAX_RETRIES son inválidos, en vez de descubrirlo en el primer reintento.
  const { retryDelayMs, maxRetries } = retryConfig();
  const { barridoIntervaloMs } = plazosConfig();

  await connectDb();
  const channel = await getChannel();
  // Sin conexión al broker el worker no sirve: sale con error y Compose lo reinicia. Un mensaje
  // sin confirmar vuelve a la cola cuando el canal se cierra.
  channel.on('close', () => {
    if (cerrando) return;
    console.error('Se perdió la conexión con RabbitMQ; el worker se reinicia');
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
  console.log(`Worker listo: consumiendo ${QUEUE} (reintentos: ${maxRetries} cada ${retryDelayMs} ms; barrido cada ${barridoIntervaloMs} ms, a partir de la Fase 6)`);
}

async function detener() {
  cerrando = true;
  // Se deja de recibir mensajes nuevos; el que está en curso termina antes de cerrar (prefetch 1).
  await consumidor?.detener().catch(() => {});
  await enCurso;
  await closeRabbit();
  await closeDb();
}

if (require.main === module) {
  startWorker().catch((error) => { console.error('No se pudo iniciar el worker:', error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => { await detener(); process.exit(0); });
  }
}

module.exports = { startWorker, detener };
