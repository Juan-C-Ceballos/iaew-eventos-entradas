const crypto = require('node:crypto');
const { sendError } = require('../lib/errors');

// Compara en tiempo constante: se hashean ambos valores para que tengan la misma longitud.
function clavesIguales(recibida, esperada) {
  const hash = (valor) => crypto.createHash('sha256').update(String(valor)).digest();
  return crypto.timingSafeEqual(hash(recibida), hash(esperada));
}

function requireApiKey(req, res, next) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) return sendError(res, 500, 'API key interna no configurada', 'API_KEY_NOT_CONFIGURED', false, 'Configurar INTERNAL_API_KEY en el servidor');
  const recibida = req.header('x-api-key');
  if (!recibida || !clavesIguales(recibida, expected)) {
    return sendError(res, 401, 'API key inválida o ausente', 'API_KEY_INVALID', false, 'Enviar una x-api-key válida');
  }
  next();
}

module.exports = { requireApiKey };
