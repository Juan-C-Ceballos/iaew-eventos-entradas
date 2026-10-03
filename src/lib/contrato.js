const fs = require('node:fs');
const path = require('node:path');

const OPENAPI_PATH = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));

function toExpressPath(openapiPath) {
  return openapiPath.replace(/\{([^}]+)\}/g, ':$1');
}

function pendingRoutes(implementedPaths = []) {
  return Object.entries(openapi.paths)
    .filter(([openapiPath]) => !implementedPaths.includes(openapiPath))
    .flatMap(([openapiPath, item]) => HTTP_METHODS
      .filter((method) => item[method])
      .map((method) => ({ method, expressPath: toExpressPath(openapiPath) })));
}

module.exports = { openapi, pendingRoutes, toExpressPath };
