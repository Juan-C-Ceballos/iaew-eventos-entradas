function sendError(res, status, error, code, retryable, action, details) {
  const body = { error, code, retryable, action };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

// Error de negocio con su respuesta HTTP. Los servicios lo lanzan y el manejador de errores de
// la app lo traduce con `sendError`, así la lógica no depende de `res`.
class ApiError extends Error {
  constructor({ status, error, code, action, retryable = false, details }) {
    super(error);
    this.name = 'ApiError';
    Object.assign(this, { status, code, action, retryable, details });
  }
}

const errorDeValidacion = (details, error = 'Datos inválidos') => new ApiError({
  status: 400, error, code: 'VALIDATION_ERROR', action: 'Corregir los campos indicados', details
});

function manejarApiError(err, req, res, next) {
  if (!(err instanceof ApiError)) return next(err);
  return sendError(res, err.status, err.message, err.code, err.retryable, err.action, err.details);
}

// Errores que indican que MongoDB no responde (caído, sin conexión o sin cola de espera): la
// solicitud es válida y se puede reintentar, así que se informa como 503 y no como 500.
const ERRORES_DE_BASE = ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNotConnectedError', 'MongoPoolClearedError'];

const esBaseNoDisponible = (err) => ERRORES_DE_BASE.includes(err?.name) || /buffering timed out/i.test(err?.message ?? '');

function manejarErrorDeBase(err, req, res, next) {
  if (!esBaseNoDisponible(err)) return next(err);
  console.error('Base de datos no disponible:', err.message);
  return sendError(res, 503, 'Base de datos no disponible', 'DATABASE_UNAVAILABLE', true, 'Reintentar la misma solicitud');
}

module.exports = { sendError, ApiError, errorDeValidacion, manejarApiError, esBaseNoDisponible, manejarErrorDeBase };
