const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emitirEntradasDeCompra } = require('../src/services/emision');
const { ErrorPermanente } = require('../src/lib/consumidor');

const AHORA = new Date('2026-11-01T12:00:00.000Z');
const COMPRA_ID = '6702a1b2c3d4e5f601234567';
const EVENTO_ID = '66f000000000000000000001';
const ASISTENTE_ID = '6702a1b2c3d4e5f601234500';
const SOBRE = { eventId: '3f5204d4-8952-4a3f-92ea-0a6222151299', type: 'entrada.comprada', version: 1, occurredAt: AHORA.toISOString(), correlationId: 'corr-1', data: { compraId: COMPRA_ID } };

const consulta = (valor) => ({ select: () => consulta(valor), lean: async () => valor, then: (ok, fallo) => Promise.resolve(valor).then(ok, fallo) });

const pagada = (extra = {}) => ({
  _id: COMPRA_ID, eventoId: EVENTO_ID, asistenteId: ASISTENTE_ID, cantidad: 3, estado: 'pagada',
  asistente: { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' }, ...extra
});

function dobles({ procesado = false, compra = pagada(), eventoEstado = 'publicado', errorAlEmitir = null, errorAlRegistrar = null } = {}) {
  const registro = { upserts: [], compras: [], procesados: [] };
  return {
    registro,
    Compra: {
      findById: () => consulta(compra),
      updateOne: async (filtro, update) => { registro.compras.push({ filtro, update }); }
    },
    Evento: { findById: () => consulta({ estado: eventoEstado }) },
    Entrada: {
      updateOne: async (filtro, update, opciones) => {
        if (errorAlEmitir) throw errorAlEmitir;
        registro.upserts.push({ filtro, update, opciones });
      }
    },
    EventoProcesado: {
      exists: () => consulta(procesado ? { _id: 'x' } : null),
      create: async (datos) => { if (errorAlRegistrar) throw errorAlRegistrar; registro.procesados.push(datos); }
    },
    ahora: AHORA
  };
}

test('emite una entrada por unidad con el titular del snapshot y marca la compra como emitida', async () => {
  const deps = dobles();
  const resultado = await emitirEntradasDeCompra(SOBRE, deps);

  assert.deepEqual(resultado, { resultado: 'emitidas', cantidad: 3 });
  assert.deepEqual(deps.registro.upserts.map((u) => u.filtro), [1, 2, 3].map((numero) => ({ compraId: COMPRA_ID, numero })));
  const { update, opciones } = deps.registro.upserts[0];
  assert.deepEqual(opciones, { upsert: true });
  const nueva = update.$setOnInsert;
  assert.match(nueva.codigo, /^ENT-[A-Z0-9]{12}$/);
  assert.deepEqual([nueva.estado, nueva.eventoId, nueva.asistenteId, nueva.emitidaEn], ['emitida', EVENTO_ID, ASISTENTE_ID, AHORA]);
  assert.deepEqual(nueva.titular, { nombre: 'Ana Pérez', documento: '40123456' }, 'sin el email');
  assert.equal(new Set(deps.registro.upserts.map((u) => u.update.$setOnInsert.codigo)).size, 3, 'códigos distintos');

  assert.deepEqual(deps.registro.compras[0], { filtro: { _id: COMPRA_ID, emisionEstado: { $ne: 'emitida' } }, update: { $set: { emisionEstado: 'emitida', emitidaEn: AHORA } } });
  assert.deepEqual(deps.registro.procesados, [{ eventId: SOBRE.eventId, type: 'entrada.comprada', compraId: COMPRA_ID }]);
});

test('un eventId ya procesado es un duplicado: no toca nada', async () => {
  const deps = dobles({ procesado: true });
  assert.deepEqual(await emitirEntradasDeCompra(SOBRE, deps), { resultado: 'duplicado' });
  assert.equal(deps.registro.upserts.length, 0);
  assert.equal(deps.registro.compras.length, 0);
});

test('el eventId se registra al final: si falla la emisión, un reintento todavía puede emitir', async () => {
  const deps = dobles({ errorAlEmitir: new Error('mongo caído') });
  await assert.rejects(emitirEntradasDeCompra(SOBRE, deps), /mongo caído/);
  assert.equal(deps.registro.procesados.length, 0, 'sin registro, el reintento no lo toma por duplicado');
  assert.equal(deps.registro.compras.length, 0);
});

test('si el evento está cancelado las entradas nacen anuladas', async () => {
  const deps = dobles({ eventoEstado: 'cancelado' });
  await emitirEntradasDeCompra(SOBRE, deps);
  assert.ok(deps.registro.upserts.every((u) => u.update.$setOnInsert.estado === 'anulada'));
});

test('una compra inexistente o no pagada es un error permanente (a la DLQ)', async () => {
  await assert.rejects(emitirEntradasDeCompra(SOBRE, dobles({ compra: null })), (error) => error instanceof ErrorPermanente && error.razon === 'compra_not_found');
  for (const estado of ['pendiente', 'pago_pendiente', 'rechazada', 'cancelada', 'expirada']) {
    await assert.rejects(emitirEntradasDeCompra(SOBRE, dobles({ compra: pagada({ estado }) })), (error) => error instanceof ErrorPermanente && error.razon === 'compra_not_paid', estado);
  }
});

test('un choque del índice (compraId, numero) significa que otro proceso la emitió: se sigue', async () => {
  const choque = Object.assign(new Error('E11000'), { code: 11000, keyPattern: { compraId: 1, numero: 1 } });
  const deps = dobles({ errorAlEmitir: choque });
  assert.deepEqual(await emitirEntradasDeCompra(SOBRE, deps), { resultado: 'emitidas', cantidad: 3 });
});

test('un choque de código se resuelve con otro código y, si persiste, es un error transitorio', async () => {
  const choqueDeCodigo = Object.assign(new Error('E11000'), { code: 11000, keyPattern: { codigo: 1 } });
  let intentos = 0;
  const deps = dobles({ compra: pagada({ cantidad: 1 }) });
  deps.Entrada.updateOne = async (filtro, update) => { intentos += 1; if (intentos < 3) throw choqueDeCodigo; deps.registro.upserts.push({ filtro, update }); };
  await emitirEntradasDeCompra(SOBRE, deps);
  assert.equal(intentos, 3);

  const siempre = dobles({ compra: pagada({ cantidad: 1 }), errorAlEmitir: choqueDeCodigo });
  await assert.rejects(emitirEntradasDeCompra(SOBRE, siempre), (error) => !(error instanceof ErrorPermanente) && /código de entrada único/.test(error.message));
});

test('si otro worker registró el eventId a la vez, el resultado es el mismo', async () => {
  const duplicado = Object.assign(new Error('E11000'), { code: 11000 });
  assert.deepEqual(await emitirEntradasDeCompra(SOBRE, dobles({ errorAlRegistrar: duplicado })), { resultado: 'emitidas', cantidad: 3 });
  await assert.rejects(emitirEntradasDeCompra(SOBRE, dobles({ errorAlRegistrar: new Error('mongo caído') })), /mongo caído/);
});
