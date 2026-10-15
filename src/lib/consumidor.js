const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const rabbit = require('./rabbit');
const esquema = require('../../docs/eventos/entrada-comprada.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validarEntradaComprada = ajv.compile(esquema);

// Un error que reintentar no arregla (el mensaje no cumple el contrato, la compra no existe):
// va directo a la DLQ en lugar de agotar los reintentos. Cualquier otro error es transitorio.
class ErrorPermanente extends Error {
  constructor(mensaje, razon) {
    super(mensaje);
    this.name = 'ErrorPermanente';
    this.razon = razon;
  }
}

// Crea el manejador de mensajes de `emision.entrada-comprada` (ADR 0005). Por cada mensaje:
//   - procesado: se confirma (ack) DESPUÉS de que `procesar` persistió el resultado;
//   - error transitorio: se republica en la cola de retry con x-retry-count + 1 y se confirma el
//     original, hasta `maxRetries`; agotados, va a la DLQ;
//   - error permanente, JSON inválido o contrato inválido: directo a la DLQ.
// Nunca se usa nack con requeue. Si no se puede ni reencolar ni derivar el mensaje, NO se
// confirma (se perdería) y se llama a `alFallarEnrutamiento`: el worker sale y, al cerrarse el
// canal, RabbitMQ devuelve el mensaje a la cola.
function crearManejador({
  procesar, maxRetries, retryDelayMs, log = console, alFallarEnrutamiento = () => {},
  broker = { publicarReintento: rabbit.publicarReintento, publicarEnDlq: rabbit.publicarEnDlq }
}) {
  async function derivarADlq(canal, msg, reason, error) {
    await broker.publicarEnDlq(canal, msg, { reason, error });
    canal.ack(msg);
    log.error(`Mensaje a la DLQ (${reason}): ${error?.message ?? error} messageId=${msg.properties.messageId}`);
  }

  async function reintentarOAgotar(canal, msg, error) {
    if (rabbit.intentosDe(msg) < maxRetries) {
      const intento = await broker.publicarReintento(canal, msg, { retryDelayMs, error });
      canal.ack(msg);
      log.warn?.(`Reintento ${intento}/${maxRetries} en ${retryDelayMs} ms: ${error.message} messageId=${msg.properties.messageId}`);
      return;
    }
    await derivarADlq(canal, msg, 'max_retries_exceeded', error);
  }

  return async function manejar(canal, msg) {
    try {
      let evento;
      try {
        evento = JSON.parse(msg.content.toString('utf8'));
      } catch (error) {
        return await derivarADlq(canal, msg, 'invalid_json', error);
      }
      if (!validarEntradaComprada(evento)) {
        return await derivarADlq(canal, msg, 'contract_invalid', new Error(ajv.errorsText(validarEntradaComprada.errors)));
      }

      try {
        const resultado = await procesar(evento);
        canal.ack(msg);
        log.log(`entrada.comprada procesado (${resultado?.resultado ?? 'ok'}) eventId=${evento.eventId} correlationId=${evento.correlationId}`);
        return undefined;
      } catch (error) {
        if (error instanceof ErrorPermanente) return await derivarADlq(canal, msg, error.razon, error);
        return await reintentarOAgotar(canal, msg, error);
      }
    } catch (falla) {
      // No se pudo confirmar ni derivar: el mensaje queda sin ack para que vuelva a la cola.
      log.error(`No se pudo reencolar ni derivar el mensaje ${msg.properties.messageId}: ${falla.message}`);
      alFallarEnrutamiento(falla);
      return undefined;
    }
  };
}

module.exports = { crearManejador, ErrorPermanente, validarEntradaComprada };
