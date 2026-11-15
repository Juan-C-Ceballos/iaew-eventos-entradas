const { test } = require('node:test');
const assert = require('node:assert/strict');
const pagos = require('../src/services/pagos');
const { ApiError } = require('../src/lib/errors');

const AHORA = new Date('2026-11-01T12:00:00.000Z');
const COMPRA_ID = '6702a1b2c3d4e5f601234567';
const EVENTO_ID = '66f000000000000000000001';
const CLIENTE = 'canal@clients';
const CLAVE = 'pago:compra-1:v1';
const DATOS_PAGO = { clave: CLAVE, cliente: CLIENTE, correlationId: 'corr-1' };

const consulta = (valor) => ({ lean: async () => valor });
const rechazaCon = (codigo, status) => (error) => {
  assert.ok(error instanceof ApiError, `se esperaba ApiError, llegó ${error}`);
  assert.equal(error.code, codigo);
  if (status) assert.equal(error.status, status);
  return true;
};

const pendiente = (extra = {}) => ({
  _id: COMPRA_ID, eventoId: EVENTO_ID, creadaPor: CLIENTE, cantidad: 2, total: 50000, estado: 'pendiente',
  reservaExpiraEn: new Date('2026-11-01T12:10:00.000Z'), ...extra
});

// Dobles que guardan lo que se pide. `lecturas` es la secuencia de compras que devuelve findOne.
function dobles({ lecturas, iniciada = null, errorAlIniciar, cobro = async () => ({ referenciaExterna: 'PAY-1' }), expiraReserva = true }) {
  const registro = { transiciones: [], referencias: [], cobros: [], liberaciones: [], expiraciones: [] };
  let lectura = 0;
  return {
    registro,
    Compra: {
      findOne: () => consulta(lecturas[Math.min(lectura++, lecturas.length - 1)]),
      findOneAndUpdate: (filtro, update) => {
        if (filtro.reservaExpiraEn?.$lte) { registro.expiraciones.push({ filtro, update }); return consulta(expiraReserva ? { ...pendiente(), estado: 'expirada' } : null); }
        registro.transiciones.push({ filtro, update });
        if (errorAlIniciar) throw errorAlIniciar;
        return consulta(iniciada);
      },
      updateOne: async (filtro, update) => { registro.referencias.push({ filtro, update }); }
    },
    Evento: { updateOne: async (filtro, update) => { registro.liberaciones.push({ filtro, update }); } },
    cobrar: async (pedido) => { registro.cobros.push(pedido); return cobro(pedido); }
  };
}

const solicitar = (deps, cuerpo = {}) => pagos.solicitarPago(COMPRA_ID, cuerpo, DATOS_PAGO, { ...deps, ahora: AHORA, pagoTimeoutMinutos: 30 });

test('primero persiste pago_pendiente con el vencimiento y después llama a la pasarela', async () => {
  const iniciada = pendiente({ estado: 'pago_pendiente', pago: { estado: 'pendiente', idempotencyKey: CLAVE } });
  const deps = dobles({ lecturas: [pendiente(), { ...iniciada, pago: { ...iniciada.pago, referenciaExterna: 'PAY-1' } }], iniciada });
  const { compra, replayed } = await solicitar(deps, { escenario: 'rechazado' });

  const { filtro, update } = deps.registro.transiciones[0];
  assert.deepEqual(filtro, { _id: COMPRA_ID, creadaPor: CLIENTE, estado: 'pendiente', reservaExpiraEn: { $gt: AHORA } });
  assert.equal(update.$set.estado, 'pago_pendiente');
  assert.deepEqual(update.$set.pagoExpiraEn, new Date('2026-11-01T12:30:00.000Z'));
  assert.deepEqual(update.$set.pago, { estado: 'pendiente', idempotencyKey: CLAVE, solicitadoEn: AHORA });

  assert.deepEqual(deps.registro.cobros, [{ compraId: COMPRA_ID, monto: 50000, escenario: 'rechazado', correlationId: 'corr-1' }]);
  assert.deepEqual(deps.registro.referencias[0].update, { $set: { 'pago.referenciaExterna': 'PAY-1' } });
  assert.deepEqual(deps.registro.referencias[0].filtro['pago.referenciaExterna'], { $exists: false }, 'no pisa una referencia que ya guardó el webhook');
  assert.equal(replayed, false);
  assert.equal(compra.pago.referenciaExterna, 'PAY-1');
});

test('el escenario por defecto es aprobado', async () => {
  const deps = dobles({ lecturas: [pendiente()], iniciada: pendiente({ estado: 'pago_pendiente' }) });
  await solicitar(deps);
  assert.equal(deps.registro.cobros[0].escenario, 'aprobado');
});

test('si la pasarela falla responde 503 y la compra queda en pago_pendiente (no se revierte)', async () => {
  const caida = new ApiError({ status: 503, error: 'La pasarela de pago no responde', code: 'PAYMENT_PROVIDER_UNAVAILABLE', action: 'Reintentar', retryable: true });
  const deps = dobles({ lecturas: [pendiente()], iniciada: pendiente({ estado: 'pago_pendiente' }), cobro: async () => { throw caida; } });
  await assert.rejects(solicitar(deps), rechazaCon('PAYMENT_PROVIDER_UNAVAILABLE', 503));
  assert.equal(deps.registro.transiciones.length, 1);
  assert.equal(deps.registro.referencias.length, 0);
  assert.equal(deps.registro.liberaciones.length, 0, 'no se libera cupo ni se vuelve a pendiente');
});

