const { test } = require('node:test');
const assert = require('node:assert/strict');
const barrido = require('../src/lib/barrido');

const AHORA = new Date('2026-11-01T12:00:00.000Z');
const consulta = (valor) => ({ sort: () => consulta(valor), limit: () => consulta(valor), select: () => consulta(valor), lean: async () => valor });
const sinLog = () => ({
  lines: [],
  log(m, campos) { this.lines.push(`log:${m}${campos ? ` ${JSON.stringify(campos)}` : ''}`); },
  warn(m) { this.lines.push(`warn:${m}`); },
  error(m) { this.lines.push(`error:${m}`); }
});

// Modelos vacíos: no hay nada que hacer. Anota cuántas veces se consulta cada colección.
function modelosVacios() {
  const llamadas = { comprasFind: 0, eventosFind: 0, eventosUpdateMany: 0, aggregate: 0 };
  return {
    llamadas,
    Compra: { find: () => { llamadas.comprasFind += 1; return consulta([]); }, aggregate: async () => { llamadas.aggregate += 1; return []; } },
    Evento: {
      find: () => { llamadas.eventosFind += 1; return consulta([]); },
      updateMany: async () => { llamadas.eventosUpdateMany += 1; return { modifiedCount: 0 }; }
    }
  };
}

test('reconciliarCupo: la diferencia se corrige recién cuando se repite idéntica en dos barridos', async () => {
  const observadas = new Map();
  const log = sinLog();
  const actualizaciones = [];
  const evento = { _id: 'e1', capacidad: 10, cupoDisponible: 4 }; // ocupadas: 5 → esperado 5
  const Evento = {
    find: () => consulta([evento]),
    updateOne: async (filtro, update) => { actualizaciones.push({ filtro, update }); return { modifiedCount: 1 }; }
  };
  const Compra = { aggregate: async () => [{ _id: 'e1', total: 5 }] };
  const correr = () => barrido.reconciliarCupo({ Evento, Compra, observadas, log });

  assert.deepEqual(await correr(), { corregidos: 0, observados: 1 }, 'primera vez: solo se observa');
  assert.equal(actualizaciones.length, 0);

  assert.deepEqual(await correr(), { corregidos: 1, observados: 0 }, 'segunda vez idéntica: se corrige');
  assert.deepEqual(actualizaciones[0], { filtro: { _id: 'e1', cupoDisponible: 4 }, update: { $set: { cupoDisponible: 5 } } }, 'condicionado al valor observado');
  assert.ok(log.lines.some((l) => l.startsWith('error:cupo_reconciliado')));
  assert.equal(observadas.size, 0);
});

test('reconciliarCupo: una diferencia que cambia o desaparece entre barridos era una reserva en curso', async () => {
  const observadas = new Map();
  const actualizaciones = [];
  const evento = { _id: 'e1', capacidad: 10, cupoDisponible: 4 };
  let ocupadas = 5; // esperado 5
  const Evento = { find: () => consulta([evento]), updateOne: async (f, u) => { actualizaciones.push({ f, u }); return { modifiedCount: 1 }; } };
  const Compra = { aggregate: async () => [{ _id: 'e1', total: ocupadas }] };
  const correr = () => barrido.reconciliarCupo({ Evento, Compra, observadas, log: sinLog() });

  assert.deepEqual(await correr(), { corregidos: 0, observados: 1 }); // cupo 4, esperado 5

  evento.cupoDisponible = 2; ocupadas = 7; // otra diferencia (cupo 2, esperado 3): no es la misma, se observa de nuevo
  assert.deepEqual(await correr(), { corregidos: 0, observados: 1 });
  assert.deepEqual(observadas.get('e1'), { observado: 2, esperado: 3 });

  evento.cupoDisponible = 3; // se resolvió sola: se olvida la observación
  assert.deepEqual(await correr(), { corregidos: 0, observados: 0 });
  assert.equal(observadas.size, 0);
  assert.equal(actualizaciones.length, 0, 'nunca se corrigió nada');
});

