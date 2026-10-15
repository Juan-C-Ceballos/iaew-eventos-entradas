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

module.exports = { solicitarPago, presentarCompra };
