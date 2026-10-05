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

// Una pasada del relay. Un fallo se registra una sola vez y no en cada pasada (con RabbitMQ
// caído serían miles de líneas iguales): se vuelve a registrar solo si el error cambia, y se
// avisa cuando la pasada vuelve a completarse sin errores.
function crearPasada({ log = console, ...opciones } = {}) {
  let ultimoError = null;
  let enCurso = false;
  return async function pasada() {
    if (enCurso) return;
    enCurso = true;
    try {
      const publicados = await publicarPendientes(opciones);
      if (ultimoError !== null) {
        log.log('Outbox: la publicación se restableció');
        ultimoError = null;
      }
      if (publicados > 0) log.log(`Outbox: ${publicados} evento(s) entrada.comprada publicados`);
    } catch (error) {
      if (error.message !== ultimoError) {
        log.error(`Outbox: publicación pendiente, se reintenta en cada pasada (sin repetir este aviso): ${error.message}`);
        ultimoError = error.message;
      }
    } finally {
      enCurso = false;
    }
  };
}

function iniciarRelay({ intervaloMs, ...opciones }) {
  const timer = setInterval(crearPasada(opciones), intervaloMs);
  return () => clearInterval(timer);
}

module.exports = { publicarPendientes, crearPasada, iniciarRelay };
