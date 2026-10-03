const http = require('node:http');

// Pasarela de pago simulada. En la Entrega 1 solo expone /health; en la Entrega 2
// recibe POST /pagos, decide el resultado y notifica a WEBHOOK_URL firmando con
// HMAC-SHA256(WEBHOOK_SECRET, `${timestamp}.${body}`) (ver ADR 0006).
const port = Number(process.env.PORT || 4000);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok', servicio: 'pagos-mock' });
  }
  return sendJson(res, 501, {
    error: 'Pasarela simulada pendiente de implementación',
    code: 'NOT_IMPLEMENTED',
    retryable: false,
    action: 'Disponible en la Entrega 2'
  });
});

server.listen(port, () => console.log(`pagos-mock escuchando en http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
