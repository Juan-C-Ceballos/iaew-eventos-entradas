const express = require('express');
const { requireScope } = require('../middleware/auth0');
const { validarCuerpo } = require('../lib/validar');
const { asyncHandler, validarId } = require('../lib/http');
const eventos = require('../services/eventos');

const router = express.Router();
const MENSAJE = 'Datos de evento inválidos';

// Primero se autentica (401/403) y después se valida (400): un cliente sin permisos no
// aprende nada sobre la forma de los datos.
router.get('/', ...requireScope('read:eventos'),
  asyncHandler(async (req, res) => res.json(await eventos.listar({ estado: req.query.estado }))));

router.post('/', ...requireScope('write:eventos'), validarCuerpo('EventoCrear', { mensaje: MENSAJE }),
  asyncHandler(async (req, res) => {
    const evento = await eventos.crear(req.body);
    res.status(201).location(`/eventos/${evento._id}`).json(evento);
  }));

router.get('/:id', ...requireScope('read:eventos'), validarId(),
  asyncHandler(async (req, res) => res.json(await eventos.obtener(req.params.id))));

router.patch('/:id', ...requireScope('write:eventos'), validarId(), validarCuerpo('EventoActualizar', { mensaje: MENSAJE }),
  asyncHandler(async (req, res) => res.json(await eventos.actualizar(req.params.id, req.body))));

router.delete('/:id', ...requireScope('admin:eventos'), validarId(),
  asyncHandler(async (req, res) => { await eventos.eliminar(req.params.id); res.status(204).end(); }));

router.post('/:id/cancelar', ...requireScope('write:eventos'), validarId(),
  asyncHandler(async (req, res) => res.json(await eventos.cancelar(req.params.id))));

module.exports = router;
