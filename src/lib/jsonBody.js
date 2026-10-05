const express = require('express');

// Parser JSON que además conserva el cuerpo crudo en `req.rawBody`. La firma HMAC del webhook
// se calcula sobre los bytes originales, no sobre el JSON vuelto a serializar (ADR 0006).
const jsonBody = express.json({
  verify: (req, res, buffer) => { req.rawBody = buffer; }
});

module.exports = { jsonBody };
