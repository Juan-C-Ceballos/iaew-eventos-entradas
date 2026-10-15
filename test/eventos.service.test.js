const { test } = require('node:test');
const assert = require('node:assert/strict');
const eventos = require('../src/services/eventos');
const { ApiError } = require('../src/lib/errors');

const AHORA = new Date('2026-11-01T12:00:00.000Z');
const FUTURA = new Date('2026-12-01T21:00:00.000Z');
const PASADA = new Date('2026-10-01T21:00:00.000Z');
const ID = '66f000000000000000000001';

const evento = (campos = {}) => ({
  _id: ID, nombre: 'Recital', fecha: FUTURA, lugar: 'Córdoba', capacidad: 10, cupoDisponible: 10, precio: 100, estado: 'publicado', __v: 0, ...campos
});

// Una consulta de Mongoose se puede esperar directamente o encadenar `.lean()`.
const consulta = (valor) => ({ lean: async () => valor, then: (ok, fallo) => Promise.resolve(valor).then(ok, fallo) });

const rechazaCon = (codigo, status) => (error) => {
  assert.ok(error instanceof ApiError, `se esperaba ApiError, llegó ${error}`);
  assert.equal(error.code, codigo);
  if (status) assert.equal(error.status, status);
  return true;
};

test('planificarActualizacion: publicar un borrador con fecha futura', () => {
  const plan = eventos.planificarActualizacion(evento({ estado: 'borrador' }), { estado: 'publicado' }, AHORA);
  assert.deepEqual(plan, { set: { estado: 'publicado' }, incCupo: 0 });
});

test('planificarActualizacion: publicar con fecha pasada o fijar una fecha pasada es 400 VALIDATION_ERROR', () => {
  assert.throws(() => eventos.planificarActualizacion(evento({ estado: 'borrador', fecha: PASADA }), { estado: 'publicado' }, AHORA), rechazaCon('VALIDATION_ERROR', 400));
  assert.throws(() => eventos.planificarActualizacion(evento(), { fecha: PASADA.toISOString() }, AHORA), rechazaCon('VALIDATION_ERROR', 400));
  // Publicar y corregir la fecha en el mismo PATCH es válido.
  const plan = eventos.planificarActualizacion(evento({ estado: 'borrador', fecha: PASADA }), { estado: 'publicado', fecha: FUTURA.toISOString() }, AHORA);
  assert.equal(plan.set.estado, 'publicado');
  assert.deepEqual(plan.set.fecha, FUTURA);
});

test('planificarActualizacion: solo valen borrador→publicado y publicado→finalizado', () => {
  assert.deepEqual(eventos.planificarActualizacion(evento(), { estado: 'finalizado' }, AHORA).set, { estado: 'finalizado' });
  assert.throws(() => eventos.planificarActualizacion(evento({ estado: 'borrador' }), { estado: 'finalizado' }, AHORA), rechazaCon('INVALID_STATE_TRANSITION', 409));
  assert.throws(() => eventos.planificarActualizacion(evento(), { estado: 'borrador' }, AHORA), rechazaCon('INVALID_STATE_TRANSITION', 409));
});

test('planificarActualizacion: un evento cancelado o finalizado no se modifica', () => {
  for (const estado of ['cancelado', 'finalizado']) {
    assert.throws(() => eventos.planificarActualizacion(evento({ estado }), { nombre: 'Otro' }, AHORA), rechazaCon('INVALID_STATE_TRANSITION', 409));
  }
});

test('planificarActualizacion: la capacidad mueve el cupo en la misma diferencia', () => {
  const vendido = evento({ capacidad: 10, cupoDisponible: 6 }); // 4 reservadas o vendidas
  assert.deepEqual(eventos.planificarActualizacion(vendido, { capacidad: 20 }, AHORA), { set: { capacidad: 20 }, incCupo: 10 });
  assert.deepEqual(eventos.planificarActualizacion(vendido, { capacidad: 4 }, AHORA), { set: { capacidad: 4 }, incCupo: -6 });
});

test('planificarActualizacion: la capacidad no puede quedar debajo de lo reservado o vendido', () => {
  const vendido = evento({ capacidad: 10, cupoDisponible: 6 });
  assert.throws(() => eventos.planificarActualizacion(vendido, { capacidad: 3 }, AHORA), (error) => {
    rechazaCon('CAPACITY_BELOW_SOLD', 409)(error);
    assert.deepEqual(error.details, { capacidad: 3, reservadasOVendidas: 4 });
    return true;
  });
});

test('planificarActualizacion: repetir los valores actuales no cambia nada', () => {
  const plan = eventos.planificarActualizacion(evento({ estado: 'borrador' }), { estado: 'borrador', capacidad: 10 }, AHORA);
  assert.deepEqual(plan, { set: {}, incCupo: 0 });
});

