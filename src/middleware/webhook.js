const { ApiError } = require('../lib/errors');
const { webhookConfig } = require('../lib/config');
const { verificarFirma } = require('../lib/firma');

// Autentica al llamador del webhook por la firma HMAC en lugar de OAuth: quien llama es la
// pasarela, que no obtiene tokens de nuestro Auth0 (ADR 0006). Usa `req.rawBody`, que conserva
// el parser JSON (src/lib/jsonBody.js); sin cuerpo JSON no hay nada que firmar y se rechaza.
function verificarWebhook(req, res, next) {
  try {
    const { secreto, toleranciaSegundos } = webhookConfig();
    if (!secreto) {
      throw new ApiError({
        status: 500, error: 'Secreto del webhook no configurado', code: 'WEBHOOK_SECRET_NOT_CONFIGURED',
        action: 'Configurar WEBHOOK_SECRET en el servidor'
      });
    }
    verificarFirma({
      secreto, toleranciaSegundos, cuerpo: req.rawBody,
      timestamp: req.header('X-Pago-Timestamp'), firma: req.header('X-Pago-Firma')
    });
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { verificarWebhook };
