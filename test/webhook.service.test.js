const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const pagos = require('../src/services/pagos');
const { ApiError } = require('../src/lib/errors');
const esquemaDelEvento = require('../docs/eventos/entrada-comprada.schema.json');

const AHORA = new Date('2026-11-01T12:00:00.000Z');
const COMPRA_ID = '6702a1b2c3d4e5f601234567';
const EVENTO_ID = '66f000000000000000000001';
const REF = 'PAY-7f3c2a91';

const consulta = (valor) => ({ select: () => consulta(valor), lean: async () => valor });
const enPago = (extra = {}) => ({ _id: COMPRA_ID, eventoId: EVENTO_ID, cantidad: 2, total: 50000, estado: 'pago_pendiente', pago: { estado: 'pendiente' }, ...extra });
const rechazaCon = (codigo, status) => (error) => {
  assert.ok(error instanceof ApiError, `se esperaba ApiError, llegó ${error}`);
  assert.equal(error.code, codigo);
  if (status) assert.equal(error.status, status);
  return true;
};

// `lecturas` es la secuencia de compras que devuelve findById; `ganada` lo que devuelve el update condicional.
function dobles({ lecturas, ganada = null, eventoEstado = 'publicado' }) {
  const registro = { transiciones: [], marcas: [], cupo: [] };
  let lectura = 0;
  return {
    registro,
    Compra: {
      findById: () => consulta(lecturas[Math.min(lectura++, lecturas.length - 1)]),
      findOneAndUpdate: (filtro, update) => { registro.transiciones.push({ filtro, update }); return consulta(ganada); },
      updateOne: async (filtro, update) => { registro.marcas.push({ filtro, update }); }
    },
    Evento: {
      findById: () => consulta({ estado: eventoEstado }),
      updateOne: async (filtro, update) => { registro.cupo.push({ filtro, update }); }
    },
    ahora: AHORA
  };
}

const sinLog = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test('aprobado: una sola escritura condicional guarda pagada y el sobre entrada.comprada (outbox)', async () => {
  const deps = dobles({ lecturas: [enPago()], ganada: enPago({ estado: 'pagada' }) });
  const { resultado, compra } = await pagos.registrarPagoAprobado(COMPRA_ID, { referenciaExterna: REF, correlationId: 'corr-1' }, deps);

  assert.equal(resultado, 'aplicado');
  assert.equal(compra.estado, 'pagada');
  assert.equal(deps.registro.transiciones.length, 1);
  const { filtro, update } = deps.registro.transiciones[0];
  assert.deepEqual(filtro, { _id: COMPRA_ID, estado: 'pago_pendiente' });
  const set = update.$set;
  assert.deepEqual([set.estado, set['pago.estado'], set['pago.referenciaExterna'], set.emisionEstado], ['pagada', 'aprobado', REF, 'pendiente']);
  assert.deepEqual(set['pago.procesadoEn'], AHORA);
  assert.equal('reembolsoPendiente' in set, false);
  assert.equal(deps.registro.cupo.length, 0, 'un pago aprobado no toca el cupo');

  // El sobre cumple el contrato del evento y lleva el correlation id de la solicitud.
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  assert.ok(ajv.compile(esquemaDelEvento)(set.emisionEvento), JSON.stringify(set.emisionEvento));
  assert.deepEqual([set.emisionEvento.correlationId, set.emisionEvento.data.compraId, set.emisionEvento.occurredAt], ['corr-1', COMPRA_ID, AHORA.toISOString()]);
});

test('aprobado: sobre un evento cancelado la compra queda pagada con reembolsoPendiente', async () => {
  const deps = dobles({ lecturas: [enPago()], ganada: enPago({ estado: 'pagada' }), eventoEstado: 'cancelado' });
  await pagos.registrarPagoAprobado(COMPRA_ID, { referenciaExterna: REF, correlationId: 'c' }, deps);
  assert.equal(deps.registro.transiciones[0].update.$set.reembolsoPendiente, true);
});

test('aprobado: una notificación repetida sobre una compra pagada es un duplicado sin escribir de nuevo', async () => {
  const deps = dobles({ lecturas: [enPago({ estado: 'pagada' })], ganada: null });
  const { resultado, compra } = await pagos.registrarPagoAprobado(COMPRA_ID, { referenciaExterna: REF, correlationId: 'c' }, deps);
  assert.equal(resultado, 'duplicado');
  assert.equal(compra.estado, 'pagada');
  assert.equal(deps.registro.marcas.length, 0);
});

test('aprobado tardío sobre una compra expirada, rechazada o cancelada: conflicto, reembolsoPendiente y log de error', async () => {
  for (const estado of ['expirada', 'rechazada', 'cancelada']) {
    const deps = dobles({ lecturas: [enPago(), enPago({ estado })], ganada: null });
    const { resultado } = await sinLog(() => pagos.registrarPagoAprobado(COMPRA_ID, { referenciaExterna: REF, correlationId: 'c' }, deps));
    assert.equal(resultado, 'conflicto', estado);
    assert.deepEqual(deps.registro.marcas[0], { filtro: { _id: COMPRA_ID, estado, reembolsoPendiente: { $ne: true } }, update: { $set: { reembolsoPendiente: true } } }, estado);
  }
});