test('reconciliarCupo: si el update condicional no aplica (cambió el cupo) no cuenta como corregido', async () => {
  const observadas = new Map([['e1', { observado: 4, esperado: 5 }]]);
  const Evento = { find: () => consulta([{ _id: 'e1', capacidad: 10, cupoDisponible: 4 }]), updateOne: async () => ({ modifiedCount: 0 }) };
  const Compra = { aggregate: async () => [{ _id: 'e1', total: 5 }] };
  assert.deepEqual(await barrido.reconciliarCupo({ Evento, Compra, observadas, log: sinLog() }), { corregidos: 0, observados: 0 });
});

test('reconciliarCupo: con más entradas que capacidad no hay cupo al que volver y no se toca', async () => {
  const log = sinLog();
  const Evento = { find: () => consulta([{ _id: 'e1', capacidad: 2, cupoDisponible: 0 }]), updateOne: async () => assert.fail('no debe corregir') };
  const Compra = { aggregate: async () => [{ _id: 'e1', total: 3 }] };
  const observadas = new Map();
  await barrido.reconciliarCupo({ Evento, Compra, observadas, log });
  await barrido.reconciliarCupo({ Evento, Compra, observadas, log });
  assert.ok(log.lines.some((l) => l.includes('cupo_inconsistente')));
});

test('reconciliarCupo: un evento sin compras debe tener el cupo completo', async () => {
  const actualizaciones = [];
  const Evento = { find: () => consulta([{ _id: 'e1', capacidad: 10, cupoDisponible: 7 }]), updateOne: async (f, u) => { actualizaciones.push(u); return { modifiedCount: 1 }; } };
  const observadas = new Map();
  const dependencias = { Evento, Compra: { aggregate: async () => [] }, observadas, log: sinLog() };
  await barrido.reconciliarCupo(dependencias);
  await barrido.reconciliarCupo(dependencias);
  assert.deepEqual(actualizaciones, [{ $set: { cupoDisponible: 10 } }]);
});

test('una pasada ejecuta los cinco pasos y no registra nada si no hubo cambios', async () => {
  const modelos = modelosVacios();
  const log = sinLog();
  const { pasada } = barrido.crearBarrido({ ...modelos, ahora: AHORA, log });
  const resultados = await pasada();
  assert.deepEqual(Object.keys(resultados), ['reservasExpiradas', 'pagos', 'eventosFinalizados', 'cancelacionesCompletadas', 'cupo']);
  assert.equal(modelos.llamadas.eventosUpdateMany, 1);
  assert.equal(modelos.llamadas.aggregate, 1);
  assert.deepEqual(log.lines, []);
});

test('un paso que falla se registra y no impide a los demás', async () => {
  const modelos = modelosVacios();
  const log = sinLog();
  modelos.Compra.find = () => { throw new Error('mongo caído'); };
  const { pasada } = barrido.crearBarrido({ ...modelos, ahora: AHORA, log });
  const resultados = await pasada();

  assert.deepEqual(resultados.reservasExpiradas, { error: 'mongo caído' });
  assert.deepEqual(resultados.pagos, { error: 'mongo caído' });
  assert.equal(resultados.eventosFinalizados, 0, 'los pasos que no usan compras siguieron');
  assert.equal(modelos.llamadas.eventosUpdateMany, 1);
  assert.equal(log.lines.filter((l) => l.startsWith('error:Barrido: falló el paso')).length, 2);
});

test('una pasada que cambia algo lo registra, y no es re-entrante', async () => {
  const modelos = modelosVacios();
  modelos.Evento.updateMany = async () => { modelos.llamadas.eventosUpdateMany += 1; await new Promise((r) => setTimeout(r, 40)); return { modifiedCount: 2 }; };
  const log = sinLog();
  const { pasada, esperarEnCurso } = barrido.crearBarrido({ ...modelos, ahora: AHORA, log });

  const [a, b] = await Promise.all([pasada(), pasada()]);
  assert.equal(a, b, 'la segunda llamada comparte la pasada en curso');
  assert.equal(modelos.llamadas.eventosUpdateMany, 1);
  assert.equal(log.lines.filter((l) => l.startsWith('log:Barrido:')).length, 1);
  assert.match(log.lines[0], /"eventosFinalizados":2/);
  await esperarEnCurso();
});

test('finalizarEventosTerminados usa el plazo en horas desde la fecha del evento', async () => {
  let filtro;
  const Evento = { updateMany: async (f) => { filtro = f; return { modifiedCount: 1 }; } };
  assert.equal(await barrido.finalizarEventosTerminados({ Evento, ahora: AHORA, eventoFinalizaTrasHoras: 12 }), 1);
  assert.deepEqual(filtro, { estado: 'publicado', fecha: { $lte: new Date('2026-11-01T00:00:00.000Z') } });
});

