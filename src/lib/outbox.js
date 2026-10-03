const Compra = require('../models/Compra');
const { publishEntradaComprada } = require('./rabbit');

// Patrón outbox (ADR 0009): el webhook persiste `estado: pagada` y `emisionEvento` en una
// sola escritura; este relay publica los eventos pendientes y los marca como publicados.
const repositorioMongo = {
  buscarPendientes: (limite) => Compra.find({
    estado: 'pagada',
    emisionEvento: { $exists: true },
    emisionPublicadaEn: null
  }).sort({ updatedAt: 1 }).limit(limite).select('emisionEvento').lean(),
  marcarPublicada: (compraId) => Compra.updateOne(
    { _id: compraId, emisionPublicadaEn: null },
    { $set: { emisionPublicadaEn: new Date() } }
  )
};

// Publica en orden y se detiene en el primer fallo: si el broker está caído, el resto
// queda pendiente para la próxima pasada. Un fallo entre publicar y marcar provoca una
// republicación del mismo eventId, que el consumidor deduplica.
async function publicarPendientes({ repositorio = repositorioMongo, publish = publishEntradaComprada, limite = 50 } = {}) {
  const pendientes = await repositorio.buscarPendientes(limite);
  let publicados = 0;
  for (const compra of pendientes) {
    await publish(compra.emisionEvento);
    await repositorio.marcarPublicada(compra._id);
    publicados += 1;
  }
  return publicados;
}

function iniciarRelay({ intervaloMs, ...opciones }) {
  let enCurso = false;
  const timer = setInterval(async () => {
    if (enCurso) return;
    enCurso = true;
    try {
      const publicados = await publicarPendientes(opciones);
      if (publicados > 0) console.log(`Outbox: ${publicados} evento(s) entrada.comprada publicados`);
    } catch (error) {
      console.error('Outbox: publicación pendiente, se reintenta en la próxima pasada:', error.message);
    } finally {
      enCurso = false;
    }
  }, intervaloMs);
  return () => clearInterval(timer);
}

module.exports = { publicarPendientes, iniciarRelay };
