require('dotenv').config();
const { auth, requiredScopes, UnauthorizedError } = require('express-oauth2-jwt-bearer');
const { sendError } = require('../lib/errors');

const validateAccessToken = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  audience: process.env.AUTH0_AUDIENCE,
  tokenSigningAlg: 'RS256'
});

function requireScope(scope) {
  return [validateAccessToken, requiredScopes(scope)];
}

// Traduce los errores de express-oauth2-jwt-bearer al formato de error de la API (ADR 0001).
// Todo error de autenticación es 401, incluida una cabecera Authorization mal formada (por
// ejemplo un esquema Basic o dos credenciales): la librería la reporta como 400
// `invalid_request`, pero para el cliente la acción es la misma, enviar un Bearer válido.
// Solo la falta de scope es 403.
function manejarErrorAuth(err, req, res, next) {
  if (!(err instanceof UnauthorizedError)) return next(err);
  if (err.status === 403) return sendError(res, 403, 'Permisos insuficientes', 'SCOPE_REQUIRED', false, 'Solicitar el scope requerido');
  res.set('WWW-Authenticate', 'Bearer realm="api"');
  return sendError(res, 401, 'Token ausente, inválido o expirado', 'TOKEN_INVALID', false, 'Obtener y enviar un access token válido');
}

module.exports = { validateAccessToken, requireScope, manejarErrorAuth };