test('iniciarBarrido corre una pasada inmediata y cada intervalo, y al detenerlo no dispara otra', async () => {
  const modelos = modelosVacios();
  const detener = barrido.iniciarBarrido({ ...modelos, intervaloMs: 30, log: sinLog() });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(modelos.llamadas.eventosUpdateMany, 1, 'primera pasada inmediata');
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(modelos.llamadas.eventosUpdateMany >= 3, `pasadas: ${modelos.llamadas.eventosUpdateMany}`);

  await detener();
  const alDetener = modelos.llamadas.eventosUpdateMany;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(modelos.llamadas.eventosUpdateMany, alDetener, 'sin pasadas después de detener');
});

test('conciliación: si la pasarela no responde, el paso se corta en la primera compra y se registra un solo error', async () => {
  const vencidas = [{ _id: 'c1' }, { _id: 'c2' }, { _id: 'c3' }];
  const Compra = { find: () => consulta(vencidas) };
  const log = sinLog();
  const consultadas = [];
  const consultar = async (id) => { consultadas.push(id); throw new Error('timeout'); };

  const resumen = await barrido.conciliarPagosVencidos({ Compra, consultar, log, ahora: AHORA });
  assert.deepEqual(consultadas, ['c1'], 'no se le pregunta por las demás: cada intento esperaría hasta el timeout');
  assert.deepEqual(resumen, { pagadas: 0, rechazadas: 0, expiradas: 0, pendientes: 0, sinRespuesta: 3 });
  assert.equal(log.lines.filter((l) => l.startsWith('error:Conciliación')).length, 1);
  assert.match(log.lines[0], /las 3 compra\(s\) restantes se reintentan en el próximo barrido/);
});

test('conciliación: lo resuelto antes del fallo se conserva y solo las no consultadas quedan sin respuesta', async () => {
  const vencidas = [{ _id: 'c1' }, { _id: 'c2' }, { _id: 'c3' }, { _id: 'c4' }];
  const Compra = { find: () => consulta(vencidas) };
  const consultadas = [];
  const consultar = async (id) => {
    consultadas.push(id);
    if (id === 'c1') return { estado: 'pendiente', referenciaExterna: 'PAY-1' }; // la pasarela todavía lo procesa
    throw new Error('conexión rechazada');
  };

  const resumen = await barrido.conciliarPagosVencidos({ Compra, consultar, log: sinLog(), ahora: AHORA });
  assert.deepEqual(consultadas, ['c1', 'c2']);
  assert.deepEqual([resumen.pendientes, resumen.sinRespuesta], [1, 3], 'c2 falló y c3 y c4 no se consultaron');
});

test('conciliación: con la pasarela sana consulta todas las compras vencidas', async () => {
  const vencidas = [{ _id: 'c1' }, { _id: 'c2' }, { _id: 'c3' }];
  const consultadas = [];
  const consultar = async (id) => { consultadas.push(id); return { estado: 'pendiente', referenciaExterna: `PAY-${id}` }; };
  const resumen = await barrido.conciliarPagosVencidos({ Compra: { find: () => consulta(vencidas) }, consultar, log: sinLog(), ahora: AHORA });
  assert.deepEqual(consultadas, ['c1', 'c2', 'c3']);
  assert.deepEqual([resumen.pendientes, resumen.sinRespuesta], [3, 0]);
});

test('un fallo de la pasarela en la conciliación no impide a los otros pasos de la pasada', async () => {
  const modelos = modelosVacios();
  modelos.Compra.find = () => consulta([{ _id: 'c1' }]);
  const log = sinLog();
  const { pasada } = barrido.crearBarrido({ ...modelos, consultar: async () => { throw new Error('timeout'); }, ahora: AHORA, log });
  const resultados = await pasada();
  assert.equal(resultados.pagos.sinRespuesta, 1);
  assert.equal(resultados.eventosFinalizados, 0, 'el paso siguiente corrió');
  assert.equal(modelos.llamadas.eventosUpdateMany, 1);
  assert.equal(modelos.llamadas.aggregate, 1, 'y también la reconciliación de cupo, que es el último');
});
