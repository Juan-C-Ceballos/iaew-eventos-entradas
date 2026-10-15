const EventoModel = require('../models/Evento');
const CompraModel = require('../models/Compra');
const EntradaModel = require('../models/Entrada');
const { ApiError, errorDeValidacion } = require('../lib/errors');

const { ESTADOS_EVENTO } = EventoModel;
const MAX_INTENTOS = 3;

// Transiciones válidas por PATCH (ADR 0011). La cancelación tiene su propia operación.
const TRANSICIONES = { borrador: ['publicado'], publicado: ['finalizado'] };

const noEncontrado = () => new ApiError({
  status: 404, error: 'Evento inexistente', code: 'EVENT_NOT_FOUND', action: 'Verificar el identificador'
});

const transicionInvalida = (error, details) => new ApiError({
  status: 409, error, code: 'INVALID_STATE_TRANSITION', action: 'Consultar el estado actual del evento', details
});

// La API expone el evento tal como está en MongoDB, sin la versión interna de Mongoose.
function presentar(evento) {
  if (!evento) return evento;
  const { __v, ...resto } = evento;
  return resto;
}

// Decide qué cambia un PATCH sin tocar la base: valida estado, fecha y capacidad y devuelve
// `{ set, incCupo }`. La capacidad y el cupo se mueven juntos para no romper el invariante
// `capacidad − cupoDisponible = entradas reservadas o vendidas` (docs/modelo-datos.md).
function planificarActualizacion(actual, cambios, ahora = new Date()) {
  if (actual.estado === 'cancelado' || actual.estado === 'finalizado') {
    throw transicionInvalida(`Un evento ${actual.estado} no se puede modificar`, { estado: actual.estado });
  }

  const set = {};
  for (const campo of ['nombre', 'descripcion', 'lugar', 'precio']) {
    if (cambios[campo] !== undefined) set[campo] = cambios[campo];
  }

  if (cambios.fecha !== undefined) {
    const fecha = new Date(cambios.fecha);
    if (fecha <= ahora) throw errorDeValidacion({ fecha: 'Debe ser una fecha futura' }, 'Datos de evento inválidos');
    set.fecha = fecha;
  }

  if (cambios.estado !== undefined && cambios.estado !== actual.estado) {
    if (!(TRANSICIONES[actual.estado] || []).includes(cambios.estado)) {
      throw transicionInvalida(`Un evento ${actual.estado} no puede pasar a ${cambios.estado}`, { desde: actual.estado, hacia: cambios.estado });
    }
    if (cambios.estado === 'publicado' && new Date(set.fecha ?? actual.fecha) <= ahora) {
      throw errorDeValidacion({ fecha: 'No se puede publicar un evento con fecha pasada' }, 'Datos de evento inválidos');
    }
    set.estado = cambios.estado;
  }

  let incCupo = 0;
  if (cambios.capacidad !== undefined && cambios.capacidad !== actual.capacidad) {
    const reservadas = actual.capacidad - actual.cupoDisponible;
    if (cambios.capacidad < reservadas) {
      throw new ApiError({
        status: 409, error: 'La capacidad no puede ser menor a las entradas reservadas o vendidas', code: 'CAPACITY_BELOW_SOLD',
        action: 'Indicar una capacidad mayor o igual a las entradas ya reservadas o vendidas',
        details: { capacidad: cambios.capacidad, reservadasOVendidas: reservadas }
      });
    }
    set.capacidad = cambios.capacidad;
    incCupo = cambios.capacidad - actual.capacidad;
  }

  return { set, incCupo };
}

async function listar({ estado } = {}, { Evento = EventoModel } = {}) {
  const filtro = {};
  if (estado !== undefined) {
    if (typeof estado !== 'string' || !ESTADOS_EVENTO.includes(estado)) {
      throw errorDeValidacion({ estado: `Debe ser uno de: ${ESTADOS_EVENTO.join(', ')}` }, 'Filtro inválido');
    }
    filtro.estado = estado;
  }
  const eventos = await Evento.find(filtro).sort({ fecha: 1 }).lean();
  return eventos.map(presentar);
}

async function crear(datos, { Evento = EventoModel, ahora = new Date() } = {}) {
  const fecha = new Date(datos.fecha);
  if (fecha <= ahora) throw errorDeValidacion({ fecha: 'Debe ser una fecha futura' }, 'Datos de evento inválidos');
  const evento = await Evento.create({ ...datos, fecha, cupoDisponible: datos.capacidad });
  return presentar(evento.toObject());
}

async function obtener(id, { Evento = EventoModel } = {}) {
  const evento = await Evento.findById(id).lean();
  if (!evento) throw noEncontrado();
  return presentar(evento);
}

