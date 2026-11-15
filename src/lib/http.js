const { sendError } = require('./errors');

const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

// Express 4 no captura el rechazo de un handler async: sin esto, una excepción deja la
// solicitud colgada. Aquí se deriva al manejador de errores de la app (500 INTERNAL_ERROR).
const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// Middleware para rutas con un id en la URL: un ObjectId mal formado es 400 INVALID_ID
// y nunca llega a MongoDB (donde sería un CastError).
function validarId(parametro = 'id') {
  return (req, res, next) => {
    if (!OBJECT_ID.test(req.params[parametro])) {
      return sendError(res, 400, 'Identificador inválido', 'INVALID_ID', false, 'Enviar un ObjectId de 24 caracteres hexadecimales');
    }
    return next();
  };
}

module.exports = { asyncHandler, validarId, OBJECT_ID };
