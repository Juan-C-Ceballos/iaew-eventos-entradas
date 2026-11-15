// Corre la prueba de carga: prepara el escenario (un token y un evento con capacidad de sobra), ejecuta el
// plan de JMeter (carga/plan-carga.jmx) y deja el reporte HTML y los resultados en carga/reporte/.
//
//   node carga/ejecutar.js                      # 20 hilos, 10 s de rampa, 60 s de duración
//   HILOS=50 DURACION=120 node carga/ejecutar.js
//
// Requisitos: la API arriba (docker compose up -d), un access token del canal de venta y uno del organizador
// (con el emisor local de docker-compose.pruebas.yml los pide solo; con Auth0, pasar TOKEN_CANAL y TOKEN_ORGANIZADOR)
// y Docker (corre JMeter en el contenedor justb4/jmeter) o un `jmeter` instalado con SIN_DOCKER=1.
//
// Variables (todas opcionales): BASE_URL, AUTH0_BASE_URL, AUDIENCE, TOKEN_CANAL, TOKEN_ORGANIZADOR, HILOS, RAMPA, DURACION,
// PROMETHEUS_URL, JMETER_IMAGE, SIN_DOCKER y CONSERVAR_EVENTO=1 (por defecto el evento de la prueba se cancela al terminar).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const env = process.env;
const BASE_URL = new URL(env.BASE_URL || 'http://localhost:3000');
const AUTH0_BASE_URL = env.AUTH0_BASE_URL || 'http://localhost:4010';
const AUDIENCE = env.AUDIENCE || 'https://iaew-eventos-api';
const HILOS = Number(env.HILOS || 20);
const RAMPA = Number(env.RAMPA || 10);
const DURACION = Number(env.DURACION || 60);
const PROMETHEUS_URL = env.PROMETHEUS_URL || 'http://localhost:9090';
const IMAGEN = env.JMETER_IMAGE || 'justb4/jmeter:5.5';
const raiz = __dirname;
const reporte = path.join(raiz, 'reporte');

