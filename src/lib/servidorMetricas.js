const http = require('node:http');
const metricas = require('./metricas');

// El worker no tiene API HTTP, así que expone sus métricas en un puerto propio para que Prometheus
// las recolecte junto con las de la api. Solo sirve GET /metrics (y /health para los chequeos).
function iniciarServidorMetricas({ port, registro = metricas.registro }) {
  const servidor = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://worker');
    if (req.method === 'GET' && pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': registro.contentType });
      return res.end(await registro.metrics());
    }
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Ruta inexistente', code: 'ROUTE_NOT_FOUND', retryable: false, action: 'Usar GET /metrics' }));
  });
  return new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(port, () => resolve(servidor));
  });
}

module.exports = { iniciarServidorMetricas };
