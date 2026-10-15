const EventoModel = require('../models/Evento');
const CompraModel = require('../models/Compra');
const AsistenteModel = require('../models/Asistente');
const EntradaModel = require('../models/Entrada');
const { ApiError, errorDeValidacion } = require('../lib/errors');
const { huella, claveReutilizada } = require('../lib/idempotencia');
const { plazosConfig } = require('../lib/config');
const { OBJECT_ID } = require('../lib/http');

const { ESTADOS_COMPRA } = CompraModel;
const CLAVE_DUPLICADA = 11000;

const compraNoEncontrada = () => new ApiError({
  status: 404, error: 'Compra inexistente', code: 'PURCHASE_NOT_FOUND', action: 'Verificar el identificador'
});

// Una compra solo la ve y la opera el cliente que la creó: para el resto, no existe (404).
const deCliente = (id, cliente) => ({ _id: id, creadaPor: cliente });

// Lo que la API expone de una compra: sin la clave de idempotencia, su huella ni el sobre del
// outbox, que son detalles internos (el contrato no los declara).
function presentarCompra(compra) {
  if (!compra) return compra;
  const { idempotencyKey, idempotencyFingerprint, emisionEvento, emisionPublicadaEn, __v, pago, ...resto } = compra;
  if (!pago) return resto;
  const { idempotencyKey: clavePago, ...pagoPublico } = pago;
  return { ...resto, pago: pagoPublico };
}

function presentarEntrada(entrada) {
  const { __v, ...resto } = entrada;
  return resto;
}

const redondear = (valor) => Math.round(valor * 100) / 100;

// Por qué no se pudo reservar, en el orden del ADR 0011: inexistente, no publicado, ya
// comenzado y sin cupo. Es una lectura posterior al intento atómico, solo para explicar el rechazo.
async function motivoDelRechazo(eventoId, cantidad, ahora, Evento) {
  const evento = await Evento.findById(eventoId).lean();
  if (!evento) {
    return new ApiError({ status: 404, error: 'Evento inexistente', code: 'EVENT_NOT_FOUND', action: 'Verificar el identificador' });
  }
  if (evento.estado !== 'publicado') {
    return new ApiError({
      status: 409, error: 'El evento no admite compras', code: 'EVENT_NOT_PUBLISHED',
      action: 'Comprar solo eventos en estado publicado', details: { estado: evento.estado }
    });
  }
  if (evento.fecha <= ahora) {
    return new ApiError({
      status: 409, error: 'El evento ya comenzó y no admite compras', code: 'EVENT_ALREADY_STARTED',
      action: 'Elegir un evento futuro', details: { fecha: evento.fecha.toISOString() }
    });
  }
  return new ApiError({
    status: 409, error: 'No hay cupo suficiente para la cantidad solicitada', code: 'EVENT_SOLD_OUT',
    action: 'Reducir la cantidad o elegir otro evento',
    details: { eventoId: String(eventoId), cupoDisponible: evento.cupoDisponible, solicitado: cantidad }
  });
}

