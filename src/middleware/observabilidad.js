const { logger } = require('../lib/logger');
const metricas = require('../lib/metricas');

// Ni /metrics (lo consulta Prometheus cada pocos segundos) ni /health (el healthcheck de Docker)
// son tráfico de negocio: contarlos distorsionaría el throughput y llenaría los logs.
const IGNORADAS = new Set(['/metrics', '/health']);
const ignorada = (req) => IGNORADAS.has(req.path ?? req.url.split('?')[0]);

// La plantilla de la ruta (`/compras/:id/pagar`) y no la URL real: con la URL, cada id sería una
// serie distinta y la cardinalidad de las métricas crecería sin límite. `req.baseMontada` la deja
// `montar` en app.js, porque `req.baseUrl` ya no vale cuando la respuesta sale de un manejador de errores.
function rutaDe(req) {
  if (!req.route) return req.baseMontada ?? 'desconocida';
  const sufijo = req.route.path === '/' && req.baseMontada ? '' : req.route.path;
  return `${req.baseMontada ?? ''}${sufijo}`;
}

// Histograma de duración: de acá salen la latencia p95, el throughput y el error rate.
function medirSolicitudes(req, res, next) {
  if (ignorada(req)) return next();
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
    metricas.httpDuracion.observe({ method: req.method, route: rutaDe(req), status_code: String(res.statusCode) }, segundos);
  });
  return next();
}

// Una línea de log por solicitud con el correlation id, el método, la ruta, el estado, la duración,
// el cliente OAuth (`sub`) y el código de error de la API. No se registran cabeceras (llevan el
// token), cuerpos ni la URL con su query: solo lo necesario para seguir la operación. Se escribe
// al terminar la respuesta, cuando ya se conocen la ruta que atendió, el cliente y el código de error.
function crearRegistroDeSolicitudes(destino = logger) {
  return function registrarSolicitudes(req, res, next) {
    if (ignorada(req)) return next();
    const inicio = process.hrtime.bigint();
    res.on('finish', () => {
      const ruta = rutaDe(req);
      const nivel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      destino[nivel]({
        correlationId: req.correlationId,
        method: req.method,
        route: ruta,
        statusCode: res.statusCode,
        durationMs: Math.round((Number(process.hrtime.bigint() - inicio) / 1e6) * 100) / 100,
        sub: req.auth?.payload?.sub,
        code: res.locals?.errorCode
      }, `${req.method} ${ruta} ${res.statusCode}`);
    });
    return next();
  };
}

const registrarSolicitudes = crearRegistroDeSolicitudes();

// Monta un router recordando su prefijo (`req.baseMontada`) para etiquetar con la plantilla de la ruta.
const montar = (app, base, router) => app.use(base, (req, res, next) => { req.baseMontada = base; next(); }, router);

module.exports = { medirSolicitudes, registrarSolicitudes, crearRegistroDeSolicitudes, montar, rutaDe };
