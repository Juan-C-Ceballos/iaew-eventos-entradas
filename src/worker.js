require('dotenv').config();
const { getChannel, closeRabbit, QUEUE } = require('./lib/rabbit');
const { retryConfig, plazosConfig } = require('./lib/config');

// Esqueleto de Entrega 1: declara la topología (exchange, cola, retry y DLQ) pero
// todavía no consume. El consumo idempotente de entrada.comprada llega en la Entrega 2.
let cerrando = false;

async function startWorker() {
  // Falla al arrancar si RETRY_DELAY_MS o MAX_RETRIES son inválidos, en vez de descubrirlo en el primer reintento.
  const { retryDelayMs, maxRetries } = retryConfig();
  const { barridoIntervaloMs } = plazosConfig();
  const channel = await getChannel();
  // Sin conexión al broker el worker no sirve: sale con error y Compose lo reinicia.
  channel.on('close', () => {
    if (cerrando) return;
    console.error('Se perdió la conexión con RabbitMQ; el worker se reinicia');
    process.exit(1);
  });
  console.log(`Worker listo: topología declarada; cola ${QUEUE} sin consumidor hasta la Entrega 2 (reintentos: ${maxRetries} cada ${retryDelayMs} ms; barrido cada ${barridoIntervaloMs} ms, a partir de la Entrega 2)`);
}

if (require.main === module) {
  startWorker().catch((error) => { console.error('No se pudo iniciar el worker:', error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => { cerrando = true; await closeRabbit(); process.exit(0); });
  }
}

module.exports = { startWorker };