test('crear: inicializa el cupo con la capacidad y rechaza una fecha pasada sin tocar la base', async () => {
  let creado;
  const Evento = { create: async (datos) => { creado = datos; return { toObject: () => ({ ...datos, _id: ID, __v: 0 }) }; } };
  const resultado = await eventos.crear({ nombre: 'Recital', fecha: FUTURA.toISOString(), lugar: 'Córdoba', capacidad: 50, precio: 10 }, { Evento, ahora: AHORA });
  assert.equal(creado.cupoDisponible, 50);
  assert.deepEqual(creado.fecha, FUTURA);
  assert.equal('__v' in resultado, false);

  await assert.rejects(eventos.crear({ nombre: 'x', fecha: PASADA.toISOString(), lugar: 'x', capacidad: 1, precio: 0 }, { Evento: { create: () => assert.fail('no debe llegar a la base') }, ahora: AHORA }), rechazaCon('VALIDATION_ERROR', 400));
});

test('listar valida el filtro de estado y ordena por fecha', async () => {
  let recibido;
  const Evento = { find: (filtro) => { recibido = filtro; return { sort: (orden) => { recibido = { ...recibido, orden }; return consulta([evento()]); } }; } };
  const lista = await eventos.listar({ estado: 'publicado' }, { Evento });
  assert.deepEqual(recibido, { estado: 'publicado', orden: { fecha: 1 } });
  assert.equal('__v' in lista[0], false);
  await assert.rejects(eventos.listar({ estado: 'raro' }, { Evento }), rechazaCon('VALIDATION_ERROR', 400));
  await assert.rejects(eventos.listar({ estado: ['publicado', 'borrador'] }, { Evento }), rechazaCon('VALIDATION_ERROR', 400));
});

test('obtener: 404 EVENT_NOT_FOUND si no existe', async () => {
  await assert.rejects(eventos.obtener(ID, { Evento: { findById: () => consulta(null) } }), rechazaCon('EVENT_NOT_FOUND', 404));
});

test('actualizar: condiciona el update al estado y la capacidad leídos, y al cupo si reduce', async () => {
  const llamadas = [];
  const Evento = {
    findById: () => consulta(evento({ capacidad: 10, cupoDisponible: 6 })),
    findOneAndUpdate: (filtro, update) => { llamadas.push({ filtro, update }); return consulta(evento({ capacidad: 4, cupoDisponible: 0 })); }
  };
  await eventos.actualizar(ID, { capacidad: 4 }, { Evento, ahora: AHORA });
  assert.deepEqual(llamadas[0].filtro, { _id: ID, estado: 'publicado', capacidad: 10, cupoDisponible: { $gte: 6 } });
  assert.deepEqual(llamadas[0].update, { $set: { capacidad: 4 }, $inc: { cupoDisponible: -6 } });
});

test('actualizar: sin cambios efectivos devuelve el evento sin escribir', async () => {
  const Evento = { findById: () => consulta(evento()), findOneAndUpdate: () => assert.fail('no debe escribir') };
  const resultado = await eventos.actualizar(ID, { nombre: undefined, capacidad: 10 }, { Evento, ahora: AHORA });
  assert.equal(resultado.capacidad, 10);
});

test('actualizar: si otro request cambió el evento, relee y reintenta', async () => {
  let lecturas = 0;
  let escrituras = 0;
  const Evento = {
    findById: () => consulta(evento({ cupoDisponible: ++lecturas === 1 ? 10 : 8 })),
    findOneAndUpdate: () => consulta(++escrituras === 1 ? null : evento({ nombre: 'Nuevo' }))
  };
  const resultado = await eventos.actualizar(ID, { nombre: 'Nuevo' }, { Evento, ahora: AHORA });
  assert.equal(resultado.nombre, 'Nuevo');
  assert.equal(lecturas, 2);
});

