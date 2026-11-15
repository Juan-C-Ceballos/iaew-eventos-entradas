const express = require('express');
const { requireApiKey } = require('../middleware/apiKey');
const { asyncHandler } = require('../lib/http');
const reporte = require('../services/reporte');

const router = express.Router();

// Endpoint de comparación protegido con `x-api-key` en lugar de OAuth 2.0 (ADR 0004): una vista
// interna sin identidad ni scopes, que ve todos los eventos.
router.get('/reportes/ventas', requireApiKey,
  asyncHandler(async (req, res) => res.json(await reporte.ventasPorEvento())));

module.exports = router;
