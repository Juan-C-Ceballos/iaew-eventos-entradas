const { test } = require('node:test');
const assert = require('node:assert/strict');
const entradas = require('../src/services/entradas');
const reporte = require('../src/services/reporte');
const { ApiError } = require('../src/lib/errors');

const AHORA = new Date('2026-11-20T23:41:10.000Z');
const CODIGO = 'ENT-7K2M9Q4XA1B3';
const EVENTO_ID = '66f000000000000000000001';
const OTRO_EVENTO = '66f000000000000000000002';
const consulta = (valor) => ({ select: () => consulta(valor), lean: async () => valor });

const emitida = (extra = {}) => ({ _id: 'e1', codigo: CODIGO, eventoId: EVENTO_ID, estado: 'emitida', titular: { nombre: 'Ana', documento: '40123456' }, __v: 0, ...extra });
const rechazaCon = (codigo, status = 409) => (error) => {
  assert.ok(error instanceof ApiError, `se esperaba ApiError, llegó ${error}`);
  assert.equal(error.code, codigo);
  assert.equal(error.status, status);
  return true;
};

// Anota qué se consulta, para comprobar el orden de las comprobaciones (ADR 0012).
function dobles({ lecturas, evento = { estado: 'publicado' }, usada = null }) {
  const registro = [];
  let lectura = 0;
  return {
    registro,
    Entrada: {
      findOne: () => { registro.push('buscar entrada'); return consulta(lecturas[Math.min(lectura++, lecturas.length - 1)]); },
      findOneAndUpdate: (filtro, update) => { registro.push({ filtro, update }); return consulta(usada); }
    },
    Evento: { findById: () => { registro.push('buscar evento'); return consulta(evento); } },
    ahora: AHORA
  };
}
const validar = (deps, eventoId = EVENTO_ID) => entradas.validar(CODIGO, { eventoId }, { cliente: 'puerta@clients' }, deps);

test('validar: la transición emitida→usada registra quién y cuándo, y devuelve acceso_permitido', async () => {
  const deps = dobles({ lecturas: [emitida()], usada: emitida({ estado: 'usada', usadaEn: AHORA, validadaPor: 'puerta@clients' }) });
  const respuesta = await validar(deps);
  assert.equal(respuesta.resultado, 'acceso_permitido');
  assert.deepEqual([respuesta.entrada.estado, respuesta.entrada.validadaPor], ['usada', 'puerta@clients']);
  assert.equal('__v' in respuesta.entrada, false);
  assert.deepEqual(deps.registro[2], { filtro: { codigo: CODIGO, estado: 'emitida' }, update: { $set: { estado: 'usada', usadaEn: AHORA, validadaPor: 'puerta@clients' } } });
});

test('validar: las comprobaciones van en orden y las que fallan no escriben', async () => {
  const inexistente = dobles({ lecturas: [null] });
  await assert.rejects(validar(inexistente), rechazaCon('TICKET_NOT_FOUND', 404));
  assert.deepEqual(inexistente.registro, ['buscar entrada']);

  const otroEvento = dobles({ lecturas: [emitida({ eventoId: OTRO_EVENTO })] });
  await assert.rejects(validar(otroEvento), (error) => {
    rechazaCon('TICKET_WRONG_EVENT')(error);
    assert.deepEqual(error.details, { eventoEntrada: OTRO_EVENTO });
    return true;
  });
  assert.deepEqual(otroEvento.registro, ['buscar entrada'], 'ni siquiera consulta el evento');

  const eventoCancelado = dobles({ lecturas: [emitida()], evento: { estado: 'cancelado' } });
  await assert.rejects(validar(eventoCancelado), (error) => {
    rechazaCon('EVENT_NOT_ACTIVE')(error);
    assert.deepEqual(error.details, { estado: 'cancelado' });
    return true;
  });
  assert.deepEqual(eventoCancelado.registro, ['buscar entrada', 'buscar evento'], 'no intenta la transición');
});

test('validar: el eventoId se compara sin distinguir mayúsculas del hexadecimal', async () => {
  const deps = dobles({ lecturas: [emitida()], usada: emitida({ estado: 'usada' }) });
  assert.equal((await validar(deps, EVENTO_ID.toUpperCase())).resultado, 'acceso_permitido');
});

test('validar: si la transición no aplica, informa si ya se usó o si fue anulada', async () => {
  const yaUsada = dobles({ lecturas: [emitida(), emitida({ estado: 'usada', usadaEn: AHORA })] });
  await assert.rejects(validar(yaUsada), (error) => {
    rechazaCon('TICKET_ALREADY_USED')(error);
    assert.deepEqual(error.details, { usadaEn: AHORA.toISOString() });
    return true;
  });
  const anulada = dobles({ lecturas: [emitida(), emitida({ estado: 'anulada' })] });
  await assert.rejects(validar(anulada), rechazaCon('TICKET_VOIDED'));
});

test('validar: una entrada de un evento no publicado responde EVENT_NOT_ACTIVE antes de mirar si está anulada', async () => {
  for (const estado of ['borrador', 'finalizado', 'cancelado']) {
    const deps = dobles({ lecturas: [emitida({ estado: 'anulada' })], evento: { estado } });
    await assert.rejects(validar(deps), rechazaCon('EVENT_NOT_ACTIVE'), estado);
  }
});

test('obtener: devuelve la entrada sin __v; un código inexistente o mal formado es 404', async () => {
  const entrada = await entradas.obtener(CODIGO, { Entrada: { findOne: () => consulta(emitida()) } });
  assert.equal(entrada.codigo, CODIGO);
  assert.equal('__v' in entrada, false);
  await assert.rejects(entradas.obtener(CODIGO, { Entrada: { findOne: () => consulta(null) } }), rechazaCon('TICKET_NOT_FOUND', 404));
  await assert.rejects(entradas.obtener('xyz', { Entrada: { findOne: () => assert.fail('no debe consultar') } }), rechazaCon('TICKET_NOT_FOUND', 404));
});

test('reporte: suma las compras pagadas por evento y deja en 0 los eventos sin ventas', async () => {
  const Evento = { find: () => ({ sort: () => ({ select: () => consulta([
    { _id: 'a', nombre: 'Recital', capacidad: 500, cupoDisponible: 498 },
    { _id: 'b', nombre: 'Jazz', capacidad: 2, cupoDisponible: 2 }
  ]) }) }) };
  const Compra = { aggregate: async (etapas) => {
    assert.deepEqual(etapas[0], { $match: { estado: 'pagada' } });
    return [{ _id: 'a', entradasVendidas: 3, recaudado: 0.1 + 0.2 + 74999.7 }];
  } };
  const resultado = await reporte.ventasPorEvento({ Evento, Compra, ahora: AHORA });
  assert.equal(resultado.generadoEn, AHORA.toISOString());
  assert.deepEqual(resultado.eventos, [
    { eventoId: 'a', nombre: 'Recital', capacidad: 500, cupoDisponible: 498, entradasVendidas: 3, recaudado: 75000 },
    { eventoId: 'b', nombre: 'Jazz', capacidad: 2, cupoDisponible: 2, entradasVendidas: 0, recaudado: 0 }
  ]);
});
