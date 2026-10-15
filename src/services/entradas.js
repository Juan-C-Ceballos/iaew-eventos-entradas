const EntradaModel = require('../models/Entrada');
const EventoModel = require('../models/Evento');
const { ApiError } = require('../lib/errors');
const { logger } = require('../lib/logger');
const metricas = require('../lib/metricas');

const FORMATO_CODIGO = /^ENT-[A-Z0-9]{12}$/;

const noEncontrada = () => new ApiError({
  status: 404, error: 'Entrada inexistente', code: 'TICKET_NOT_FOUND', action: 'Verificar el código de la entrada'
});

const conflicto = (error, code, details) => new ApiError({ status: 409, error, code, action: 'Denegar el acceso', details });

function presentarEntrada(entrada) {
  const { __v, ...resto } = entrada;
  return resto;
}

// Un código con otro formato no puede existir: se responde 404 sin consultar la base.
async function buscar(codigo, Entrada) {
  if (!FORMATO_CODIGO.test(codigo)) throw noEncontrada();
  const entrada = await Entrada.findOne({ codigo }).lean();
  if (!entrada) throw noEncontrada();
  return entrada;
}

async function obtener(codigo, { Entrada = EntradaModel } = {}) {
  return presentarEntrada(await buscar(codigo, Entrada));
}

// Cada rechazo se cuenta en `validaciones_total{resultado}` (ADR 0008).
const RESULTADO_POR_CODIGO = {
  TICKET_NOT_FOUND: 'inexistente', TICKET_WRONG_EVENT: 'otro_evento', EVENT_NOT_ACTIVE: 'evento_inactivo',
  TICKET_ALREADY_USED: 'ya_usada', TICKET_VOIDED: 'anulada'
};

// Control de acceso en la puerta (ADR 0012). Orden de las comprobaciones:
//   1. la entrada existe;                                     → 404 TICKET_NOT_FOUND
//   2. es del evento de la puerta;                            → 409 TICKET_WRONG_EVENT
//   3. el evento está publicado;                              → 409 EVENT_NOT_ACTIVE
//   4. transición atómica emitida → usada, que registra quién y cuándo la validó.
// Dos puertas que validan la misma entrada a la vez compiten por el paso 4: gana una sola y la
// otra recibe 409 TICKET_ALREADY_USED, así que una entrada no entra dos veces.
async function validar(codigo, solicitud, identidad, dependencias = {}) {
  try {
    const respuesta = await validarEntrada(codigo, solicitud, identidad, dependencias);
    metricas.validaciones.inc({ resultado: 'acceso_permitido' });
    logger.info({ entrada: codigo.slice(-4), eventoId: solicitud.eventoId, cliente: identidad.cliente }, 'Acceso permitido');
    return respuesta;
  } catch (error) {
    const resultado = RESULTADO_POR_CODIGO[error.code];
    if (resultado) {
      metricas.validaciones.inc({ resultado });
      logger.warn({ entrada: codigo.slice(-4), eventoId: solicitud.eventoId, cliente: identidad.cliente, resultado }, 'Acceso denegado');
    }
    throw error;
  }
}

async function validarEntrada(codigo, { eventoId }, { cliente }, { Entrada = EntradaModel, Evento = EventoModel, ahora = new Date() }) {
  const entrada = await buscar(codigo, Entrada);

  if (String(entrada.eventoId) !== eventoId.toLowerCase()) {
    throw conflicto('La entrada pertenece a otro evento', 'TICKET_WRONG_EVENT', { eventoEntrada: String(entrada.eventoId) });
  }

  const evento = await Evento.findById(entrada.eventoId).select('estado').lean();
  if (evento?.estado !== 'publicado') {
    throw conflicto('El evento no admite ingresos', 'EVENT_NOT_ACTIVE', { estado: evento?.estado ?? 'inexistente' });
  }

  const usada = await Entrada.findOneAndUpdate(
    { codigo, estado: 'emitida' },
    { $set: { estado: 'usada', usadaEn: ahora, validadaPor: cliente } },
    { new: true }
  ).lean();
  if (usada) return { resultado: 'acceso_permitido', entrada: presentarEntrada(usada) };

  // No estaba emitida: se informa por qué (usada o anulada) según su estado actual.
  const actual = await buscar(codigo, Entrada);
  if (actual.estado === 'usada') {
    throw conflicto('La entrada ya fue utilizada', 'TICKET_ALREADY_USED', { usadaEn: actual.usadaEn?.toISOString() });
  }
  throw conflicto('La entrada fue anulada', 'TICKET_VOIDED');
}

module.exports = { obtener, validar, presentarEntrada };
