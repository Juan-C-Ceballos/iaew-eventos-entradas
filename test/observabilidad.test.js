const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { crearEmisor } = require('./helpers/emisor');

// Logs JSON correlacionables y métricas para el dashboard (ADR 0008): lo que se escribe, lo que
// se mide y que la configuración de Prometheus y Grafana apunte a métricas que existen.
const raiz = path.join(__dirname, '..');
let emisor;
let server;
let base;
let lineas; // líneas de log (ya parseadas) que escribe el logger de prueba
let metricas;

before(async () => {
  emisor = await crearEmisor();
  process.env.AUTH0_ISSUER_URL = emisor.url;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  metricas = require('../src/lib/metricas');
  const { crearLogger } = require('../src/lib/logger');
  const { correlacion } = require('../src/middleware/correlacion');
  const { crearRegistroDeSolicitudes, medirSolicitudes, montar } = require('../src/middleware/observabilidad');
  const { jsonBody } = require('../src/lib/jsonBody');
  const { sendError, manejarApiError } = require('../src/lib/errors');
  const { manejarErrorAuth } = require('../src/middleware/auth0');

  lineas = [];
  const loggerDePrueba = crearLogger({ service: 'api', level: 'info', destination: { write: (linea) => lineas.push(JSON.parse(linea)) } });

  // La misma cadena de middleware que app.js, con un logger que se puede inspeccionar.
  const app = express();
  app.use(correlacion);
  app.use(crearRegistroDeSolicitudes(loggerDePrueba));
  app.use(medirSolicitudes);
  app.use(jsonBody);
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/metrics', (req, res) => res.send('metricas'));
  app.get('/explota', (req, res, next) => next(new Error('falla inesperada')));
  montar(app, '/eventos', require('../src/routes/eventos'));
  // Un router sin base de datos, para variar los ids libremente.
  const items = express.Router();
  items.get('/:id', (req, res) => res.json({ id: req.params.id }));
  montar(app, '/items', items);
  app.use((req, res) => sendError(res, 404, 'Ruta inexistente', 'ROUTE_NOT_FOUND', false, 'Consultar el contrato'));
  app.use(manejarErrorAuth);
  app.use(manejarApiError);
  app.use((err, req, res, next) => sendError(res, 500, 'Error interno', 'INTERNAL_ERROR', true, 'Reintentar')); // eslint-disable-line no-unused-vars

  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await emisor.close();
});

beforeEach(() => {
  lineas.length = 0;
  metricas.httpDuracion.reset();
});

const pedir = (ruta, { scope, sub = 'canal@clients', cabeceras = {} } = {}) => fetch(`${base}${ruta}`, {
  headers: { ...(scope !== undefined ? { Authorization: `Bearer ${emisor.token({ scope, sub })}` } : {}), ...cabeceras }
});
const ID = '66f000000000000000000001';
const solicitudes = () => lineas.filter((l) => l.route !== undefined);

async function valorDe(contador, etiquetas = {}) {
  const { values } = await contador.get();
  const fila = values.find((v) => Object.entries(etiquetas).every(([k, valor]) => v.labels[k] === valor));
  return fila?.value ?? 0;
}
// Cuánto sube un contador mientras corre `accion`.
async function delta(contador, etiquetas, accion) {
  const antes = await valorDe(contador, etiquetas);
  await accion();
  return (await valorDe(contador, etiquetas)) - antes;
}

// --- Logs ---------------------------------------------------------------------------------

