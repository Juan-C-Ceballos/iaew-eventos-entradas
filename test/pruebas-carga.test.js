const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// La colección de Postman, los ambientes, el plan de JMeter y el workflow de CI son archivos generados o
// escritos a mano que nadie ejecuta en cada cambio: estas pruebas estáticas evitan que se desactualicen
// respecto del contrato y del código. Que la colección pasa contra el sistema real lo comprueba `npm run postman`.
const raiz = path.join(__dirname, '..');
const leer = (archivo) => fs.readFileSync(path.join(raiz, archivo), 'utf8');
const json = (archivo) => JSON.parse(leer(archivo));
const openapi = json('docs/openapi.json');

const ENTORNOS = ['local', 'pruebas', 'docker'];
const coleccion = json('postman/iaew-eventos-entradas.postman_collection.json');

function peticiones(items = coleccion.item) {
  return items.flatMap((i) => (i.item ? peticiones(i.item) : [i]));
}
const guiones = (valor) => valor.replace(/\{[^}]+\}/g, '{p}'); // {id}, {codigo} → {p}
const rutaDe = (p) => guiones('/' + p.request.url.path.map((s) => (s.startsWith('{{') ? '{p}' : s)).join('/'));

function generarEn(carpeta, variable, comando) {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'iaew-gen-'));
  try {
    const res = spawnSync(process.execPath, [comando], { cwd: raiz, env: { ...process.env, [variable]: destino }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return Object.fromEntries(fs.readdirSync(destino).map((nombre) => [nombre, fs.readFileSync(path.join(destino, nombre), 'utf8')]));
  } finally {
    fs.rmSync(destino, { recursive: true, force: true });
  }
}

test('la colección y los ambientes commiteados son los que genera postman/generar-coleccion.js', () => {
  const generados = generarEn('postman', 'POSTMAN_DESTINO', 'postman/generar-coleccion.js');
  assert.deepEqual(Object.keys(generados).sort(), ['docker.postman_environment.json', 'iaew-eventos-entradas.postman_collection.json', 'local.postman_environment.json', 'pruebas.postman_environment.json']);
  for (const [nombre, contenido] of Object.entries(generados)) {
    assert.equal(leer(`postman/${nombre}`).replace(/\r\n/g, '\n'), contenido, `${nombre} está desactualizado: correr npm run postman:generar`);
  }
});

test('cada operación del contrato OpenAPI tiene al menos una petición en la colección', () => {
  const cubiertas = new Set(peticiones().map((p) => `${p.request.method} ${rutaDe(p)}`));
  const faltan = [];
  for (const [ruta, item] of Object.entries(openapi.paths)) {
    for (const metodo of ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item[m])) {
      if (!cubiertas.has(`${metodo.toUpperCase()} ${guiones(ruta)}`)) faltan.push(`${metodo.toUpperCase()} ${ruta}`);
    }
  }
  assert.deepEqual(faltan, [], 'operaciones del contrato sin ninguna petición en la colección');
});

test('toda petición verifica su respuesta con pm.test', () => {
  const sinTests = peticiones().filter((p) => !(p.event ?? []).some((e) => e.listen === 'test' && e.script.exec.join('\n').includes('pm.test(') || e.script.exec.join('\n').includes('esError(')));
  assert.deepEqual(sinTests.map((p) => p.name), []);
});