test('reintentar con la misma clave sin referencia vuelve a enviar el cobro', async () => {
  const enCurso = pendiente({ estado: 'pago_pendiente', pago: { estado: 'pendiente', idempotencyKey: CLAVE } });
  const deps = dobles({ lecturas: [enCurso, enCurso] });
  const { replayed } = await solicitar(deps);
  assert.equal(replayed, true);
  assert.equal(deps.registro.cobros.length, 1);
  assert.equal(deps.registro.transiciones.length, 0, 'no vuelve a hacer la transición');
});

test('reintentar con la misma clave y con referencia devuelve el resultado original sin llamar a la pasarela', async () => {
  for (const estado of ['pago_pendiente', 'pagada', 'rechazada']) {
    const hecha = pendiente({ estado, pago: { estado: 'pendiente', idempotencyKey: CLAVE, referenciaExterna: 'PAY-1' } });
    const deps = dobles({ lecturas: [hecha] });
    const { compra, replayed } = await solicitar(deps);
    assert.equal(replayed, true, estado);
    assert.equal(compra.estado, estado);
    assert.equal(deps.registro.cobros.length, 0);
  }
});

test('otra clave sobre una compra en pago_pendiente es 409 PURCHASE_INVALID_STATE', async () => {
  const enCurso = pendiente({ estado: 'pago_pendiente', pago: { estado: 'pendiente', idempotencyKey: 'otra-clave-1', referenciaExterna: 'PAY-1' } });
  const deps = dobles({ lecturas: [enCurso] });
  await assert.rejects(solicitar(deps), (error) => {
    rechazaCon('PURCHASE_INVALID_STATE', 409)(error);
    assert.deepEqual(error.details, { estado: 'pago_pendiente' });
    return true;
  });
  assert.equal(deps.registro.cobros.length, 0);
});

test('una compra que no está pendiente no se puede pagar', async () => {
  for (const estado of ['pagada', 'rechazada', 'cancelada', 'expirada']) {
    await assert.rejects(solicitar(dobles({ lecturas: [pendiente({ estado })] })), rechazaCon('PURCHASE_INVALID_STATE', 409), estado);
  }
});

test('una compra inexistente o de otro cliente es 404 PURCHASE_NOT_FOUND', async () => {
  await assert.rejects(solicitar(dobles({ lecturas: [null] })), rechazaCon('PURCHASE_NOT_FOUND', 404));
});

test('con la reserva vencida la compra pasa a expirada, se libera el cupo y responde 409 RESERVATION_EXPIRED', async () => {
  const deps = dobles({ lecturas: [pendiente({ reservaExpiraEn: new Date('2026-11-01T11:59:00.000Z') })] });
  await assert.rejects(solicitar(deps), rechazaCon('RESERVATION_EXPIRED', 409));
  assert.equal(deps.registro.expiraciones.length, 1);
  assert.deepEqual(deps.registro.liberaciones[0], { filtro: { _id: EVENTO_ID }, update: { $inc: { cupoDisponible: 2 } } });
  assert.equal(deps.registro.cobros.length, 0);
});

test('si el barrido ya expiró la reserva, no se libera el cupo dos veces', async () => {
  const deps = dobles({ lecturas: [pendiente({ reservaExpiraEn: new Date('2026-11-01T11:59:00.000Z') })], expiraReserva: false });
  await assert.rejects(solicitar(deps), rechazaCon('RESERVATION_EXPIRED', 409));
  assert.equal(deps.registro.liberaciones.length, 0);
});

test('una Idempotency-Key ya usada en otra compra es 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
  const duplicada = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const deps = dobles({ lecturas: [pendiente()], errorAlIniciar: duplicada });
  await assert.rejects(solicitar(deps), rechazaCon('IDEMPOTENCY_KEY_MISMATCH', 409));
  assert.equal(deps.registro.cobros.length, 0);
});

test('si otro request gana la transición, relee; si pierde siempre, 409 CONCURRENT_UPDATE reintentable', async () => {
  // Otro request ya la pasó a pago_pendiente con otra clave: en la segunda lectura se rechaza por estado.
  const ajena = pendiente({ estado: 'pago_pendiente', pago: { idempotencyKey: 'otra-clave-1', referenciaExterna: 'PAY-9' } });
  const perdida = dobles({ lecturas: [pendiente(), ajena], iniciada: null });
  await assert.rejects(solicitar(perdida), rechazaCon('PURCHASE_INVALID_STATE', 409));
  assert.equal(perdida.registro.transiciones.length, 1);

  const siempre = dobles({ lecturas: [pendiente()], iniciada: null });
  await assert.rejects(solicitar(siempre), (error) => {
    rechazaCon('CONCURRENT_UPDATE', 409)(error);
    assert.equal(error.retryable, true);
    return true;
  });
});