test('cada línea de log es JSON con servicio, hora ISO, nivel y mensaje', () => {
  const { crearLogger } = require('../src/lib/logger');
  const salida = [];
  const logger = crearLogger({ service: 'worker', level: 'info', destination: { write: (l) => salida.push(l) } });
  logger.info({ compraId: 'abc' }, 'Pago aprobado');
  logger.debug('no se registra: el nivel es info');

  assert.equal(salida.length, 1);
  assert.ok(salida[0].endsWith('\n'), 'una línea por evento');
  const linea = JSON.parse(salida[0]);
  assert.equal(linea.service, 'worker');
  assert.equal(linea.level, 'info', 'el nivel es texto, no un número');
  assert.equal(linea.msg, 'Pago aprobado');
  assert.equal(linea.compraId, 'abc');
  assert.match(linea.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal('pid' in linea || 'hostname' in linea, false);
});

test('los logs llevan el correlation id de la operación en curso sin pasarlo por parámetro', async () => {
  const { crearLogger } = require('../src/lib/logger');
  const { correr } = require('../src/lib/contexto');
  const salida = [];
  const logger = crearLogger({ level: 'info', destination: { write: (l) => salida.push(JSON.parse(l)) } });

  logger.info('fuera de una operación');
  await correr({ correlationId: 'corr-1', eventId: 'ev-1' }, async () => {
    logger.info('dentro');
    await new Promise((r) => setTimeout(r, 5));
    logger.info('después de una espera asincrónica');
  });
  await correr({ correlationId: 'corr-2' }, async () => logger.info('otra operación'));

  assert.equal('correlationId' in salida[0], false);
  assert.deepEqual(salida.slice(1, 3).map((l) => [l.correlationId, l.eventId]), [['corr-1', 'ev-1'], ['corr-1', 'ev-1']]);
  assert.equal(salida[3].correlationId, 'corr-2');
});

test('los campos de una línea de log no se filtran a las siguientes de la misma operación', async () => {
  const { crearLogger } = require('../src/lib/logger');
  const { correr, actual } = require('../src/lib/contexto');
  const salida = [];
  const logger = crearLogger({ level: 'info', destination: { write: (l) => salida.push(JSON.parse(l)) } });
  await correr({ correlationId: 'corr-1' }, async () => {
    logger.info({ compraId: 'c1', secreto: 'no-debe-repetirse' }, 'primera');
    logger.info({ eventoId: 'e1' }, 'segunda');
    assert.deepEqual(actual(), { correlationId: 'corr-1' }, 'el contexto no se modifica');
  });
  assert.deepEqual([salida[1].eventoId, salida[1].compraId, salida[1].secreto, salida[1].correlationId], ['e1', undefined, undefined, 'corr-1']);
});

test('cada línea de log tiene claves únicas (sin campos repetidos)', async () => {
  const { crearLogger } = require('../src/lib/logger');
  const { correr } = require('../src/lib/contexto');
  const salida = [];
  const logger = crearLogger({ level: 'info', destination: { write: (l) => salida.push(l) } });
  await correr({ correlationId: 'corr-1' }, async () => logger.info({ correlationId: 'corr-1', method: 'GET' }, 'x'));
  const claves = [...salida[0].matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]);
  assert.equal(new Set(claves).size, claves.length, salida[0]);
});

test('los datos sensibles se redactan aunque alguien los agregue por error', () => {
  const { crearLogger } = require('../src/lib/logger');
  const salida = [];
  const logger = crearLogger({ level: 'info', destination: { write: (l) => salida.push(l) } });
  logger.info({ authorization: 'Bearer secreto-1', datos: { token: 'secreto-2', secret: 'secreto-3', email: 'ana@example.com', documento: '40123456' }, asistente: { nombre: 'Ana' } }, 'x');
  for (const secreto of ['secreto-1', 'secreto-2', 'secreto-3', 'ana@example.com', '40123456', 'Ana']) {
    assert.equal(salida[0].includes(secreto), false, `se filtró ${secreto}`);
  }
});

test('comoConsola adapta el logger a la interfaz log/warn/error que usan los módulos', () => {
  const { crearLogger, comoConsola } = require('../src/lib/logger');
  const salida = [];
  const log = comoConsola(crearLogger({ level: 'info', destination: { write: (l) => salida.push(JSON.parse(l)) } }));
  log.log('uno', { a: 1 });
  log.warn('dos');
  log.error('tres', { b: 2 });
  assert.deepEqual(salida.map((l) => [l.level, l.msg, l.a, l.b]), [['info', 'uno', 1, undefined], ['warn', 'dos', undefined, undefined], ['error', 'tres', undefined, 2]]);
});

test('una línea de log por solicitud con correlation id, método, ruta, estado, duración y cliente', async () => {
  const res = await pedir(`/eventos/xyz`, { scope: 'read:eventos', sub: 'canal-a@clients', cabeceras: { 'X-Correlation-Id': 'demo-corr-0001' } });
  assert.equal(res.status, 400);
  await new Promise((r) => setTimeout(r, 20));

  const [linea] = solicitudes();
  assert.equal(solicitudes().length, 1);
  assert.deepEqual(
    { level: linea.level, correlationId: linea.correlationId, method: linea.method, route: linea.route, statusCode: linea.statusCode, sub: linea.sub, code: linea.code, service: linea.service },
    { level: 'warn', correlationId: 'demo-corr-0001', method: 'GET', route: '/eventos/:id', statusCode: 400, sub: 'canal-a@clients', code: 'INVALID_ID', service: 'api' }
  );
  assert.equal(typeof linea.durationMs, 'number');
  assert.equal(res.headers.get('x-correlation-id'), 'demo-corr-0001', 'el mismo id vuelve en la respuesta');
});

