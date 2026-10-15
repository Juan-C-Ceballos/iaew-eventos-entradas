const CompraModel = require('../models/Compra');
const EventoModel = require('../models/Evento');
const EntradaModel = require('../models/Entrada');
const EventoProcesadoModel = require('../models/EventoProcesado');
const { generarCodigoEntrada } = require('../lib/codigoEntrada');
const { ErrorPermanente } = require('../lib/consumidor');

const CLAVE_DUPLICADA = 11000;
const MAX_CODIGOS = 5;

// Crea la entrada `numero` de la compra si todavía no existe. El upsert por (compraId, numero)
// hace que emitir dos veces la misma compra no duplique entradas, ni siquiera con dos workers a
// la vez. Solo un choque de `codigo` (probabilidad despreciable) obliga a generar otro.
async function emitirEntrada(Entrada, datos, ahora) {
  for (let intento = 0; intento < MAX_CODIGOS; intento += 1) {
    try {
      await Entrada.updateOne(
        { compraId: datos.compraId, numero: datos.numero },
        { $setOnInsert: { ...datos, codigo: generarCodigoEntrada(), emitidaEn: ahora } },
        { upsert: true }
      );
      return;
    } catch (error) {
      if (error.code !== CLAVE_DUPLICADA) throw error;
      // (compraId, numero) duplicado: otro proceso la creó entre medio, está emitida.
      if (error.keyPattern?.codigo === undefined) return;
    }
  }
  throw new Error(`No se pudo generar un código de entrada único para la compra ${datos.compraId}`);
}

// Consume `entrada.comprada` (ADR 0005 y 0012): emite una Entrada por unidad comprada, con el
// titular copiado del snapshot de la compra, y marca la compra como emitida.
//
// Es idempotente por construcción. El orden importa: primero el trabajo, que se puede repetir sin
// efectos dobles, y al final se registra el `eventId` en `eventos_procesados`. Registrarlo antes
// perdería el mensaje si el proceso muriera entre las dos escrituras: el reintento lo vería como
// duplicado y las entradas no se emitirían nunca.
//
// Devuelve `{ resultado: 'emitidas' | 'duplicado', cantidad? }`. Un `ErrorPermanente` indica que
// reintentar no sirve (la compra no existe o no está pagada).
async function emitirEntradasDeCompra(evento, dependencias = {}) {
  const {
    Compra = CompraModel, Evento = EventoModel, Entrada = EntradaModel, EventoProcesado = EventoProcesadoModel,
    ahora = new Date()
  } = dependencias;

  if (await EventoProcesado.exists({ eventId: evento.eventId })) return { resultado: 'duplicado' };

  const compra = await Compra.findById(evento.data.compraId).lean();
  if (!compra) throw new ErrorPermanente(`La compra ${evento.data.compraId} no existe`, 'compra_not_found');
  if (compra.estado !== 'pagada') {
    throw new ErrorPermanente(`La compra ${compra._id} no está pagada (estado ${compra.estado})`, 'compra_not_paid');
  }

  // Un evento cancelado mientras la emisión estaba en curso: las entradas nacen anuladas (ADR 0011).
  // Si se cancela justo después de esta lectura, la cascada del barrido las anula.
  const eventoDeLaCompra = await Evento.findById(compra.eventoId).select('estado').lean();
  const estado = eventoDeLaCompra?.estado === 'cancelado' ? 'anulada' : 'emitida';

  for (let numero = 1; numero <= compra.cantidad; numero += 1) {
    await emitirEntrada(Entrada, {
      compraId: compra._id, eventoId: compra.eventoId, asistenteId: compra.asistenteId,
      titular: { nombre: compra.asistente.nombre, documento: compra.asistente.documento },
      numero, estado
    }, ahora);
  }

  await Compra.updateOne({ _id: compra._id, emisionEstado: { $ne: 'emitida' } }, { $set: { emisionEstado: 'emitida', emitidaEn: ahora } });

  try {
    await EventoProcesado.create({ eventId: evento.eventId, type: evento.type, compraId: compra._id });
  } catch (error) {
    if (error.code !== CLAVE_DUPLICADA) throw error; // otro worker ya lo registró: mismo resultado
  }
  return { resultado: 'emitidas', cantidad: compra.cantidad };
}

module.exports = { emitirEntradasDeCompra };