test('aprobado sobre una compra todavía pendiente es conflicto y no la marca para reembolso', async () => {
  const deps = dobles({ lecturas: [enPago(), enPago({ estado: 'pendiente' })], ganada: null });
  const { resultado } = await pagos.registrarPagoAprobado(COMPRA_ID, { referenciaExterna: REF, correlationId: 'c' }, deps);
  assert.equal(resultado, 'conflicto');
  assert.equal(deps.registro.marcas.length, 0);
});

test('una compra inexistente es 404 PURCHASE_NOT_FOUND', async () => {
  const deps = dobles({ lecturas: [null] });
  await assert.rejects(pagos.registrarPagoAprobado(COMPRA_ID, { referenciaExterna: REF, correlationId: 'c' }, deps), rechazaCon('PURCHASE_NOT_FOUND', 404));
  await assert.rejects(pagos.registrarPagoRechazado(COMPRA_ID, { referenciaExterna: REF }, deps), rechazaCon('PURCHASE_NOT_FOUND', 404));
});

test('rechazado: pasa a rechazada, guarda el motivo y libera el cupo una sola vez', async () => {
  const deps = dobles({ lecturas: [enPago()], ganada: enPago({ estado: 'rechazada' }) });
  const { resultado } = await pagos.registrarPagoRechazado(COMPRA_ID, { referenciaExterna: REF, motivo: 'fondos_insuficientes' }, deps);
  assert.equal(resultado, 'aplicado');
  const set = deps.registro.transiciones[0].update.$set;
  assert.deepEqual([set.estado, set['pago.estado'], set['pago.motivoRechazo'], set['pago.referenciaExterna']], ['rechazada', 'rechazado', 'fondos_insuficientes', REF]);
  assert.deepEqual(deps.registro.cupo, [{ filtro: { _id: EVENTO_ID }, update: { $inc: { cupoDisponible: 2 } } }]);
});

test('rechazado: sin motivo no escribe el campo; repetido es duplicado y no libera cupo otra vez', async () => {
  const sinMotivo = dobles({ lecturas: [enPago()], ganada: enPago({ estado: 'rechazada' }) });
  await pagos.registrarPagoRechazado(COMPRA_ID, { referenciaExterna: REF }, sinMotivo);
  assert.equal('pago.motivoRechazo' in sinMotivo.registro.transiciones[0].update.$set, false);

  const repetido = dobles({ lecturas: [enPago({ estado: 'rechazada' })], ganada: null });
  const { resultado } = await pagos.registrarPagoRechazado(COMPRA_ID, { referenciaExterna: REF }, repetido);
  assert.equal(resultado, 'duplicado');
  assert.equal(repetido.registro.cupo.length, 0);
});

test('rechazado sobre una compra pagada o expirada es conflicto', async () => {
  for (const estado of ['pagada', 'expirada', 'pendiente']) {
    const deps = dobles({ lecturas: [enPago(), enPago({ estado })], ganada: null });
    assert.equal((await pagos.registrarPagoRechazado(COMPRA_ID, { referenciaExterna: REF }, deps)).resultado, 'conflicto', estado);
    assert.equal(deps.registro.cupo.length, 0);
  }
});

test('procesarNotificacionPago devuelve el ACK del contrato y 409 si hay conflicto', async () => {
  const aprobada = { notificacionId: 'n', type: 'pago.aprobado', occurredAt: AHORA.toISOString(), data: { compraId: COMPRA_ID, referenciaExterna: REF, monto: 50000 } };
  const ack = await pagos.procesarNotificacionPago(aprobada, { correlationId: 'c' }, dobles({ lecturas: [enPago()], ganada: enPago({ estado: 'pagada' }) }));
  assert.deepEqual(ack, { recibido: true, duplicado: false, compraId: COMPRA_ID, estadoCompra: 'pagada' });

  const repetida = await pagos.procesarNotificacionPago(aprobada, { correlationId: 'c' }, dobles({ lecturas: [enPago({ estado: 'pagada' })] }));
  assert.equal(repetida.duplicado, true);

  const rechazada = { ...aprobada, type: 'pago.rechazado', data: { ...aprobada.data, motivo: 'fondos_insuficientes' } };
  const ackRechazo = await pagos.procesarNotificacionPago(rechazada, { correlationId: 'c' }, dobles({ lecturas: [enPago()], ganada: enPago({ estado: 'rechazada' }) }));
  assert.deepEqual([ackRechazo.estadoCompra, ackRechazo.duplicado], ['rechazada', false]);

  await assert.rejects(
    pagos.procesarNotificacionPago(rechazada, { correlationId: 'c' }, dobles({ lecturas: [enPago({ estado: 'pagada' })], ganada: null })),
    (error) => { rechazaCon('PURCHASE_INVALID_STATE', 409)(error); assert.deepEqual(error.details, { estado: 'pagada' }); return true; }
  );
});
