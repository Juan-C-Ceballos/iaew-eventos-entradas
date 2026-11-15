require('dotenv').config();
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { connectDb, closeDb } = require('./db');
const { validateAccessToken, manejarErrorAuth } = require('./middleware/auth0');
const { sendError, manejarApiError, manejarErrorDeBase } = require('./lib/errors');
const eventosRouter = require('./routes/eventos');
const comprasRouter = require('./routes/compras');
const entradasRouter = require('./routes/entradas');
const webhooksRouter = require('./routes/webhooks');
const internalRouter = require('./routes/internal');
const { correlacion } = require('./middleware/correlacion');
const { medirSolicitudes, registrarSolicitudes, montar: montarRouter } = require('./middleware/observabilidad');
const { logger } = require('./lib/logger');
const metricas = require('./lib/metricas');
const { openapi } = require('./lib/contrato');
const { integerFromEnv, plazosConfig } = require('./lib/config');
const { iniciarRelay } = require('./lib/outbox');
const { describirToken } = require('./lib/token');
const { jsonBody } = require('./lib/jsonBody');
const { closeRabbit } = require('./lib/rabbit');

const app = express();
const port = process.env.PORT || 3000;

app.use(correlacion);
app.use(registrarSolicitudes);
app.use(medirSolicitudes);
app.use(jsonBody);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
// Métricas para Prometheus (ADR 0008). No está en el contrato OpenAPI: es una vista operativa que no se
// autentica porque la consulta Prometheus dentro de la red de Compose; hay que restringirla fuera del uso local.
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricas.registro.contentType);
  res.end(await metricas.registro.metrics());
});
app.get('/api-docs/openapi.json', (req, res) => res.json(openapi));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/token-info', validateAccessToken, (req, res) => res.json(describirToken(req.auth.payload)));

// Cada operación de docs/openapi.json tiene su ruta; test/contrato-rutas.test.js lo verifica.
// `montarRouter` recuerda el prefijo para etiquetar las métricas con la plantilla de la ruta (observabilidad.js).
montarRouter(app, '/eventos', eventosRouter);
montarRouter(app, '/compras', comprasRouter);
montarRouter(app, '/entradas', entradasRouter);
montarRouter(app, '/webhooks', webhooksRouter);
montarRouter(app, '/internal', internalRouter);

app.use((req, res) => sendError(res, 404, 'Ruta inexistente', 'ROUTE_NOT_FOUND', false, 'Consultar el contrato en /api-docs'));

app.use(manejarErrorAuth);
app.use(manejarApiError);
app.use(manejarErrorDeBase);
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'JSON inválido', 'INVALID_JSON', false, 'Corregir el cuerpo JSON');
  return next(err);
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ err }, 'Error no controlado');
  return sendError(res, 500, 'Error interno', 'INTERNAL_ERROR', true, 'Reintentar más tarde');
});

if (require.main === module) {
  plazosConfig(); // falla al arrancar si PAGO_TIMEOUT_MINUTOS u otro plazo es inválido
  let detenerRelay = () => {};
  connectDb()
    .then(() => {
      detenerRelay = iniciarRelay({ intervaloMs: integerFromEnv('OUTBOX_INTERVALO_MS', 1000, { min: 100, max: 60000 }) });
      app.listen(port, () => logger.info({ port }, 'API escuchando'));
    })
    .catch((error) => { logger.error({ err: error }, 'No se pudo conectar a MongoDB'); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      detenerRelay();
      await closeRabbit();
      await closeDb();
      process.exit(0);
    });
  }
}

module.exports = app;