test('toda variable {{...}} de la colección la define el ambiente, la colección o un script', () => {
  const entornos = ENTORNOS.map((nombre) => json(`postman/${nombre}.postman_environment.json`));
  const delAmbiente = new Set(entornos[0].values.map((v) => v.key));
  const delaColeccion = new Set(coleccion.variable.map((v) => v.key));
  const guardadas = new Set([...JSON.stringify(coleccion).matchAll(/collectionVariables\.set\((?:\\"|')(\w+)/g)].map((m) => m[1]));
  // Las que arma el script de la colección con 'token_' + rol, y la fecha futura.
  for (const rol of ['organizador', 'canal', 'control']) guardadas.add(`token_${rol}`);

  const usadas = new Set();
  for (const p of peticiones()) {
    const texto = JSON.stringify([p.request.url, p.request.header, p.request.body]);
    for (const [, nombre] of texto.matchAll(/\{\{(\$?\w+)\}\}/g)) if (!nombre.startsWith('$')) usadas.add(nombre);
  }
  const sinDefinir = [...usadas].filter((v) => !delAmbiente.has(v) && !delaColeccion.has(v) && !guardadas.has(v));
  assert.deepEqual(sinDefinir, [], 'variables usadas que nadie define');
});

test('los tres ambientes definen las mismas variables y no llevan secretos reales', () => {
  const entornos = Object.fromEntries(ENTORNOS.map((nombre) => [nombre, json(`postman/${nombre}.postman_environment.json`)]));
  const claves = (e) => e.values.map((v) => v.key).sort();
  assert.deepEqual(claves(entornos.pruebas), claves(entornos.local));
  assert.deepEqual(claves(entornos.docker), claves(entornos.local));

  const valor = (nombre, clave) => entornos[nombre].values.find((v) => v.key === clave).value;
  // `local` usa Auth0 real: las credenciales de las aplicaciones M2M están vacías, nunca commiteadas.
  for (const clave of ['clientIdOrganizador', 'clientSecretOrganizador', 'clientIdCanal', 'clientSecretCanal', 'clientIdControl', 'clientSecretControl']) {
    assert.equal(valor('local', clave), '', `local.${clave} debe quedar vacío`);
  }
  // `pruebas` y `docker` usan el emisor local: sus credenciales son las de prueba de scripts/emisor-local.js.
  const { CLIENTES_POR_DEFECTO } = require('../scripts/emisor-local');
  assert.equal(valor('pruebas', 'clientSecretCanal'), CLIENTES_POR_DEFECTO['canal-venta-local'].secret);
  assert.equal(valor('pruebas', 'auth0BaseUrl'), 'http://localhost:4010');
  assert.equal(valor('docker', 'baseUrl'), 'http://api:3000');
  assert.equal(valor('docker', 'auth0BaseUrl'), 'http://emisor-local:4010');
  // La clave interna y el secreto del webhook son los valores de desarrollo de .env.example.
  const ejemplo = leer('.env.example');
  assert.match(ejemplo, new RegExp(`INTERNAL_API_KEY=${valor('pruebas', 'apiKey')}`));
  assert.match(ejemplo, new RegExp(`WEBHOOK_SECRET=${valor('pruebas', 'webhookSecret')}`));
  for (const nombre of ENTORNOS) {
    for (const v of entornos[nombre].values.filter((x) => x.key.toLowerCase().includes('secret') || x.key === 'apiKey')) assert.equal(v.type, 'secret', `${nombre}.${v.key} debe marcarse como secret`);
  }
});

test('los tokens se piden una vez por rol y se reutilizan hasta poco antes de vencer', () => {
  const script = coleccion.event.find((e) => e.listen === 'prerequest').script.exec.join('\n');
  assert.match(script, /\/oauth\/token/);
  assert.match(script, /client_credentials/);
  assert.match(script, /Date\.now\(\) < vence - 60000/, 'reutiliza el token mientras no esté por vencer');
  assert.equal([...script.matchAll(/pm\.sendRequest/g)].length, 1, 'un solo pedido de token por rol, dentro del bucle');
});

// --- Plan de JMeter ---------------------------------------------------------------------------------------------

test('el plan de JMeter commiteado es el que genera carga/generar-plan.js', () => {
  const generados = generarEn('carga', 'CARGA_DESTINO', 'carga/generar-plan.js');
  assert.deepEqual(Object.keys(generados), ['plan-carga.jmx']);
  assert.equal(leer('carga/plan-carga.jmx').replace(/\r\n/g, '\n'), generados['plan-carga.jmx'], 'plan-carga.jmx está desactualizado: correr npm run carga:generar');
});

test('el plan de JMeter es XML bien formado y sus samplers pegan a operaciones del contrato', () => {
  const xml = leer('carga/plan-carga.jmx');
  const pila = [];
  for (const [etiqueta, cierre, nombre, , autocierre] of [...xml.matchAll(/<(\/?)([A-Za-z0-9_.]+)([^>]*?)(\/?)>/g)].map((m) => [m[0], m[1], m[2], m[3], m[4]])) {
    if (etiqueta.startsWith('<?') || autocierre) continue;
    if (cierre) assert.equal(pila.pop(), nombre, `etiqueta desbalanceada: ${nombre}`); else pila.push(nombre);
  }
  assert.deepEqual(pila, []);

  const samplers = [...xml.matchAll(/testname="((?:GET|POST) [^"]+)"/g)].map((m) => m[1]).filter((n) => !n.startsWith('HTTP '));
  assert.ok(samplers.length >= 5, samplers.join(', '));
  const operacionesDelContrato = new Set(Object.entries(openapi.paths).flatMap(([ruta, item]) => ['get', 'post'].filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${guiones(ruta)}`)));
  for (const nombre of samplers) assert.ok(operacionesDelContrato.has(guiones(nombre)), `${nombre} no es una operación del contrato`);

  for (const parametro of ['host', 'port', 'protocolo', 'token', 'eventoId', 'hilos', 'rampa', 'duracion']) {
    assert.match(xml, new RegExp(`\\$\\{__P\\(${parametro},`), `falta el parámetro ${parametro}`);
  }
  assert.match(xml, /Idempotency-Key/, 'cada compra lleva su propia Idempotency-Key');
  assert.match(xml, /__UUID\(\)/);
});

test('el runner de la prueba de carga pasa a JMeter los mismos parámetros que lee el plan', () => {
  const runner = leer('carga/ejecutar.js');
  for (const parametro of ['host', 'port', 'protocolo', 'eventoId', 'hilos', 'rampa', 'duracion']) {
    assert.match(runner, new RegExp(`-J${parametro}=`), `ejecutar.js no pasa -J${parametro}`);
  }
  // El token no viaja como argumento (la imagen de JMeter imprime sus argumentos): va en un archivo de propiedades temporal.
  assert.equal(runner.includes('-Jtoken='), false, 'el token no debe pasarse con -J');
  assert.match(runner, /token\.properties/);
  assert.match(runner, /'-q', '\/secretos\/token\.properties'/);
  assert.match(runner, /fs\.rmSync\(secretos/, 'el archivo del token se borra al terminar');
  assert.match(runner, /host\.docker\.internal/, 'el contenedor de JMeter llega a la API del host');
});

// --- CI -------------------------------------------------------------------------------------------------------------

test('el workflow de CI corre las pruebas con MongoDB y RabbitMQ, el lint del contrato y la colección con Newman', () => {
  const ci = leer('.github/workflows/ci.yml');
  assert.match(ci, /image: mongo:7/);
  assert.match(ci, /image: rabbitmq:4\.2-management/);
  assert.match(ci, /MONGODB_URI_TEST:/);
  assert.match(ci, /RABBIT_URL_TEST:/);
  for (const paso of ['npm run check', 'npm test', 'npm run lint:openapi', 'docker-compose.pruebas.yml', 'newman run postman/iaew-eventos-entradas.postman_collection.json -e postman/pruebas.postman_environment.json']) {
    assert.ok(ci.includes(paso), `el workflow no ejecuta: ${paso}`);
  }
  assert.match(ci, /down -v/, 'el stack se baja aunque falle');
});

test('los scripts de npm apuntan a archivos que existen', () => {
  const { scripts } = json('package.json');
  for (const nombre of ['postman', 'postman:generar', 'carga', 'carga:generar']) assert.ok(scripts[nombre], `falta el script ${nombre}`);
  for (const archivo of [...scripts.postman.matchAll(/(postman\/[\w.-]+\.json)/g), ...Object.values(scripts).flatMap((s) => [...s.matchAll(/((?:postman|carga|scripts)\/[\w.-]+\.js)(?!\w)/g)])].map((m) => m[1])) {
    assert.ok(fs.existsSync(path.join(raiz, archivo)), `${archivo} no existe`);
  }
});
