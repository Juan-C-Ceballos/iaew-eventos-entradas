const pino = require('pino');
const { actual } = require('./contexto');

// Logs JSON, una línea por evento, con el servicio, la hora ISO y el correlation id de la
// operación en curso (ADR 0008). Nunca se registran tokens, secretos ni datos personales: los
// campos sensibles se redactan por si alguien los agrega por error.
const CAMPOS_SENSIBLES = [
  'authorization', '*.authorization', 'headers.authorization',
  'secret', '*.secret', 'password', '*.password', 'token', '*.token', '*.accessToken',
  'apiKey', '*.apiKey', 'email', '*.email', 'documento', '*.documento', 'asistente'
];

function crearLogger({
  service = process.env.SERVICE_NAME || 'api',
  // Bajo `node --test` los logs de la aplicación se silencian para no mezclarse con el reporte.
  level = process.env.LOG_LEVEL || (process.env.NODE_TEST_CONTEXT ? 'silent' : 'info'),
  destination
} = {}) {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Una copia: pino mezcla los campos de cada llamada dentro del objeto que devuelve el mixin, y
    // sin copiar, lo que se registra en una línea se filtraría al contexto y a las líneas siguientes.
    mixin: () => ({ ...actual() }),
    redact: { paths: CAMPOS_SENSIBLES, censor: '[redactado]' }
  }, destination);
}

const logger = crearLogger();

// Interfaz tipo `console` (`log`, `warn`, `error`) para los módulos que reciben un `log`
// inyectable: los tests pasan uno propio y en producción escribe en este logger.
function comoConsola(destino = logger) {
  return {
    log: (mensaje, campos = {}) => destino.info(campos, mensaje),
    warn: (mensaje, campos = {}) => destino.warn(campos, mensaje),
    error: (mensaje, campos = {}) => destino.error(campos, mensaje)
  };
}

module.exports = { logger, crearLogger, comoConsola };
