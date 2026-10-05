require('dotenv').config();
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { connectDb, closeDb } = require('./db');
const { validateAccessToken } = require('./middleware/auth0');
const { sendError } = require('./lib/errors');
const { openapi, pendingRoutes } = require('./lib/contrato');
const { integerFromEnv, plazosConfig } = require('./lib/config');
const { iniciarRelay } = require('./lib/outbox');
const { closeRabbit } = require('./lib/rabbit');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api-docs/openapi.json', (req, res) => res.json(openapi));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/token-info', validateAccessToken, (req, res) => res.json({
  issuer: req.auth.payload.iss,
  audience: req.auth.payload.aud,
  subject: req.auth.payload.sub,
  scopes: req.auth.payload.scope
}));

// Operaciones del contrato aún no implementadas: responden 501 en vez de 404 para que
// el esqueleto refleje el contrato completo. Cada router real se monta antes que esto.
for (const { method, expressPath } of pendingRoutes(['/health', '/token-info'])) {
  app[method](expressPath, (req, res) => sendError(res, 501, 'Operación documentada en el contrato y pendiente de implementación', 'NOT_IMPLEMENTED', false, 'Disponible en la Entrega 2; ver /api-docs'));
}

app.use((req, res) => sendError(res, 404, 'Ruta inexistente', 'ROUTE_NOT_FOUND', false, 'Consultar el contrato en /api-docs'));

app.use((err, req, res, next) => {
  if (err.status === 401) return sendError(res, 401, 'Token ausente, inválido o expirado', 'TOKEN_INVALID', false, 'Obtener y enviar un access token válido');
  if (err.status === 403) return sendError(res, 403, 'Permisos insuficientes', 'SCOPE_REQUIRED', false, 'Solicitar el scope requerido');
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'JSON inválido', 'INVALID_JSON', false, 'Corregir el cuerpo JSON');
  return next(err);
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Error no controlado:', err.message);
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
