const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicarPendientes } = require('../src/lib/outbox');

function evento(compraId) {
  return { eventId: `evt-${compraId}`, type: 'entrada.comprada', version: 1, occurredAt: '2026-10-03T15:00:00.000Z', correlationId: `corr-${compraId}`, data: { compraId } };
}

function repositorioEnMemoria(compras) {
  const marcadas = [];
  return {
    marcadas,
    buscarPendientes: async (limite) => compras.filter((c) => !marcadas.includes(c._id)).slice(0, limite),
    marcarPublicada: async (id) => { marcadas.push(id); }
  };
}

test('publica cada evento pendiente y lo marca como publicado', async () => {
  const repositorio = repositorioEnMemoria([{ _id: 'a', emisionEvento: evento('a') }, { _id: 'b', emisionEvento: evento('b') }]);
  const publicados = [];
  const total = await publicarPendientes({ repositorio, publish: async (e) => { publicados.push(e.eventId); } });
  assert.equal(total, 2);
  assert.deepEqual(publicados, ['evt-a', 'evt-b']);
  assert.deepEqual(repositorio.marcadas, ['a', 'b']);
});

test('si el broker falla, no marca y deja el resto pendiente para la próxima pasada', async () => {
  const repositorio = repositorioEnMemoria([{ _id: 'a', emisionEvento: evento('a') }, { _id: 'b', emisionEvento: evento('b') }]);
  const publish = async (e) => { if (e.eventId === 'evt-a') throw new Error('broker caído'); };
  await assert.rejects(publicarPendientes({ repositorio, publish }), /broker caído/);
  assert.deepEqual(repositorio.marcadas, []);
});

test('respeta el límite por pasada', async () => {
  const compras = ['a', 'b', 'c'].map((id) => ({ _id: id, emisionEvento: evento(id) }));
  const repositorio = repositorioEnMemoria(compras);
  const total = await publicarPendientes({ repositorio, publish: async () => {}, limite: 2 });
  assert.equal(total, 2);
  assert.deepEqual(repositorio.marcadas, ['a', 'b']);
});
