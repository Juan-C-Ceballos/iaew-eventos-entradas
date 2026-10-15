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
const { openapi } = require('./lib/contrato');
const { integerFromEnv, plazosConfig } = require('./lib/config');
const { iniciarRelay } = require('./lib/outbox');
const { describirToken } = require('./lib/token');
const { jsonBody } = require('./lib/jsonBody');
const { closeRabbit } = require('./lib/rabbit');

const app = express();
const port = process.env.PORT || 3000;

app.use(correlacion);
app.use(jsonBody);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api-docs/openapi.json', (req, res) => res.json(openapi));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/token-info', validateAccessToken, (req, res) => res.json(describirToken(req.auth.payload)));

// Cada operación de docs/openapi.json tiene su ruta; test/contrato-rutas.test.js lo verifica.
app.use('/eventos', eventosRouter);
app.use('/compras', comprasRouter);
app.use('/entradas', entradasRouter);
app.use('/webhooks', webhooksRouter);
app.use('/internal', internalRouter);

app.use((req, res) => sendError(res, 404, 'Ruta inexistente', 'ROUTE_NOT_FOUND', false, 'Consultar el contrato en /api-docs'));

app.use(manejarErrorAuth);
app.use(manejarApiError);
app.use(manejarErrorDeBase);
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'JSON inválido', 'INVALID_JSON', false, 'Corregir el cuerpo JSON');
  return next(err);
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Error no controlado:', err.message || err.name || err);
  return sendError(res, 500, 'Error interno', 'INTERNAL_ERROR', true, 'Reintentar más tarde');
});

if (require.main === module) {
  plazosConfig(); // falla al arrancar si PAGO_TIMEOUT_MINUTOS u otro plazo es inválido
  let detenerRelay = () => {};
  connectDb()
    .then(() => {
      detenerRelay = iniciarRelay({ intervaloMs: integerFromEnv('OUTBOX_INTERVALO_MS', 1000, { min: 100, max: 60000 }) });
      app.listen(port, () => console.log(`API escuchando en http://localhost:${port}`));
    })
    .catch((error) => { console.error('No se pudo conectar a MongoDB:', error.message); process.exit(1); });
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
