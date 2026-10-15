const express = require('express');
const { requireScope } = require('../middleware/auth0');
const { validarCuerpo } = require('../lib/validar');
const { asyncHandler, validarId } = require('../lib/http');
const { requerirIdempotencyKey } = require('../lib/idempotencia');
const compras = require('../services/compras');

const router = express.Router();
const buy = requireScope('buy:entradas');
// Con client_credentials el `sub` identifica a la aplicación cliente: es el titular de la compra (ADR 0012).
const clienteDe = (req) => req.auth.payload.sub;

router.post('/', ...buy, requerirIdempotencyKey, validarCuerpo('CompraCrear', { mensaje: 'Datos de compra inválidos' }),
  asyncHandler(async (req, res) => {
    const { compra, replayed } = await compras.reservar(req.body, { clave: req.idempotencyKey, cliente: clienteDe(req) });
    res.status(201)
      .set('Idempotency-Replayed', String(replayed))
      .json({ compra: compras.presentarCompra(compra), idempotencia: { key: req.idempotencyKey, replayed } });
  }));

router.get('/', ...buy,
  asyncHandler(async (req, res) => res.json(await compras.listar({ cliente: clienteDe(req), eventoId: req.query.eventoId, estado: req.query.estado }))));

router.get('/:id', ...buy, validarId(),
  asyncHandler(async (req, res) => res.json(await compras.obtener(req.params.id, clienteDe(req)))));

router.post('/:id/cancelar', ...buy, validarId(),
  asyncHandler(async (req, res) => res.json(await compras.cancelar(req.params.id, clienteDe(req)))));

router.get('/:id/entradas', ...buy, validarId(),
  asyncHandler(async (req, res) => res.json(await compras.entradasDe(req.params.id, clienteDe(req)))));

module.exports = router;
