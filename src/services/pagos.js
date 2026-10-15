const crypto = require('node:crypto');
const CompraModel = require('../models/Compra');
const EventoModel = require('../models/Evento');
const { ApiError } = require('../lib/errors');
const { plazosConfig } = require('../lib/config');
const { solicitarCobro } = require('../lib/pasarela');
const { expirarReserva, presentarCompra, deCliente, compraNoEncontrada } = require('./compras');

const CLAVE_DUPLICADA = 11000;
const MAX_INTENTOS = 3;

const estadoInvalido = (estado) => new ApiError({
  status: 409, error: `Solo se puede pagar una compra pendiente (estado actual: ${estado})`, code: 'PURCHASE_INVALID_STATE',
  action: 'Consultar el estado con GET /compras/{id}', details: { estado }
});

// Paso 2 del flujo (ADR 0010): primero se persiste, después se llama a la pasarela. Si fuera al
// revés, un webhook rápido encontraría la compra todavía en `pendiente`. Devuelve
// `{ compra, replayed }`; la ruta responde 202 porque el resultado llega por webhook.
async function solicitarPago(id, { escenario = 'aprobado' } = {}, { clave, cliente, correlationId }, dependencias = {}) {
  const {
    Compra = CompraModel, Evento = EventoModel, ahora = new Date(),
    pagoTimeoutMinutos = plazosConfig().pagoTimeoutMinutos, cobrar = solicitarCobro
  } = dependencias;

  // Pide el cobro y guarda la referencia que devuelve la pasarela. Si el webhook llegó antes y ya
  // la guardó, no se pisa. Un fallo de la pasarela deja la compra en `pago_pendiente`: un timeout
  // es ambiguo y volver a `pendiente` permitiría un doble cobro.
  async function pedirCobro(compra, replayed) {
    const { referenciaExterna } = await cobrar({ compraId: compra._id, monto: compra.total, escenario, correlationId });
    await Compra.updateOne({ _id: compra._id, 'pago.referenciaExterna': { $exists: false } }, { $set: { 'pago.referenciaExterna': referenciaExterna } });
    return { compra: await Compra.findOne(deCliente(id, cliente)).lean(), replayed };
  }

  for (let intento = 0; intento < MAX_INTENTOS; intento += 1) {
    const compra = await Compra.findOne(deCliente(id, cliente)).lean();
    if (!compra) throw compraNoEncontrada();

    // Reintento de un pago ya iniciado con esta misma clave.
    if (compra.pago?.idempotencyKey === clave) {
      if (compra.pago.referenciaExterna) return { compra, replayed: true };
      if (compra.estado === 'pago_pendiente') return pedirCobro(compra, true);
    }
    if (compra.estado !== 'pendiente') throw estadoInvalido(compra.estado);

    if (compra.reservaExpiraEn <= ahora) {
      await expirarReserva(compra._id, { Compra, Evento, ahora });
      throw new ApiError({
        status: 409, error: 'La reserva venció y el cupo fue liberado', code: 'RESERVATION_EXPIRED', action: 'Crear una nueva compra'
      });
    }

    let iniciada;
    try {
      iniciada = await Compra.findOneAndUpdate(
        { ...deCliente(id, cliente), estado: 'pendiente', reservaExpiraEn: { $gt: ahora } },
        {
          $set: {
            estado: 'pago_pendiente',
            pagoExpiraEn: new Date(ahora.getTime() + pagoTimeoutMinutos * 60 * 1000),
            pago: { estado: 'pendiente', idempotencyKey: clave, solicitadoEn: ahora }
          }
        },
        { new: true }
      ).lean();
    } catch (error) {
      // El índice único (creadaPor, pago.idempotencyKey) indica que la clave ya pagó otra compra.
      if (error.code === CLAVE_DUPLICADA) {
        throw new ApiError({
          status: 409, error: 'La Idempotency-Key ya se usó en otra compra', code: 'IDEMPOTENCY_KEY_MISMATCH',
          action: 'Generar una nueva clave para una intención distinta'
        });
      }
      throw error;
    }
    if (iniciada) return pedirCobro(iniciada, false);
    // Otro request cambió la compra entre la lectura y la transición: se vuelve a leer.
  }
  throw new ApiError({
    status: 409, error: 'La compra se modificó mientras se procesaba la solicitud', code: 'CONCURRENT_UPDATE',
    action: 'Reintentar la solicitud', retryable: true
  });
}

// Estados desde los que un pago aprobado ya no tiene a quién acreditarse (ADR 0010).
const RESUELTAS_SIN_PAGO = ['expirada', 'rechazada', 'cancelada'];

