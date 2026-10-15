const fs = require('node:fs');
const path = require('node:path');

const OPENAPI_PATH = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));

// `/compras/{id}/pagar` → `/compras/:id/pagar`
function toExpressPath(openapiPath) {
  return openapiPath.replace(/\{([^}]+)\}/g, ':$1');
}

// Todas las operaciones del contrato como `{ method, openapiPath, expressPath }`.
function operaciones() {
  return Object.entries(openapi.paths).flatMap(([openapiPath, item]) => HTTP_METHODS
    .filter((method) => item[method])
    .map((method) => ({ method, openapiPath, expressPath: toExpressPath(openapiPath) })));
}

module.exports = { openapi, operaciones, toExpressPath };