test('la línea de la solicitud se escribe una sola vez y sin claves repetidas', async () => {
  const crudas = [];
  const { crearLogger } = require('../src/lib/logger');
  const { crearRegistroDeSolicitudes } = require('../src/middleware/observabilidad');
  const { correlacion } = require('../src/middleware/correlacion');
  const app = express();
  app.use(correlacion);
  app.use(crearRegistroDeSolicitudes(crearLogger({ level: 'info', destination: { write: (l) => crudas.push(l) } })));
  app.get('/ok', (req, res) => res.json({}));
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fetch(`http://127.0.0.1:${servidor.address().port}/ok`);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
  assert.equal(crudas.length, 1);
  const claves = [...crudas[0].matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]);
  assert.equal(new Set(claves).size, claves.length, crudas[0]);
});

test('el nivel depende del estado: 2xx info, 4xx warn, 5xx error; y el 401 no tiene cliente', async () => {
  await pedir('/health');
  await pedir('/eventos', { cabeceras: {} });          // 401 sin token
  await pedir('/explota');                              // 500
  await pedir('/no-existe');                            // 404
  await new Promise((r) => setTimeout(r, 20));

  const porRuta = Object.fromEntries(solicitudes().map((l) => [l.route, l]));
  assert.equal('/health' in porRuta, false, '/health no se registra');
  assert.deepEqual([porRuta['/eventos'].level, porRuta['/eventos'].statusCode, porRuta['/eventos'].code, porRuta['/eventos'].sub], ['warn', 401, 'TOKEN_INVALID', undefined]);
  assert.deepEqual([porRuta['/explota'].level, porRuta['/explota'].statusCode, porRuta['/explota'].code], ['error', 500, 'INTERNAL_ERROR'], 'el 500 se registra como error');
  assert.deepEqual([porRuta.desconocida.level, porRuta.desconocida.statusCode, porRuta.desconocida.code], ['warn', 404, 'ROUTE_NOT_FOUND'], 'una ruta inexistente queda como desconocida');
});

test('el log de la solicitud no incluye cabeceras, token, cuerpo ni la URL con su query', async () => {
  const token = emisor.token({ scope: 'read:eventos' });
  await fetch(`${base}/items/abc?estado=publicado&dato=privado`, { headers: { Authorization: `Bearer ${token}`, 'X-Api-Key': 'clave-secreta-1' } });
  await new Promise((r) => setTimeout(r, 20));
  const texto = JSON.stringify(lineas);
  for (const prohibido of [token, 'Bearer', 'clave-secreta-1', 'dato=privado', 'privado', 'headers', 'authorization']) {
    assert.equal(texto.includes(prohibido), false, `se filtró ${prohibido}`);
  }
});

// --- Métricas -------------------------------------------------------------------------------