test('actualizar: tras varios intentos fallidos responde 409 CONCURRENT_UPDATE reintentable', async () => {
  const Evento = { findById: () => consulta(evento()), findOneAndUpdate: () => consulta(null) };
  await assert.rejects(eventos.actualizar(ID, { nombre: 'Nuevo' }, { Evento, ahora: AHORA }), (error) => {
    rechazaCon('CONCURRENT_UPDATE', 409)(error);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('eliminar: 404 si no existe, 409 EVENT_HAS_SALES con compras y 409 si una reserva gana la carrera', async () => {
  const Compra = (hay) => ({ exists: () => consulta(hay ? { _id: 'c' } : null) });
  await assert.rejects(eventos.eliminar(ID, { Evento: { exists: () => consulta(null) }, Compra: Compra(false) }), rechazaCon('EVENT_NOT_FOUND', 404));
  await assert.rejects(eventos.eliminar(ID, { Evento: { exists: () => consulta({ _id: ID }) }, Compra: Compra(true) }), rechazaCon('EVENT_HAS_SALES', 409));
  // El delete no encontró el evento con el cupo completo y el evento sigue ahí: se reservó en el medio.
  const conReserva = { exists: () => consulta({ _id: ID }), deleteOne: async () => ({ deletedCount: 0 }) };
  await assert.rejects(eventos.eliminar(ID, { Evento: conReserva, Compra: Compra(false) }), rechazaCon('EVENT_HAS_SALES', 409));
});

test('eliminar: borra un evento sin compras con la guarda cupoDisponible = capacidad', async () => {
  let filtro;
  const Evento = { exists: () => consulta({ _id: ID }), deleteOne: async (f) => { filtro = f; return { deletedCount: 1 }; } };
  await eventos.eliminar(ID, { Evento, Compra: { exists: () => consulta(null) } });
  assert.deepEqual(filtro, { _id: ID, $expr: { $eq: ['$cupoDisponible', '$capacidad'] } });
});

function dependenciasDeCancelacion({ abiertas = 0, vigentes = 0, cancelar = evento({ estado: 'cancelado' }), previo = null } = {}) {
  const registro = { compras: [], entradas: [], eventos: [] };
  return {
    registro,
    Evento: {
      findOneAndUpdate: (filtro, update) => { registro.eventos.push({ filtro, update }); return consulta(cancelar); },
      findById: () => consulta(previo ?? cancelar),
      updateOne: async (filtro, update) => { registro.eventos.push({ filtro, update }); }
    },
    Compra: {
      updateMany: async (filtro, update) => { registro.compras.push({ filtro, update }); },
      countDocuments: async () => abiertas
    },
    Entrada: {
      updateMany: async (filtro, update) => { registro.entradas.push({ filtro, update }); },
      countDocuments: async () => vigentes
    }
  };
}

test('cancelar: corta la venta con un update condicional y dispara la cascada', async () => {
  const deps = dependenciasDeCancelacion();
  const resultado = await eventos.cancelar(ID, { ...deps, ahora: AHORA });
  assert.equal(resultado.estado, 'cancelado');
  assert.deepEqual(deps.registro.eventos[0].filtro, { _id: ID, estado: 'publicado' });
  assert.deepEqual(deps.registro.compras.map((c) => c.update.$set), [{ estado: 'cancelada' }, { reembolsoPendiente: true }]);
  assert.deepEqual(deps.registro.entradas[0].filtro.estado, 'emitida');
  assert.deepEqual(deps.registro.eventos[1].update, { $set: { cancelacionProcesadaEn: AHORA } });
});

test('cancelar: un evento ya cancelado se devuelve tal cual (idempotente)', async () => {
  const deps = dependenciasDeCancelacion({ previo: evento({ estado: 'cancelado' }) });
  deps.Evento.findOneAndUpdate = () => consulta(null);
  const resultado = await eventos.cancelar(ID, deps);
  assert.equal(resultado.estado, 'cancelado');
});

test('cancelar: desde borrador o finalizado es 409 INVALID_STATE_TRANSITION y si no existe 404', async () => {
  for (const estado of ['borrador', 'finalizado']) {
    const deps = dependenciasDeCancelacion({ previo: evento({ estado }) });
    deps.Evento.findOneAndUpdate = () => consulta(null);
    await assert.rejects(eventos.cancelar(ID, deps), rechazaCon('INVALID_STATE_TRANSITION', 409));
  }
  const inexistente = dependenciasDeCancelacion();
  inexistente.Evento.findOneAndUpdate = () => consulta(null);
  inexistente.Evento.findById = () => consulta(null);
  await assert.rejects(eventos.cancelar(ID, inexistente), rechazaCon('EVENT_NOT_FOUND', 404));
});

test('cancelar: si la cascada falla, la venta ya está cortada y no se devuelve error', async () => {
  const deps = dependenciasDeCancelacion();
  deps.Compra.updateMany = async () => { throw new Error('mongo caído'); };
  const error = console.error;
  console.error = () => {};
  try {
    const resultado = await eventos.cancelar(ID, deps);
    assert.equal(resultado.estado, 'cancelado');
  } finally {
    console.error = error;
  }
});

test('cancelarEventoCascada: con pagos por resolver o entradas vigentes no marca el evento como procesado', async () => {
  const conPagoPendiente = dependenciasDeCancelacion({ abiertas: 1 });
  assert.equal(await eventos.cancelarEventoCascada(ID, conPagoPendiente), false);
  assert.equal(conPagoPendiente.registro.eventos.length, 0);

  const conEntradas = dependenciasDeCancelacion({ vigentes: 2 });
  assert.equal(await eventos.cancelarEventoCascada(ID, conEntradas), false);

  const completa = dependenciasDeCancelacion();
  assert.equal(await eventos.cancelarEventoCascada(ID, { ...completa, ahora: AHORA }), true);
  assert.deepEqual(completa.registro.eventos[0].filtro, { _id: ID, estado: 'cancelado', cancelacionProcesadaEn: null });
});
