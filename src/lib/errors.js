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

module.exports = { sendError, ApiError, errorDeValidacion, manejarApiError };