test('el histograma etiqueta con la plantilla de la ruta: dos ids distintos son una sola serie', async () => {
  await pedir(`/items/${ID}`);
  await pedir('/items/66f000000000000000000002');
  await pedir('/items/abc');
  await pedir('/ruta-que-no-existe');
  await pedir('/eventos');
  await new Promise((r) => setTimeout(r, 20));

  const texto = await metricas.registro.metrics();
  const cuentas = texto.split('\n').filter((l) => l.startsWith('http_request_duration_seconds_count'));
  assert.ok(cuentas.some((l) => l.includes('route="/items/:id"') && l.includes('status_code="200"') && l.endsWith(' 3')), cuentas.join('\n'));
  assert.ok(cuentas.some((l) => l.includes('route="desconocida"') && l.includes('status_code="404"')), 'una ruta inexistente no crea series nuevas');
  assert.ok(cuentas.some((l) => l.includes('route="/eventos"') && l.includes('status_code="401"')));
  assert.equal(cuentas.some((l) => l.includes(ID) || l.includes('abc')), false, 'ningún id en las etiquetas');
  assert.match(texto, /http_request_duration_seconds_bucket\{le="0\.005",method=/);
  assert.match(texto, /http_request_duration_seconds_sum\{/);
});

test('/health y /metrics no cuentan para el throughput ni la latencia', async () => {
  await pedir('/health');
  await pedir('/metrics');
  const texto = await metricas.registro.metrics();
  assert.equal(texto.split('\n').some((l) => l.startsWith('http_request_duration_seconds_count')), false);
});

test('GET /metrics de la api devuelve el formato de Prometheus con las métricas de negocio en cero', async () => {
  process.env.AUTH0_DOMAIN ||= 'tenant-de-prueba.us.auth0.com';
  const app = require('../src/app');
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${servidor.address().port}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    const texto = await res.text();
    for (const nombre of ['http_request_duration_seconds', 'entradas_vendidas_total', 'entradas_emitidas_total', 'validaciones_total', 'pagos_fallidos_total', 'mensajes_procesados_total', 'mensajes_dlq_total', 'barrido_acciones_total', 'process_cpu_user_seconds_total', 'nodejs_eventloop_lag_seconds']) {
      assert.match(texto, new RegExp(`# TYPE ${nombre} `), `falta ${nombre}`);
    }
    assert.match(texto, /validaciones_total\{resultado="acceso_permitido"\} \d+/, 'publicada en cero desde el arranque');
    assert.match(texto, /pagos_fallidos_total\{motivo="pasarela_no_disponible"\} \d+/);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
});

test('el servidor de métricas del worker sirve /metrics y /health y nada más', async () => {
  const { iniciarServidorMetricas } = require('../src/lib/servidorMetricas');
  const servidor = await iniciarServidorMetricas({ port: 0 });
  try {
    const url = `http://127.0.0.1:${servidor.address().port}`;
    const metricasRes = await fetch(`${url}/metrics`);
    assert.equal(metricasRes.status, 200);
    assert.match(await metricasRes.text(), /# TYPE mensajes_procesados_total counter/);
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: 'ok' });
    const otra = await fetch(`${url}/otra`);
    assert.equal(otra.status, 404);
    assert.equal((await otra.json()).code, 'ROUTE_NOT_FOUND');
    assert.equal((await fetch(`${url}/metrics`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
});

// --- Contadores de negocio --------------------------------------------------------------------

// Una consulta de Mongoose se puede esperar directamente o encadenar `.select()` y `.lean()`.
const consulta = (valor) => ({ select: () => consulta(valor), lean: async () => valor, then: (ok, fallo) => Promise.resolve(valor).then(ok, fallo) });

test('entradas_vendidas_total suma las unidades solo cuando el pago aprobado se aplica', async () => {
  const pagos = require('../src/services/pagos');
  const enPago = { _id: 'c1', eventoId: 'e1', cantidad: 3, estado: 'pago_pendiente' };
  const dobles = (ganada, actual) => ({
    Compra: { findById: () => consulta(actual ?? enPago), findOneAndUpdate: () => consulta(ganada), updateOne: async () => {} },
    Evento: { findById: () => consulta({ estado: 'publicado' }), updateOne: async () => {} }
  });
  const datos = { referenciaExterna: 'PAY-1', correlationId: 'c' };

  assert.equal(await delta(metricas.entradasVendidas, {}, () => pagos.registrarPagoAprobado('c1', datos, dobles({ ...enPago, estado: 'pagada' }))), 3);
  assert.equal(await delta(metricas.entradasVendidas, {}, () => pagos.registrarPagoAprobado('c1', datos, dobles(null, { ...enPago, estado: 'pagada' }))), 0, 'un duplicado no suma');
});

test('pagos_fallidos_total cuenta el rechazo, la expiración y la pasarela caída', async () => {
  const pagos = require('../src/services/pagos');
  const { solicitarCobro } = require('../src/lib/pasarela');
  const compra = { _id: 'c1', eventoId: 'e1', cantidad: 2, estado: 'pago_pendiente' };
  const dobles = (devuelta) => ({
    Compra: { findById: () => consulta(compra), findOneAndUpdate: () => consulta(devuelta) },
    Evento: { updateOne: async () => {} }
  });

  assert.equal(await delta(metricas.pagosFallidos, { motivo: 'rechazado' }, () => pagos.registrarPagoRechazado('c1', { referenciaExterna: 'PAY-1' }, dobles({ ...compra, estado: 'rechazada' }))), 1);
  assert.equal(await delta(metricas.pagosFallidos, { motivo: 'rechazado' }, () => pagos.registrarPagoRechazado('c1', { referenciaExterna: 'PAY-1' }, { ...dobles(null), Compra: { ...dobles(null).Compra, findById: () => consulta({ ...compra, estado: 'rechazada' }) } })), 0, 'un duplicado no suma');
  assert.equal(await delta(metricas.pagosFallidos, { motivo: 'expirado' }, () => pagos.expirarPagoSinRegistro('c1', dobles({ ...compra, estado: 'expirada' }))), 1);
  assert.equal(await delta(metricas.pagosFallidos, { motivo: 'pasarela_no_disponible' }, () => assert.rejects(solicitarCobro({ compraId: 'c1', monto: 1, escenario: 'aprobado' }, { fetchImpl: async () => { throw new Error('caída'); } }))), 1);
});

test('validaciones_total cuenta cada resultado de la validación en la puerta', async () => {
  const entradas = require('../src/services/entradas');
  const CODIGO = 'ENT-7K2M9Q4XA1B3';
  const EVENTO = '66f000000000000000000001';
  const entrada = (extra = {}) => ({ codigo: CODIGO, eventoId: EVENTO, estado: 'emitida', ...extra });
  const dobles = ({ lecturas, evento = { estado: 'publicado' }, usada = null }) => {
    let i = 0;
    return {
      Entrada: { findOne: () => consulta(lecturas[Math.min(i++, lecturas.length - 1)]), findOneAndUpdate: () => consulta(usada) },
      Evento: { findById: () => consulta(evento) }
    };
  };
  const validar = (deps, eventoId = EVENTO) => entradas.validar(CODIGO, { eventoId }, { cliente: 'puerta@clients' }, deps).catch(() => {});

  const casos = [
    ['acceso_permitido', dobles({ lecturas: [entrada()], usada: entrada({ estado: 'usada' }) })],
    ['ya_usada', dobles({ lecturas: [entrada(), entrada({ estado: 'usada', usadaEn: new Date() })] })],
    ['anulada', dobles({ lecturas: [entrada(), entrada({ estado: 'anulada' })] })],
    ['evento_inactivo', dobles({ lecturas: [entrada()], evento: { estado: 'cancelado' } })],
    ['inexistente', dobles({ lecturas: [null] })]
  ];
  for (const [resultado, deps] of casos) assert.equal(await delta(metricas.validaciones, { resultado }, () => validar(deps)), 1, resultado);
  assert.equal(await delta(metricas.validaciones, { resultado: 'otro_evento' }, () => validar(dobles({ lecturas: [entrada({ eventoId: '66f000000000000000000002' })] }))), 1, 'otro_evento');
});

test('entradas_emitidas_total suma solo la primera vez que la compra pasa a emitida', async () => {
  const { emitirEntradasDeCompra } = require('../src/services/emision');
  const sobre = { eventId: 'ev-1', type: 'entrada.comprada', version: 1, occurredAt: 'x', correlationId: 'c', data: { compraId: 'c1' } };
  const dobles = (modifiedCount) => ({
    Compra: {
      findById: () => consulta({ _id: 'c1', eventoId: 'e1', asistenteId: 'a1', cantidad: 4, estado: 'pagada', asistente: { nombre: 'Ana', documento: '40123456' } }),
      updateOne: async () => ({ modifiedCount })
    },
    Evento: { findById: () => consulta({ estado: 'publicado' }) },
    Entrada: { updateOne: async () => {} },
    EventoProcesado: { exists: () => consulta(null), create: async () => {} }
  });
  assert.equal(await delta(metricas.entradasEmitidas, {}, () => emitirEntradasDeCompra(sobre, dobles(1))), 4);
  assert.equal(await delta(metricas.entradasEmitidas, {}, () => emitirEntradasDeCompra(sobre, dobles(0))), 0);
});

test('el consumidor cuenta los mensajes por resultado y las razones de la DLQ', async () => {
  const { crearManejador, ErrorPermanente } = require('../src/lib/consumidor');
  const EVENTO = { eventId: '3f5204d4-8952-4a3f-92ea-0a6222151299', type: 'entrada.comprada', version: 1, occurredAt: '2026-10-03T15:02:04.500Z', correlationId: 'corr-1', data: { compraId: '6702a1b2c3d4e5f601234567' } };
  const mensaje = (contenido, headers = { 'x-retry-count': 0 }) => ({ content: Buffer.from(typeof contenido === 'string' ? contenido : JSON.stringify(contenido)), properties: { messageId: 'm1', headers } });
  const canal = { ack: () => {} };
  const broker = { publicarReintento: async () => 1, publicarEnDlq: async () => {} };
  const silencioso = { log: () => {}, warn: () => {}, error: () => {} };
  const con = (procesar, maxRetries = 3) => crearManejador({ procesar, maxRetries, retryDelayMs: 1, broker, log: silencioso });

  assert.equal(await delta(metricas.mensajes, { resultado: 'ok' }, () => con(async () => ({ resultado: 'emitidas' }))(canal, mensaje(EVENTO))), 1);
  assert.equal(await delta(metricas.mensajes, { resultado: 'duplicado' }, () => con(async () => ({ resultado: 'duplicado' }))(canal, mensaje(EVENTO))), 1);
  assert.equal(await delta(metricas.mensajes, { resultado: 'reintento' }, () => con(async () => { throw new Error('mongo caído'); })(canal, mensaje(EVENTO))), 1);
  assert.equal(await delta(metricas.mensajes, { resultado: 'dlq' }, () => con(async () => { throw new Error('x'); }, 0)(canal, mensaje(EVENTO))), 1);
  assert.equal(await delta(metricas.mensajesDlq, { razon: 'max_retries_exceeded' }, () => con(async () => { throw new Error('x'); }, 0)(canal, mensaje(EVENTO))), 1);
  assert.equal(await delta(metricas.mensajesDlq, { razon: 'invalid_json' }, () => con(async () => {})(canal, mensaje('{roto'))), 1);
  assert.equal(await delta(metricas.mensajesDlq, { razon: 'compra_not_found' }, () => con(async () => { throw new ErrorPermanente('no existe', 'compra_not_found'); })(canal, mensaje(EVENTO))), 1);
});

test('el barrido cuenta sus correcciones por acción y sus pasos fallidos', async () => {
  const barrido = require('../src/lib/barrido');
  const consultaLista = (valor) => ({ sort: () => consultaLista(valor), limit: () => consultaLista(valor), select: () => consultaLista(valor), lean: async () => valor });
  const silencioso = { log: () => {}, warn: () => {}, error: () => {} };
  const modelos = {
    Compra: { find: () => consultaLista([]), aggregate: async () => [] },
    Evento: { find: () => consultaLista([]), updateMany: async () => ({ modifiedCount: 2 }) },
    log: silencioso
  };
  assert.equal(await delta(metricas.barrido, { accion: 'eventos_finalizados' }, () => barrido.crearBarrido(modelos).pasada()), 2);

  const rotos = { ...modelos, Compra: { find: () => { throw new Error('mongo caído'); }, aggregate: async () => [] } };
  assert.equal(await delta(metricas.barridoErrores, { paso: 'reservasExpiradas' }, () => barrido.crearBarrido(rotos).pasada()), 1);
});

// --- pagos-mock ---------------------------------------------------------------------------------

test('pagos-mock escribe sus logs como JSON con el correlation id', () => {
  const { registrar } = require('../services/pagos-mock/server');
  const original = console.log;
  const salida = [];
  console.log = (l) => salida.push(l);
  try {
    registrar('Pago solicitado', { compraId: 'c1', correlationId: 'corr-9' });
    registrar('Webhook: se agotaron los reintentos', { level: 'error', compraId: 'c1' });
  } finally {
    console.log = original;
  }
  const [a, b] = salida.map((l) => JSON.parse(l));
  assert.deepEqual([a.service, a.level, a.msg, a.correlationId], ['pagos-mock', 'info', 'Pago solicitado', 'corr-9']);
  assert.match(a.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual([b.level, b.compraId], ['error', 'c1']);
});

// --- Configuración de Prometheus y Grafana -------------------------------------------------------

const leer = (archivo) => fs.readFileSync(path.join(raiz, archivo), 'utf8');

test('Prometheus recolecta /metrics de la api y del worker en los puertos que exponen', () => {
  const config = leer('observabilidad/prometheus.yml');
  assert.match(config, /job_name: api[\s\S]*?targets: \["api:3000"\]/);
  assert.match(config, /job_name: worker[\s\S]*?targets: \["worker:9464"\]/);
  assert.match(config, /metrics_path: \/metrics/);
  const compose = leer('docker-compose.yml');
  assert.match(compose, /METRICS_PORT: 9464/, 'el worker expone el puerto que Prometheus consulta');
});

test('docker-compose.yml define prometheus y grafana con la configuración montada desde el repo', () => {
  const compose = leer('docker-compose.yml');
  for (const servicio of ['prometheus', 'grafana']) assert.match(compose, new RegExp(`^  ${servicio}:\\s*$`, 'm'), servicio);
  assert.match(compose, /\.\/observabilidad\/prometheus\.yml:\/etc\/prometheus\/prometheus\.yml/);
  assert.match(compose, /\.\/observabilidad\/grafana\/provisioning:\/etc\/grafana\/provisioning/);
  assert.match(compose, /\.\/observabilidad\/grafana\/dashboards:\/var\/lib\/grafana\/dashboards/);
  for (const archivo of ['observabilidad/prometheus.yml', 'observabilidad/grafana/provisioning/datasources/prometheus.yml', 'observabilidad/grafana/provisioning/dashboards/dashboards.yml', 'observabilidad/grafana/dashboards/eventos-entradas.json']) {
    assert.ok(fs.existsSync(path.join(raiz, archivo)), `falta ${archivo}`);
  }
  assert.match(leer('observabilidad/grafana/provisioning/datasources/prometheus.yml'), /uid: prometheus[\s\S]*url: http:\/\/prometheus:9090/);
});

test('el dashboard tiene p95, throughput y error rate, y cada consulta usa métricas que existen', () => {
  const dashboard = JSON.parse(leer('observabilidad/grafana/dashboards/eventos-entradas.json'));
  const paneles = dashboard.panels.filter((p) => p.type !== 'row');
  const expresiones = paneles.flatMap((p) => p.targets.map((t) => t.expr));
  assert.ok(paneles.length >= 8);
  assert.ok(paneles.every((p) => p.datasource.uid === 'prometheus'), 'todos usan el datasource provisionado');

  assert.ok(expresiones.some((e) => e.includes('histogram_quantile(0.95') && e.includes('http_request_duration_seconds_bucket')), 'p95');
  assert.ok(expresiones.some((e) => /^sum\(rate\(http_request_duration_seconds_count\[1m\]\)\)$/.test(e)), 'throughput');
  assert.ok(expresiones.some((e) => e.includes('status_code=~"5.."')), 'error rate 5xx');
  assert.ok(expresiones.some((e) => e.includes('status_code=~"4.."')), 'error rate 4xx');

  // Las consultas solo mencionan métricas del registro (con sus sufijos de histograma) y la sintaxis de PromQL.
  const metricas = require('../src/lib/metricas');
  const validas = new Set();
  for (const m of metricas.registro.getMetricsAsArray()) {
    for (const sufijo of ['', '_bucket', '_count', '_sum']) validas.add(`${m.name}${sufijo}`);
  }
  const PROMQL = new Set(['histogram_quantile', 'status_code', 'by', 'sum', 'rate', 'increase', 'vector', 'or', 'le', 'route', 'resultado', 'motivo', 'razon', 'accion']);
  for (const expr of expresiones) {
    const sinEtiquetas = expr.replace(/"[^"]*"/g, '""');
    for (const token of sinEtiquetas.match(/[a-z_][a-z0-9_]*/g)) {
      if (!token.includes('_') || PROMQL.has(token)) continue;
      assert.ok(validas.has(token), `la consulta "${expr}" usa ${token}, que no es una métrica del registro`);
    }
  }
});

test('el dashboard es JSON válido, con uid fijo y sin edición desde la interfaz', () => {
  const dashboard = JSON.parse(leer('observabilidad/grafana/dashboards/eventos-entradas.json'));
  assert.equal(dashboard.uid, 'eventos-entradas');
  assert.equal(dashboard.editable, false);
  const ids = dashboard.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'ids de panel únicos');
  assert.match(leer('docker-compose.yml'), /GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: \/var\/lib\/grafana\/dashboards\/eventos-entradas\.json/);
});
