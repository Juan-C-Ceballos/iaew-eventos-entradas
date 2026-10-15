const express = require('express');
const { requireScope } = require('../middleware/auth0');
const { validarCuerpo } = require('../lib/validar');
const { asyncHandler } = require('../lib/http');
const entradas = require('../services/entradas');

const router = express.Router();
const validate = requireScope('validate:entradas');

router.get('/:codigo', ...validate,
  asyncHandler(async (req, res) => res.json(await entradas.obtener(req.params.codigo))));

// El control de acceso informa el evento de su puerta (`eventoId`): una entrada del evento A
// no entra por la puerta del evento B (ADR 0012). El `sub` del token queda en `validadaPor`.
router.post('/:codigo/validar', ...validate, validarCuerpo('ValidacionSolicitud', { mensaje: 'Datos de validación inválidos' }),
  asyncHandler(async (req, res) => {
    res.json(await entradas.validar(req.params.codigo, req.body, { cliente: req.auth.payload.sub }));
  }));

module.exports = router;