// Directorio de personas por DNI: guarda los últimos datos informados. Dos reservas
// simultáneas del mismo DNI pueden chocar en el índice único; la segunda actualiza el documento.
async function upsertAsistente(asistente, Asistente) {
  const operacion = () => Asistente.findOneAndUpdate(
    { documento: asistente.documento },
    { $set: { nombre: asistente.nombre, email: asistente.email } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
  try {
    return await operacion();
  } catch (error) {
    if (error.code !== CLAVE_DUPLICADA) throw error;
    return operacion();
  }
}

// Paso 1 del flujo (ADR 0007): reserva atómica de cupo y alta de la compra `pendiente`.
// `clave` es la Idempotency-Key y `cliente` el `sub` del token; la clave es única por cliente.
// Devuelve `{ compra, replayed }`.
async function reservar(datos, { clave, cliente }, dependencias = {}) {
  const {
    Evento = EventoModel, Compra = CompraModel, Asistente = AsistenteModel,
    ahora = new Date(), reservaTtlMinutos = plazosConfig().reservaTtlMinutos
  } = dependencias;
  const huellaActual = huella(datos);

  const repeticion = async () => {
    const existente = await Compra.findOne({ creadaPor: cliente, idempotencyKey: clave }).lean();
    if (!existente) return null;
    if (existente.idempotencyFingerprint !== huellaActual) throw claveReutilizada();
    return { compra: existente, replayed: true };
  };

  const previa = await repeticion();
  if (previa) return previa;

  // Un único documento y una única operación: no hay ventana entre verificar y descontar.
  const evento = await Evento.findOneAndUpdate(
    { _id: datos.eventoId, estado: 'publicado', fecha: { $gt: ahora }, cupoDisponible: { $gte: datos.cantidad } },
    { $inc: { cupoDisponible: -datos.cantidad } },
    { new: true }
  ).lean();
  if (!evento) throw await motivoDelRechazo(datos.eventoId, datos.cantidad, ahora, Evento);

  // Desde acá el cupo está descontado: cualquier fallo lo devuelve. Si el proceso muriera en el
  // medio, el reconciliador del barrido lo repone (ADR 0010).
  const devolverCupo = () => Evento.updateOne({ _id: evento._id }, { $inc: { cupoDisponible: datos.cantidad } });
  try {
    const asistente = await upsertAsistente(datos.asistente, Asistente);
    const creada = await Compra.create({
      eventoId: evento._id,
      asistenteId: asistente._id,
      asistente: datos.asistente,
      creadaPor: cliente,
      cantidad: datos.cantidad,
      precioUnitario: evento.precio,
      total: redondear(datos.cantidad * evento.precio),
      reservaExpiraEn: new Date(ahora.getTime() + reservaTtlMinutos * 60 * 1000),
      idempotencyKey: clave,
      idempotencyFingerprint: huellaActual
    });
    return { compra: creada.toObject(), replayed: false };
  } catch (error) {
    // Si la devolución también falla, se conserva el error original y el reconciliador repone el cupo.
    await devolverCupo().catch((falla) => console.error(`No se pudo devolver el cupo del evento ${evento._id}: ${falla.message}`));
    if (error.code === CLAVE_DUPLICADA) {
      // Otro request con la misma clave ganó la carrera: se devuelve su compra.
      const ganadora = await repeticion();
      if (ganadora) return ganadora;
    }
    throw error;
  }
}

async function listar({ cliente, eventoId, estado } = {}, { Compra = CompraModel } = {}) {
  const filtro = { creadaPor: cliente };
  const detalles = {};
  if (eventoId !== undefined) {
    if (typeof eventoId === 'string' && OBJECT_ID.test(eventoId)) filtro.eventoId = eventoId;
    else detalles.eventoId = 'Debe ser un ObjectId de 24 caracteres hexadecimales';
  }
  if (estado !== undefined) {
    if (typeof estado === 'string' && ESTADOS_COMPRA.includes(estado)) filtro.estado = estado;
    else detalles.estado = `Debe ser uno de: ${ESTADOS_COMPRA.join(', ')}`;
  }
  if (Object.keys(detalles).length > 0) throw errorDeValidacion(detalles, 'Filtro inválido');
  const compras = await Compra.find(filtro).sort({ createdAt: -1 }).lean();
  return compras.map(presentarCompra);
}

async function obtener(id, cliente, { Compra = CompraModel } = {}) {
  const compra = await Compra.findOne(deCliente(id, cliente)).lean();
  if (!compra) throw compraNoEncontrada();
  return presentarCompra(compra);
}

// Solo desde `pendiente`. La transición es condicional, así que una cancelación y un pago
// concurrentes no pueden ganar los dos; el cupo se libera una sola vez, por quien ganó.
// Cancelar una compra ya cancelada la devuelve tal cual.
async function cancelar(id, cliente, { Compra = CompraModel, Evento = EventoModel } = {}) {
  const cancelada = await Compra.findOneAndUpdate(
    { ...deCliente(id, cliente), estado: 'pendiente' },
    { $set: { estado: 'cancelada' } },
    { new: true }
  ).lean();
  if (cancelada) {
    await Evento.updateOne({ _id: cancelada.eventoId }, { $inc: { cupoDisponible: cancelada.cantidad } });
    return presentarCompra(cancelada);
  }

  const actual = await Compra.findOne(deCliente(id, cliente)).lean();
  if (!actual) throw compraNoEncontrada();
  if (actual.estado === 'cancelada') return presentarCompra(actual);
  throw new ApiError({
    status: 409, error: `Solo se puede cancelar una compra pendiente (estado actual: ${actual.estado})`,
    code: 'PURCHASE_INVALID_STATE', action: 'Consultar el estado actual del recurso', details: { estado: actual.estado }
  });
}

// `pendiente → expirada` cuando venció `reservaExpiraEn`, y devuelve el cupo. Es condicional al
// estado y al vencimiento: lo usan `/pagar` (de forma perezosa) y el barrido, y quien gana la
// transición es el único que libera el cupo. Devuelve `true` si esta llamada expiró la compra.
async function expirarReserva(compraId, { Compra = CompraModel, Evento = EventoModel, ahora = new Date() } = {}) {
  const expirada = await Compra.findOneAndUpdate(
    { _id: compraId, estado: 'pendiente', reservaExpiraEn: { $lte: ahora } },
    { $set: { estado: 'expirada' } },
    { new: true }
  ).lean();
  if (!expirada) return false;
  await Evento.updateOne({ _id: expirada.eventoId }, { $inc: { cupoDisponible: expirada.cantidad } });
  return true;
}

// Vacío hasta que el worker procesa entrada.comprada: es el efecto visible del flujo asincrónico.
async function entradasDe(id, cliente, { Compra = CompraModel, Entrada = EntradaModel } = {}) {
  if (!(await Compra.exists(deCliente(id, cliente)))) throw compraNoEncontrada();
  const entradas = await Entrada.find({ compraId: id }).sort({ numero: 1 }).lean();
  return entradas.map(presentarEntrada);
}

module.exports = { reservar, listar, obtener, cancelar, expirarReserva, entradasDe, presentarCompra, deCliente, compraNoEncontrada };
