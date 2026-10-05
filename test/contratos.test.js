const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const root = path.join(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const openapi = readJson('docs/openapi.json');
const eventSchema = readJson('docs/eventos/entrada-comprada.schema.json');
const SCOPES_DOMINIO = ['read:eventos', 'write:eventos', 'admin:eventos', 'buy:entradas', 'validate:entradas'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const operations = Object.entries(openapi.paths).flatMap(([route, item]) => HTTP_METHODS
  .filter((method) => item[method])
  .map((method) => ({ route, method, op: item[method] })));

function collectRefs(node, refs = []) {
  if (Array.isArray(node)) node.forEach((child) => collectRefs(child, refs));
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') refs.push(node.$ref);
    Object.values(node).forEach((child) => collectRefs(child, refs));
  }
  return refs;
}

test('el contrato declara exactamente los scopes del dominio', () => {
  const declared = Object.keys(openapi.components.securitySchemes.oauth2.flows.clientCredentials.scopes);
  assert.deepEqual([...declared].sort(), [...SCOPES_DOMINIO].sort());
});

test('cada operación declara seguridad explícita, operationId único y scopes válidos', () => {
  const ids = new Set();
  for (const { route, method, op } of operations) {
    const label = `${method.toUpperCase()} ${route}`;
    assert.ok(Array.isArray(op.security), `${label} sin security explícito`);
    assert.ok(op.operationId, `${label} sin operationId`);
    assert.ok(!ids.has(op.operationId), `operationId repetido: ${op.operationId}`);
    ids.add(op.operationId);
    for (const requirement of op.security) {
      for (const scope of requirement.oauth2 || []) {
        assert.ok(SCOPES_DOMINIO.includes(scope), `${label} usa scope desconocido ${scope}`);
      }
    }
  }
});

test('todas las referencias $ref internas del contrato existen', () => {
  for (const ref of collectRefs(openapi)) {
    const target = ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], openapi);
    assert.ok(target, `referencia rota: ${ref}`);
  }
});

test('el ejemplo de entrada.comprada valida contra su JSON Schema', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(eventSchema);
  const ejemplo = readJson('docs/eventos/ejemplos/entrada-comprada.ejemplo.json');
  assert.ok(validate(ejemplo), JSON.stringify(validate.errors));
});

test('el evento en OpenAPI coincide con el JSON Schema publicado', () => {
  const enOpenapi = openapi.components.schemas.EventoEntradaComprada;
  assert.deepEqual([...enOpenapi.required].sort(), [...eventSchema.required].sort());
  assert.deepEqual(Object.keys(enOpenapi.properties).sort(), Object.keys(eventSchema.properties).sort());
});

test('los servicios de docker-compose.yml coinciden con los de la vista C4 Container', () => {
  const compose = readText('docker-compose.yml');
  const servicesBlock = compose.split(/^services:\s*$/m)[1].split(/^\S/m)[0];
  const enCompose = [...servicesBlock.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((match) => match[1]).sort();
  assert.ok(enCompose.length >= 5, `servicios detectados: ${enCompose}`);

  // La tabla "Responsabilidades" del C4 lista un contenedor por fila: | `servicio` | ...
  const c4 = readText('docs/c4-container.md');
  const enC4 = [...c4.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]).sort();

  assert.deepEqual(enCompose.filter((servicio) => !enC4.includes(servicio)), [], 'servicios de Compose sin documentar en docs/c4-container.md');
  assert.deepEqual(enC4.filter((servicio) => !enCompose.includes(servicio)), [], 'contenedores del C4 que no existen en docker-compose.yml');
});
