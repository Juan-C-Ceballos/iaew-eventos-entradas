const express = require('express');
const { verificarWebhook } = require('../middleware/webhook');
const { validarCuerpo } = require('../lib/validar');
const { asyncHandler } = require('../lib/http');
const pagos = require('../services/pagos');

const router = express.Router();

// Primero se autentica por firma (401) y recién después se mira el contenido (400): a quien no
// firmó bien no se le dice nada sobre el formato esperado.
router.post('/pagos', verificarWebhook, validarCuerpo('NotificacionPago', { mensaje: 'Notificación de pago inválida' }),
  asyncHandler(async (req, res) => {
    res.json(await pagos.procesarNotificacionPago(req.body, { correlationId: req.correlationId }));
  }));

module.exports = router;