async function tokenDe(cliente, secreto) {
  const res = await fetch(`${AUTH0_BASE_URL}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cliente, client_secret: secreto, audience: AUDIENCE, grant_type: 'client_credentials' })
  });
  if (!res.ok) throw new Error(`No se pudo obtener el token de ${cliente}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(metodo, ruta, token, cuerpo) {
  const res = await fetch(`${BASE_URL.origin}${ruta}`, {
    method: metodo, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: res.status, cuerpo: await res.json().catch(() => null) };
}

// Consulta a Prometheus cómo se comportó el sistema durante la prueba, para adjuntarlo al reporte de JMeter:
// el p95, el throughput y el error rate de la api, y cuánto crecieron los contadores de negocio y del worker
// en la ventana de la prueba (la diferencia entre el final y el comienzo, no el acumulado desde el arranque).
async function metricasDuranteLaPrueba(desde, hasta) {
  const ventana = Math.max(1, hasta - desde);
  const consulta = async (url) => {
    try {
      return await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
    } catch (error) {
      return { error: `Prometheus no respondió (${error.message})` };
    }
  };
  const series = {
    p95_segundos: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[30s])))',
    throughput_req_por_segundo: 'sum(rate(http_request_duration_seconds_count[30s]))',
    error_rate_5xx: '(sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[30s])) or vector(0)) / sum(rate(http_request_duration_seconds_count[30s]))'
  };
  // Los contadores se comparan al empezar y al terminar: `increase()` extrapola en los bordes de la ventana y
  // da un valor aproximado (unos puntos porcentuales de más o de menos), y acá se quiere el número exacto.
  const contadores = {
    entradas_vendidas: 'sum(entradas_vendidas_total)',
    entradas_emitidas: 'sum(entradas_emitidas_total)',
    mensajes_ok: 'sum(mensajes_procesados_total{resultado="ok"})',
    mensajes_reintentados: 'sum(mensajes_procesados_total{resultado="reintento"})',
    mensajes_en_dlq: 'sum(mensajes_procesados_total{resultado="dlq"})',
    pagos_fallidos: 'sum(pagos_fallidos_total)'
  };
  const resultado = {};
  for (const [nombre, expr] of Object.entries(series)) {
    const cuerpo = await consulta(`${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${desde}&end=${hasta}&step=5`);
    if (cuerpo.error) { resultado[nombre] = cuerpo; continue; }
    const valores = (cuerpo.data?.result?.[0]?.values ?? []).map(([, v]) => Number(v)).filter(Number.isFinite);
    resultado[nombre] = { maximo: valores.length ? Number(Math.max(...valores).toFixed(4)) : null, muestras: valores.length };
  }
  const valorEn = async (expr, instante) => {
    const cuerpo = await consulta(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}&time=${instante}`);
    const valor = Number(cuerpo.data?.result?.[0]?.value?.[1]);
    return cuerpo.error ? cuerpo : (Number.isFinite(valor) ? valor : 0);
  };
  for (const [nombre, expr] of Object.entries(contadores)) {
    const [antes, despues] = [await valorEn(expr, desde), await valorEn(expr, hasta)];
    resultado[nombre] = antes.error || despues.error ? (antes.error ?? despues.error) : Math.round(despues - antes);
  }
  return resultado;
}

(async () => {
  console.log(`Escenario: ${HILOS} hilos, ${RAMPA} s de rampa, ${DURACION} s de duración contra ${BASE_URL.origin}`);
  const tokenCanal = env.TOKEN_CANAL || await tokenDe('canal-venta-local', 'secreto-canal-venta-local');
  const tokenOrganizador = env.TOKEN_ORGANIZADOR || await tokenDe('organizador-local', 'secreto-organizador-local');

  // Un evento con capacidad de sobra: la prueba mide la API, no el agotamiento del cupo.
  const creado = await api('POST', '/eventos', tokenOrganizador, {
    nombre: 'Evento de la prueba de carga', fecha: new Date(Date.now() + 30 * 86400000).toISOString(), lugar: 'Carga',
    capacidad: 1000000, precio: 100, estado: 'publicado'
  });
  if (creado.status !== 201) throw new Error(`No se pudo crear el evento de la prueba: ${creado.status} ${JSON.stringify(creado.cuerpo)}`);
  const eventoId = creado.cuerpo._id;
  console.log(`Evento de la prueba: ${eventoId}`);

  fs.rmSync(reporte, { recursive: true, force: true });
  fs.mkdirSync(reporte, { recursive: true });
  // El token no se pasa con -J: la imagen de JMeter imprime sus argumentos y quedaría en los logs. Va en un archivo
  // de propiedades temporal, fuera de carga/reporte, que se borra al terminar.
  const secretos = fs.mkdtempSync(path.join(os.tmpdir(), 'iaew-carga-'));
  fs.writeFileSync(path.join(secretos, 'token.properties'), `token=${tokenCanal}\n`);
  const parametros = [
    `-Jhost=${env.SIN_DOCKER ? BASE_URL.hostname : (BASE_URL.hostname === 'localhost' ? 'host.docker.internal' : BASE_URL.hostname)}`,
    `-Jport=${BASE_URL.port || (BASE_URL.protocol === 'https:' ? 443 : 80)}`, `-Jprotocolo=${BASE_URL.protocol.replace(':', '')}`,
    `-JeventoId=${eventoId}`, `-Jhilos=${HILOS}`, `-Jrampa=${RAMPA}`, `-Jduracion=${DURACION}`
  ];

  const desde = Math.floor(Date.now() / 1000);
  let ejecucion;
  if (env.SIN_DOCKER) {
    ejecucion = spawnSync('jmeter', ['-n', '-t', path.join(raiz, 'plan-carga.jmx'), '-q', path.join(secretos, 'token.properties'), '-l', path.join(reporte, 'resultados.jtl'), '-e', '-o', path.join(reporte, 'html'), ...parametros], { stdio: 'inherit' });
  } else {
    ejecucion = spawnSync('docker', [
      'run', '--rm', '--add-host=host.docker.internal:host-gateway', '-v', `${raiz}:/carga`, '-v', `${secretos}:/secretos:ro`,
      IMAGEN, '-n', '-t', '/carga/plan-carga.jmx', '-q', '/secretos/token.properties', '-l', '/carga/reporte/resultados.jtl', '-e', '-o', '/carga/reporte/html', ...parametros
    ], { stdio: 'inherit' });
  }
  fs.rmSync(secretos, { recursive: true, force: true });
  if (ejecucion.status !== 0) throw new Error(`JMeter terminó con código ${ejecucion.status}`);
  // Unos segundos para que el worker termine de emitir lo último y Prometheus lo recolecte (scrape cada 5 s).
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const hasta = Math.floor(Date.now() / 1000);

  // Resumen: lo que calcula JMeter y lo que midió Prometheus durante la misma ventana.
  const estadisticas = JSON.parse(fs.readFileSync(path.join(reporte, 'html', 'statistics.json'), 'utf8'));
  const resumen = {
    escenario: { hilos: HILOS, rampaSegundos: RAMPA, duracionSegundos: DURACION, baseUrl: BASE_URL.origin, eventoId },
    jmeter: Object.fromEntries(Object.entries(estadisticas).map(([nombre, e]) => [nombre, {
      muestras: e.sampleCount, errores: e.errorCount, errorPct: Number(e.errorPct.toFixed(2)), throughput: Number(e.throughput.toFixed(2)),
      promedioMs: Number(e.meanResTime.toFixed(1)), p90Ms: Number(e.pct1ResTime.toFixed(1)), p95Ms: Number(e.pct2ResTime.toFixed(1)), p99Ms: Number(e.pct3ResTime.toFixed(1)), maxMs: e.maxResTime
    }])),
    prometheus: await metricasDuranteLaPrueba(desde, hasta)
  };
  // Objetivos del TPI (no los impone la consigna): sin errores y p95 total por debajo de 500 ms.
  const total = resumen.jmeter.Total;
  resumen.objetivos = { errorPctMenorA1: total.errorPct < 1, p95TotalMenorA500ms: total.p95Ms < 500 };
  resumen.objetivos.cumple = Object.values(resumen.objetivos).every(Boolean);
  fs.writeFileSync(path.join(reporte, 'resumen.json'), JSON.stringify(resumen, null, 2) + '\n');
  console.log('\nResumen (carga/reporte/resumen.json):');
  console.table(Object.fromEntries(Object.entries(resumen.jmeter).map(([n, e]) => [n, { muestras: e.muestras, 'error %': e.errorPct, 'req/s': e.throughput, 'p95 ms': e.p95Ms, 'p99 ms': e.p99Ms }])));
  console.log('Prometheus durante la prueba:', JSON.stringify(resumen.prometheus));
  console.log(`Objetivos (errores < 1% y p95 < 500 ms): ${resumen.objetivos.cumple ? 'CUMPLE' : 'NO CUMPLE'}`);
  console.log('Reporte HTML: carga/reporte/html/index.html');

  // El evento de un millón de lugares no se deja abierto a la venta en la base de demostración.
  if (!env.CONSERVAR_EVENTO) {
    const cancelado = await api('POST', `/eventos/${eventoId}/cancelar`, tokenOrganizador);
    console.log(`Evento de la prueba cancelado: ${cancelado.status}`);
  }
})().catch((error) => { console.error('La prueba de carga falló:', error.message); process.exit(1); });
