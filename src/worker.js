require('dotenv').config();
const { getChannel, closeRabbit, QUEUE } = require('./lib/rabbit');

// Esqueleto de Entrega 1: declara la topología (exchange, cola, retry y DLQ) pero
// todavía no consume. El consumo idempotente de entrada.comprada llega en la Entrega 2.
let cerrando = false;

async function startWorker() {
  const channel = await getChannel();
  // Sin conexión al broker el worker no sirve: sale con error y Compose lo reinicia.
  channel.on('close', () => {
    if (cerrando) return;
    console.error('Se perdió la conexión con RabbitMQ; el worker se reinicia');
    process.exit(1);
  });
  console.log(`Worker listo: topología declarada; cola ${QUEUE} sin consumidor hasta la Entrega 2`);
}

if (require.main === module) {
  startWorker().catch((error) => { console.error('No se pudo iniciar el worker:', error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => { cerrando = true; await closeRabbit(); process.exit(0); });
  }
}

module.exports = { startWorker };
