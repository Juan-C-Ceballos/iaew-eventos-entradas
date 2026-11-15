const crypto = require('node:crypto');
const { ApiError } = require('./errors');

// Idempotency-Key (ADR 0007 y 0012): 8 a 128 caracteres de [A-Za-z0-9._:-]. La unicidad es por
// cliente y la garantiza un índice único en MongoDB; aquí solo se valida el formato y se calcula
// la huella del cuerpo para detectar una clave reutilizada con otros datos.
const CLAVE = /^[A-Za-z0-9._:-]{8,128}$/;

function leerClave(valor) {
  if (valor === undefined || valor === '') {
    throw new ApiError({
      status: 400, error: 'Idempotency-Key requerida', code: 'IDEMPOTENCY_KEY_REQUIRED',
      action: 'Enviar una Idempotency-Key estable por intención de compra'
    });
  }
  if (!CLAVE.test(valor)) {
    throw new ApiError({
      status: 400, error: 'Idempotency-Key inválida', code: 'IDEMPOTENCY_KEY_INVALID',
      action: 'Usar entre 8 y 128 caracteres de A-Z, a-z, 0-9, punto, guion, guion bajo o dos puntos'
    });
  }
  return valor;
}

// Middleware: deja la clave validada en `req.idempotencyKey`.
function requerirIdempotencyKey(req, res, next) {
  try {
    req.idempotencyKey = leerClave(req.header('Idempotency-Key'));
    next();
  } catch (error) {
    next(error);
  }
}

// JSON con las claves ordenadas: el mismo cuerpo con otro orden de campos tiene la misma huella.
function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map((clave) => `${JSON.stringify(clave)}:${canonico(valor[clave])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

const huella = (cuerpo) => crypto.createHash('sha256').update(canonico(cuerpo ?? {})).digest('hex');

const claveReutilizada = () => new ApiError({
  status: 409, error: 'La Idempotency-Key ya se usó con otro cuerpo', code: 'IDEMPOTENCY_KEY_MISMATCH',
  action: 'Generar una nueva clave para una intención distinta'
});

module.exports = { leerClave, requerirIdempotencyKey, huella, claveReutilizada };
