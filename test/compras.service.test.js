const { test } = require('node:test');
const assert = require('node:assert/strict');
const compras = require('../src/services/compras');
const { huella } = require('../src/lib/idempotencia');
const { ApiError } = require('../src/lib/errors');

const AHORA = new Date('2026-11-01T12:00:00.000Z');
const EVENTO_ID = '66f000000000000000000001';
const COMPRA_ID = '6702a1b2c3d4e5f601234567';
const CLIENTE = 'canal@clients';
const CLAVE = 'compra:ana-40123456:0001';
const DATOS = { eventoId: EVENTO_ID, cantidad: 3, asistente: { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' } };

const EVENTO = { _id: EVENTO_ID, estado: 'publicado', fecha: new Date('2026-12-01T21:00:00.000Z'), cupoDisponible: 7, precio: 12.5 };

// Una consulta de Mongoose se puede esperar directamente o encadenar `.lean()`.
const consulta = (valor) => ({ lean: async () => valor, then: (ok, fallo) => Promise.resolve(valor).then(ok, fallo) });

const rechazaCon = (codigo, status) => (error) => {
  assert.ok(error instanceof ApiError, `se esperaba ApiError, llegó ${error}`);
  assert.equal(error.code, codigo);
  if (status) assert.equal(error.status, status);
  return true;
};

// Dobles de los modelos que anotan lo que se les pide. `opciones` ajusta cada caso.
function dobles({ evento = EVENTO, reservado = evento, existentes = [null], falloAlCrear } = {}) {
  const registro = { reservas: [], devoluciones: [], upserts: [], altas: [], busquedas: [] };
  let busqueda = 0;
  return {
    registro,
    Evento: {
      findOneAndUpdate: (filtro, update) => { registro.reservas.push({ filtro, update }); return consulta(reservado); },
      findById: () => consulta(evento),
      updateOne: async (filtro, update) => { registro.devoluciones.push({ filtro, update }); }
    },
    Asistente: {
      findOneAndUpdate: (filtro, update) => { registro.upserts.push({ filtro, update }); return consulta({ _id: 'asistente-1' }); }
    },
    Compra: {
      findOne: (filtro) => { registro.busquedas.push(filtro); return consulta(existentes[Math.min(busqueda++, existentes.length - 1)]); },
      create: async (datos) => {
        if (falloAlCrear) throw falloAlCrear;
        registro.altas.push(datos);
        return { toObject: () => ({ _id: COMPRA_ID, estado: 'pendiente', ...datos }) };
      }
    }
  };
}

const reservar = (deps, datos = DATOS) => compras.reservar(datos, { clave: CLAVE, cliente: CLIENTE }, { ...deps, ahora: AHORA, reservaTtlMinutos: 15 });

test('reservar: descuenta el cupo con un update condicional y crea la compra pendiente', async () => {
  const deps = dobles();
  const { compra, replayed } = await reservar(deps);

  assert.equal(replayed, false);
  assert.deepEqual(deps.registro.reservas[0].filtro, { _id: EVENTO_ID, estado: 'publicado', fecha: { $gt: AHORA }, cupoDisponible: { $gte: 3 } });
  assert.deepEqual(deps.registro.reservas[0].update, { $inc: { cupoDisponible: -3 } });
  assert.deepEqual(deps.registro.upserts[0].filtro, { documento: '40123456' });

  const alta = deps.registro.altas[0];
  assert.equal(alta.creadaPor, CLIENTE);
  assert.equal(alta.precioUnitario, 12.5);
  assert.equal(alta.total, 37.5, 'el total lo calcula el servidor');
  assert.equal(alta.idempotencyFingerprint, huella(DATOS));
  assert.deepEqual(alta.reservaExpiraEn, new Date('2026-11-01T12:15:00.000Z'));
  assert.deepEqual(alta.asistente, DATOS.asistente, 'la compra guarda su propia copia del asistente');
  assert.equal(compra.estado, 'pendiente');
});

test('reservar: el total se redondea a centavos', async () => {
  const deps = dobles({ reservado: { ...EVENTO, precio: 33.33 } });
  await reservar(deps);
  assert.equal(deps.registro.altas[0].total, 99.99);
});

test('reservar: la misma clave y el mismo cuerpo devuelven la compra original sin reservar', async () => {
  const existente = { _id: COMPRA_ID, estado: 'pendiente', idempotencyFingerprint: huella(DATOS) };
  const deps = dobles({ existentes: [existente] });
  const resultado = await reservar(deps);
  assert.equal(resultado.replayed, true);
  assert.equal(resultado.compra._id, COMPRA_ID);
  assert.deepEqual(deps.registro.busquedas[0], { creadaPor: CLIENTE, idempotencyKey: CLAVE }, 'la clave se busca por cliente');
  assert.equal(deps.registro.reservas.length, 0);
});

test('reservar: la misma clave con otro cuerpo es 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
  const deps = dobles({ existentes: [{ _id: COMPRA_ID, idempotencyFingerprint: huella({ ...DATOS, cantidad: 1 }) }] });
  await assert.rejects(reservar(deps), rechazaCon('IDEMPOTENCY_KEY_MISMATCH', 409));
  assert.equal(deps.registro.reservas.length, 0);
});

test('reservar: explica por qué no se pudo reservar, en orden', async () => {
  const sinReserva = (evento) => dobles({ evento, reservado: null });

  await assert.rejects(reservar(sinReserva(null)), rechazaCon('EVENT_NOT_FOUND', 404));

  await assert.rejects(reservar(sinReserva({ ...EVENTO, estado: 'borrador' })), (error) => {
    rechazaCon('EVENT_NOT_PUBLISHED', 409)(error);
    assert.deepEqual(error.details, { estado: 'borrador' });
    return true;
  });

  await assert.rejects(reservar(sinReserva({ ...EVENTO, fecha: new Date('2026-10-01T21:00:00.000Z') })), (error) => {
    rechazaCon('EVENT_ALREADY_STARTED', 409)(error);
    assert.deepEqual(error.details, { fecha: '2026-10-01T21:00:00.000Z' });
    return true;
  });

  await assert.rejects(reservar(sinReserva({ ...EVENTO, cupoDisponible: 2 })), (error) => {
    rechazaCon('EVENT_SOLD_OUT', 409)(error);
    assert.deepEqual(error.details, { eventoId: EVENTO_ID, cupoDisponible: 2, solicitado: 3 });
    return true;
  });
});

test('reservar: si falla la creación de la compra, devuelve el cupo y propaga el error', async () => {
  const deps = dobles({ falloAlCrear: new Error('mongo caído') });
  await assert.rejects(reservar(deps), /mongo caído/);
  assert.deepEqual(deps.registro.devoluciones[0], { filtro: { _id: EVENTO_ID }, update: { $inc: { cupoDisponible: 3 } } });
});

test('reservar: si otro request con la misma clave gana la carrera, devuelve el cupo y responde con su compra', async () => {
  const ganadora = { _id: COMPRA_ID, estado: 'pendiente', idempotencyFingerprint: huella(DATOS) };
  const duplicada = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const deps = dobles({ existentes: [null, ganadora], falloAlCrear: duplicada });
  const resultado = await reservar(deps);
  assert.equal(resultado.replayed, true);
  assert.equal(resultado.compra._id, COMPRA_ID);
  assert.equal(deps.registro.devoluciones.length, 1, 'el cupo de este intento se devuelve');
});

test('reservar: si falla la devolución del cupo, igual se informa el error original', async () => {
  const deps = dobles({ falloAlCrear: new Error('falla original') });
  deps.Evento.updateOne = async () => { throw new Error('falla secundaria'); };
  const consola = console.error;
  console.error = () => {};
  try {
    await assert.rejects(reservar(deps), /falla original/);
  } finally {
    console.error = consola;
  }
});

test('presentarCompra oculta la clave de idempotencia, su huella, el outbox y la clave del pago', () => {
  const interna = {
    _id: COMPRA_ID, estado: 'pagada', total: 10, __v: 0,
    idempotencyKey: CLAVE, idempotencyFingerprint: 'abc', emisionEvento: { eventId: 'x' }, emisionPublicadaEn: AHORA,
    pago: { estado: 'aprobado', referenciaExterna: 'PAY-1', idempotencyKey: 'pago-clave-1' }
  };
  assert.deepEqual(compras.presentarCompra(interna), {
    _id: COMPRA_ID, estado: 'pagada', total: 10, pago: { estado: 'aprobado', referenciaExterna: 'PAY-1' }
  });
  assert.deepEqual(compras.presentarCompra({ _id: COMPRA_ID }), { _id: COMPRA_ID });
});

test('listar: solo las compras del cliente, de la más nueva a la más vieja, con filtros validados', async () => {
  let consultado;
  const Compra = { find: (filtro) => { consultado = { filtro }; return { sort: (orden) => { consultado.orden = orden; return consulta([{ _id: COMPRA_ID, idempotencyKey: CLAVE }]); } }; } };
  const lista = await compras.listar({ cliente: CLIENTE, eventoId: EVENTO_ID, estado: 'pagada' }, { Compra });
  assert.deepEqual(consultado, { filtro: { creadaPor: CLIENTE, eventoId: EVENTO_ID, estado: 'pagada' }, orden: { createdAt: -1 } });
  assert.deepEqual(lista, [{ _id: COMPRA_ID }]);

  await assert.rejects(compras.listar({ cliente: CLIENTE, eventoId: 'xyz', estado: 'rara' }, { Compra }), (error) => {
    rechazaCon('VALIDATION_ERROR', 400)(error);
    assert.deepEqual(Object.keys(error.details), ['eventoId', 'estado']);
    return true;
  });
});

test('obtener: una compra de otro cliente no existe (404 PURCHASE_NOT_FOUND)', async () => {
  let filtro;
  const Compra = { findOne: (f) => { filtro = f; return consulta(null); } };
  await assert.rejects(compras.obtener(COMPRA_ID, CLIENTE, { Compra }), rechazaCon('PURCHASE_NOT_FOUND', 404));
  assert.deepEqual(filtro, { _id: COMPRA_ID, creadaPor: CLIENTE });
});

test('cancelar: pasa pendiente→cancelada con un update condicional y libera el cupo', async () => {
  const llamadas = { compra: [], cupo: [] };
  const Compra = {
    findOneAndUpdate: (filtro, update) => { llamadas.compra.push({ filtro, update }); return consulta({ _id: COMPRA_ID, eventoId: EVENTO_ID, cantidad: 2, estado: 'cancelada' }); }
  };
  const Evento = { updateOne: async (filtro, update) => { llamadas.cupo.push({ filtro, update }); } };
  const resultado = await compras.cancelar(COMPRA_ID, CLIENTE, { Compra, Evento });
  assert.equal(resultado.estado, 'cancelada');
  assert.deepEqual(llamadas.compra[0].filtro, { _id: COMPRA_ID, creadaPor: CLIENTE, estado: 'pendiente' });
  assert.deepEqual(llamadas.cupo[0], { filtro: { _id: EVENTO_ID }, update: { $inc: { cupoDisponible: 2 } } });
});

test('cancelar: ya cancelada se devuelve sin liberar de nuevo; en otro estado es 409; ajena es 404', async () => {
  const Evento = { updateOne: async () => assert.fail('no debe liberar cupo') };
  const con = (actual) => ({ findOneAndUpdate: () => consulta(null), findOne: () => consulta(actual) });

  const repetida = await compras.cancelar(COMPRA_ID, CLIENTE, { Compra: con({ _id: COMPRA_ID, estado: 'cancelada' }), Evento });
  assert.equal(repetida.estado, 'cancelada');

  await assert.rejects(compras.cancelar(COMPRA_ID, CLIENTE, { Compra: con({ _id: COMPRA_ID, estado: 'pago_pendiente' }), Evento }), (error) => {
    rechazaCon('PURCHASE_INVALID_STATE', 409)(error);
    assert.deepEqual(error.details, { estado: 'pago_pendiente' });
    return true;
  });

  await assert.rejects(compras.cancelar(COMPRA_ID, CLIENTE, { Compra: con(null), Evento }), rechazaCon('PURCHASE_NOT_FOUND', 404));
});

test('entradasDe: 404 si la compra no es del cliente; si lo es, las entradas por número', async () => {
  const sinCompra = { exists: () => consulta(null) };
  await assert.rejects(compras.entradasDe(COMPRA_ID, CLIENTE, { Compra: sinCompra, Entrada: {} }), rechazaCon('PURCHASE_NOT_FOUND', 404));

  let orden;
  const Entrada = { find: () => ({ sort: (o) => { orden = o; return consulta([{ _id: 'e1', numero: 1, __v: 0 }]); } }) };
  const entradas = await compras.entradasDe(COMPRA_ID, CLIENTE, { Compra: { exists: () => consulta({ _id: COMPRA_ID }) }, Entrada });
  assert.deepEqual(orden, { numero: 1 });
  assert.deepEqual(entradas, [{ _id: 'e1', numero: 1 }]);
});
