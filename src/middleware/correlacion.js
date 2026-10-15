const crypto = require('node:crypto');

// Correlation ID (ADR 0008): se respeta el X-Correlation-Id de la solicitud si tiene un formato
// válido; si no, se genera un UUID v4. Se devuelve siempre en la respuesta y viaja a la pasarela,
// al evento y a los logs, para seguir una operación de punta a punta.
const VALIDO = /^[A-Za-z0-9._:-]{1,128}$/;

function correlacion(req, res, next) {
  const recibido = req.header('X-Correlation-Id');
  req.correlationId = recibido && VALIDO.test(recibido) ? recibido : crypto.randomUUID();
  res.set('X-Correlation-Id', req.correlationId);
  next();
}

module.exports = { correlacion };