// Paso 3 del flujo (ADR 0006 y 0009), compartido por el webhook y la conciliación del barrido.
// Un único findOneAndUpdate condicional (`pago_pendiente → pagada`) guarda el estado y el sobre
// de `entrada.comprada` (outbox): el relay lo publica después, sin que el webhook toque RabbitMQ.
// Devuelve `{ resultado, compra }` con resultado `aplicado`, `duplicado` (ya estaba pagada) o
// `conflicto` (el estado actual no admite el pago).
async function registrarPagoAprobado(compraId, { referenciaExterna, correlationId }, dependencias = {}) {
  const { Compra = CompraModel, Evento = EventoModel, ahora = new Date() } = dependencias;
  const compra = await Compra.findById(compraId).lean();
  if (!compra) throw compraNoEncontrada();

  // Un pago aprobado sobre un evento cancelado se acepta, pero no hay entrada utilizable: queda
  // marcado para reembolso (ADR 0011). Si el evento se cancela justo después de esta lectura, la
  // cascada del barrido marca la compra pagada.
  const evento = await Evento.findById(compra.eventoId).select('estado').lean();
  const set = {
    estado: 'pagada',
    'pago.estado': 'aprobado',
    'pago.procesadoEn': ahora,
    // El webhook puede llegar antes de que /pagar guarde la referencia: la de la pasarela manda.
    'pago.referenciaExterna': referenciaExterna,
    emisionEvento: {
      eventId: crypto.randomUUID(), type: 'entrada.comprada', version: 1,
      occurredAt: ahora.toISOString(), correlationId, data: { compraId: String(compra._id) }
    },
    emisionEstado: 'pendiente'
  };
  if (evento?.estado === 'cancelado') set.reembolsoPendiente = true;

  const pagada = await Compra.findOneAndUpdate({ _id: compra._id, estado: 'pago_pendiente' }, { $set: set }, { new: true }).lean();
  if (pagada) return { resultado: 'aplicado', compra: pagada };

  const actual = await Compra.findById(compra._id).lean();
  if (actual.estado === 'pagada') return { resultado: 'duplicado', compra: actual };
  if (RESUELTAS_SIN_PAGO.includes(actual.estado)) {
    // Cobrado sin entrada: el único caso residual del ADR 0010. No hay reembolso real, solo la marca.
    await Compra.updateOne({ _id: compra._id, estado: actual.estado, reembolsoPendiente: { $ne: true } }, { $set: { reembolsoPendiente: true } });
    console.error(`Pago aprobado sobre la compra ${compra._id} en estado ${actual.estado}: cobrado sin entrada, queda reembolsoPendiente`);
  }
  return { resultado: 'conflicto', compra: actual };
}

// `pago_pendiente → rechazada` y devolución del cupo. Solo quien gana la transición libera el cupo.
async function registrarPagoRechazado(compraId, { referenciaExterna, motivo }, dependencias = {}) {
  const { Compra = CompraModel, Evento = EventoModel, ahora = new Date() } = dependencias;
  const compra = await Compra.findById(compraId).lean();
  if (!compra) throw compraNoEncontrada();

  const set = { estado: 'rechazada', 'pago.estado': 'rechazado', 'pago.procesadoEn': ahora, 'pago.referenciaExterna': referenciaExterna };
  if (motivo !== undefined) set['pago.motivoRechazo'] = motivo;
  const rechazada = await Compra.findOneAndUpdate({ _id: compra._id, estado: 'pago_pendiente' }, { $set: set }, { new: true }).lean();
  if (rechazada) {
    await Evento.updateOne({ _id: rechazada.eventoId }, { $inc: { cupoDisponible: rechazada.cantidad } });
    return { resultado: 'aplicado', compra: rechazada };
  }

  const actual = await Compra.findById(compra._id).lean();
  return { resultado: actual.estado === 'rechazada' ? 'duplicado' : 'conflicto', compra: actual };
}

// Procesa una notificación del webhook ya autenticada y validada. Devuelve el cuerpo del ACK
// (WebhookAck) o lanza 409 si la notificación contradice el estado de la compra.
async function procesarNotificacionPago(notificacion, { correlationId }, dependencias = {}) {
  const { compraId, referenciaExterna, motivo } = notificacion.data;
  const { resultado, compra } = notificacion.type === 'pago.aprobado'
    ? await registrarPagoAprobado(compraId, { referenciaExterna, correlationId }, dependencias)
    : await registrarPagoRechazado(compraId, { referenciaExterna, motivo }, dependencias);

  if (resultado === 'conflicto') {
    throw new ApiError({
      status: 409, error: `La notificación ${notificacion.type} contradice el estado de la compra (${compra.estado})`,
      code: 'PURCHASE_INVALID_STATE', action: 'Consultar el estado con GET /compras/{id}', details: { estado: compra.estado }
    });
  }
  return { recibido: true, duplicado: resultado === 'duplicado', compraId: String(compra._id), estadoCompra: compra.estado };
}

module.exports = { solicitarPago, registrarPagoAprobado, registrarPagoRechazado, procesarNotificacionPago, presentarCompra };
