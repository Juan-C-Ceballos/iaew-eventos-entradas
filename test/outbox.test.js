const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicarPendientes, crearPasada } = require('../src/lib/outbox');

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

function logEspia() {
  const lineas = { log: [], error: [] };
  return { lineas, log: (m) => lineas.log.push(m), error: (m) => lineas.error.push(m) };
}

test('con el broker caído, el relay registra el error una sola vez y no en cada pasada', async () => {
  const repositorio = repositorioEnMemoria([{ _id: 'a', emisionEvento: evento('a') }]);
  const log = logEspia();
  const pasada = crearPasada({ repositorio, publish: async () => { throw new Error('connect ECONNREFUSED'); }, log });
  for (let i = 0; i < 5; i += 1) await pasada();
  assert.equal(log.lineas.error.length, 1);
  assert.match(log.lineas.error[0], /ECONNREFUSED/);
  assert.deepEqual(repositorio.marcadas, []);
});

test('si el error cambia, se registra de nuevo', async () => {
  const repositorio = repositorioEnMemoria([{ _id: 'a', emisionEvento: evento('a') }]);
  const log = logEspia();
  const errores = ['getaddrinfo ENOTFOUND rabbitmq', 'getaddrinfo ENOTFOUND rabbitmq', 'connect ECONNREFUSED'];
  const pasada = crearPasada({ repositorio, publish: async () => { throw new Error(errores.shift()); }, log });
  for (let i = 0; i < 3; i += 1) await pasada();
  assert.equal(log.lineas.error.length, 2);
});

test('al recuperarse publica, avisa una vez y vuelve a registrar un fallo posterior', async () => {
  const repositorio = repositorioEnMemoria([{ _id: 'a', emisionEvento: evento('a') }]);
  const log = logEspia();
  let caido = true;
  const pasada = crearPasada({ repositorio, publish: async () => { if (caido) throw new Error('broker caído'); }, log });
  await pasada();
  await pasada();
  caido = false;
  await pasada();
  assert.deepEqual(repositorio.marcadas, ['a']);
  assert.deepEqual(log.lineas.log, ['Outbox: la publicación se restableció', 'Outbox: 1 evento(s) entrada.comprada publicados']);

  repositorio.marcadas.length = 0; // un evento nuevo y otra caída
  caido = true;
  await pasada();
  assert.equal(log.lineas.error.length, 2);
});

test('una pasada sin nada pendiente y sin errores no escribe nada', async () => {
  const log = logEspia();
  await crearPasada({ repositorio: repositorioEnMemoria([]), publish: async () => {}, log })();
  assert.deepEqual(log.lineas, { log: [], error: [] });
});