// El update lleva como condición el estado y la capacidad que se leyeron: si otro request los
// cambió en el medio, no se aplica y se vuelve a leer. Al reducir la capacidad se exige además
// `cupoDisponible >= reducción`, así una reserva concurrente nunca deja el cupo negativo.
async function actualizar(id, cambios, { Evento = EventoModel, ahora = new Date() } = {}) {
  for (let intento = 0; intento < MAX_INTENTOS; intento += 1) {
    const actual = await Evento.findById(id).lean();
    if (!actual) throw noEncontrado();

    const { set, incCupo } = planificarActualizacion(actual, cambios, ahora);
    if (Object.keys(set).length === 0) return presentar(actual);

    const filtro = { _id: id, estado: actual.estado, capacidad: actual.capacidad };
    if (incCupo < 0) filtro.cupoDisponible = { $gte: -incCupo };
    const update = { $set: set };
    if (incCupo !== 0) update.$inc = { cupoDisponible: incCupo };

    const actualizado = await Evento.findOneAndUpdate(filtro, update, { new: true, runValidators: true }).lean();
    if (actualizado) return presentar(actualizado);
  }
  throw new ApiError({
    status: 409, error: 'El evento se modificó mientras se procesaba la solicitud', code: 'CONCURRENT_UPDATE',
    action: 'Reintentar la solicitud', retryable: true
  });
}

// Solo se borra un evento sin compras. `cupoDisponible = capacidad` en el filtro del delete
// cierra la carrera con una reserva que llegue entre el conteo y el borrado.
async function eliminar(id, { Evento = EventoModel, Compra = CompraModel } = {}) {
  const sinVentas = () => new ApiError({
    status: 409, error: 'El evento tiene compras asociadas', code: 'EVENT_HAS_SALES',
    action: 'Cancelar el evento con POST /eventos/{id}/cancelar'
  });
  if (!(await Evento.exists({ _id: id }))) throw noEncontrado();
  if (await Compra.exists({ eventoId: id })) throw sinVentas();
  const { deletedCount } = await Evento.deleteOne({ _id: id, $expr: { $eq: ['$cupoDisponible', '$capacidad'] } });
  if (deletedCount === 1) return;
  if (!(await Evento.exists({ _id: id }))) return; // lo borró otro request: el resultado es el mismo
  throw sinVentas();
}

// Cascada de la cancelación (ADR 0011): cada paso es un update condicional, así que se puede
// repetir sin efectos dobles. La dispara la API tras cancelar y la retoma el barrido del worker
// mientras `cancelacionProcesadaEn` esté vacío. Devuelve `true` si el evento quedó procesado.
async function cancelarEventoCascada(eventoId, { Evento = EventoModel, Compra = CompraModel, Entrada = EntradaModel, ahora = new Date() } = {}) {
  // Sin ventas: no hay cupo que liberar, el evento ya no vende.
  await Compra.updateMany({ eventoId, estado: 'pendiente' }, { $set: { estado: 'cancelada' } });
  // Cobradas: no hay reembolso real, queda la marca para que alguien lo gestione.
  await Compra.updateMany({ eventoId, estado: 'pagada', reembolsoPendiente: { $ne: true } }, { $set: { reembolsoPendiente: true } });
  await Entrada.updateMany({ eventoId, estado: 'emitida' }, { $set: { estado: 'anulada' } });

  // Quedan cabos sueltos si hay un pago por resolverse, una emisión en curso (pagada sin
  // entradas todavía: el worker las emite ya anuladas) o una entrada que no pudo anularse.
  const [comprasAbiertas, entradasVigentes] = await Promise.all([
    Compra.countDocuments({
      eventoId,
      $or: [{ estado: { $in: ['pendiente', 'pago_pendiente'] } }, { estado: 'pagada', emisionEstado: { $ne: 'emitida' } }]
    }),
    Entrada.countDocuments({ eventoId, estado: 'emitida' })
  ]);
  if (comprasAbiertas > 0 || entradasVigentes > 0) return false;

  await Evento.updateOne({ _id: eventoId, estado: 'cancelado', cancelacionProcesadaEn: null }, { $set: { cancelacionProcesadaEn: ahora } });
  return true;
}

// `publicado → cancelado` es un update condicional: corta las ventas al instante porque la
// reserva exige `estado: 'publicado'`. Cancelar un evento ya cancelado devuelve el evento.
async function cancelar(id, dependencias = {}) {
  const { Evento = EventoModel } = dependencias;
  let evento = await Evento.findOneAndUpdate({ _id: id, estado: 'publicado' }, { $set: { estado: 'cancelado' } }, { new: true }).lean();
  if (!evento) {
    evento = await Evento.findById(id).lean();
    if (!evento) throw noEncontrado();
    if (evento.estado !== 'cancelado') {
      throw transicionInvalida(`Solo se puede cancelar un evento publicado (estado actual: ${evento.estado})`, { estado: evento.estado });
    }
  }

  // La venta ya está cortada: si la cascada falla, no se le devuelve un error al cliente. El
  // barrido la retoma (cancelacionProcesadaEn sigue vacío).
  try {
    await cancelarEventoCascada(evento._id, dependencias);
  } catch (error) {
    console.error(`Cascada de cancelación pendiente para el evento ${evento._id}: ${error.message}`);
  }
  return presentar(await Evento.findById(id).lean());
}

module.exports = { listar, crear, obtener, actualizar, eliminar, cancelar, cancelarEventoCascada, planificarActualizacion };
