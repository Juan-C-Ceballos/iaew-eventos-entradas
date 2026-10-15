// Genera postman/iaew-eventos-entradas.postman_collection.json y los ambientes. La colección se escribe
// acá, como código, porque son decenas de peticiones con scripts parecidos y así se mantienen juntos
// (un cambio en el contrato se corrige en un lugar). El JSON generado se commitea para poder
// importarlo en Postman y correrlo con Newman sin ejecutar este archivo:
//
//   node postman/generar-coleccion.js
//   npx newman run postman/iaew-eventos-entradas.postman_collection.json -e postman/pruebas.postman_environment.json
//
// Cubre el flujo de punta a punta (CRUD de eventos, compra multi-paso, asincronía con polling,
// integración por webhook), la seguridad (OAuth 2.0 + scopes y x-api-key) y los errores del dominio.
const fs = require('node:fs');
const path = require('node:path');

// --- Scripts compartidos ------------------------------------------------------------------------
// Se pegan al principio de cada script que los usa. Usan concatenación y no plantillas de texto para
// no depender de cómo el sandbox de Postman interprete `${}`.
const PRELUDIO = [
  "const cuerpo = () => { try { return pm.response.json(); } catch (e) { return {}; } };",
  "// Un error de la API siempre tiene el formato { error, code, retryable, action } (ADR 0001).",
  "const esError = (estado, codigo) => {",
  "  pm.test('responde ' + estado + ' ' + codigo, function () {",
  "    pm.response.to.have.status(estado);",
  "    const c = cuerpo();",
  "    pm.expect(c.code).to.eql(codigo);",
  "    pm.expect(c).to.include.all.keys('error', 'code', 'retryable', 'action');",
  "    pm.expect(c.retryable).to.be.a('boolean');",
  "  });",
  "};"
];

// Espera entre intentos de un polling: el sandbox de Postman espera a que terminen los temporizadores.
const ESPERA_POLLING = [
  "if (Number(pm.collectionVariables.get('poll_n') || 0) > 0) { setTimeout(function () {}, 250); }"
];

// Repite la misma petición hasta que `cumple(cuerpo())` sea verdadero (máximo 40 intentos, ~10 s). Es la
// forma de ver el efecto de un proceso asincrónico (webhook, RabbitMQ, worker) desde una colección.
function polling(nombre, condicion, aserciones) {
  return [
    ...PRELUDIO,
    "const n = Number(pm.collectionVariables.get('poll_n') || 0);",
    "const listo = (function () { try { return (" + condicion + ")(cuerpo()); } catch (e) { return false; } })();",
    "if (!listo && n < 40) {",
    "  pm.collectionVariables.set('poll_n', n + 1);",
    "  (pm.execution && pm.execution.setNextRequest ? pm.execution.setNextRequest : postman.setNextRequest)(" + JSON.stringify(nombre) + ");",
    "} else {",
    "  pm.collectionVariables.unset('poll_n');",
    "  pm.test('el efecto asincrónico se ve antes de 40 intentos (' + n + ' reintentos)', function () { pm.expect(listo).to.eql(true); });",
    ...aserciones.map((l) => '  ' + l),
    "}"
  ];
}

// Una referencia escrita como {{variable}} se resuelve en el script: si quedara en el texto firmado, Postman la
// reemplazaría después de firmar y la firma ya no coincidiría con el cuerpo que se envía.
const expresionReferencia = (referencia) => {
  const variable = /^\{\{(\w+)\}\}$/.exec(referencia);
  return variable ? 'pm.collectionVariables.get(' + JSON.stringify(variable[1]) + ')' : JSON.stringify(referencia);
};

// Firma el cuerpo del webhook como la pasarela: sha256=HMAC(secreto, "<timestamp>.<cuerpo crudo>") (ADR 0006).
function firmarWebhook({ type, compraVar, referencia, motivo, desfaseSegundos = 0, firmaValida = true }) {
  return [
    "const compraId = pm.collectionVariables.get(" + JSON.stringify(compraVar) + ");",
    "const notificacion = {",
    "  notificacionId: pm.variables.replaceIn('{{$guid}}'),",
    "  type: " + JSON.stringify(type) + ",",
    "  occurredAt: new Date().toISOString(),",
    "  data: { compraId: compraId, referenciaExterna: " + expresionReferencia(referencia) + ", monto: 50000" + (motivo ? ", motivo: " + JSON.stringify(motivo) : '') + " }",
    "};",
    "const crudo = JSON.stringify(notificacion);",
    "const timestamp = String(Math.floor(Date.now() / 1000) + (" + desfaseSegundos + "));",
    firmaValida
      ? "const firma = 'sha256=' + CryptoJS.HmacSHA256(timestamp + '.' + crudo, pm.environment.get('webhookSecret') || pm.collectionVariables.get('webhookSecret')).toString(CryptoJS.enc.Hex);"
      : "const firma = 'sha256=' + '0'.repeat(64);",
    "pm.request.body.update(crudo);",
    "pm.request.headers.upsert({ key: 'X-Pago-Timestamp', value: timestamp });",
    "pm.request.headers.upsert({ key: 'X-Pago-Firma', value: firma });"
  ];
}

// --- Construcción de peticiones ---------------------------------------------------------------------
const ROLES = { organizador: 'token_organizador', canal: 'token_canal', control: 'token_control' };

function peticion({ nombre, metodo = 'GET', ruta, query, rol, cabeceras = {}, cuerpo, pre = [], test = [], descripcion }) {
  const header = Object.entries(cabeceras).map(([key, value]) => ({ key, value }));
  if (rol) header.unshift({ key: 'Authorization', value: 'Bearer {{' + ROLES[rol] + '}}' });
  if (cuerpo !== undefined) header.push({ key: 'Content-Type', value: 'application/json' });
  const partes = ruta.split('/').filter(Boolean);
  const raw = '{{baseUrl}}' + ruta + (query ? '?' + Object.entries(query).map(([k, v]) => k + '=' + v).join('&') : '');
  const eventos = [];
  if (pre.length) eventos.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } });
  if (test.length) eventos.push({ listen: 'test', script: { type: 'text/javascript', exec: test } });
  return {
    name: nombre,
    ...(descripcion ? { description: descripcion } : {}),
    event: eventos,
    request: {
      method: metodo,
      header,
      ...(cuerpo !== undefined ? { body: { mode: 'raw', raw: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo, null, 2), options: { raw: { language: 'json' } } } } : {}),
      url: { raw, host: ['{{baseUrl}}'], path: partes, ...(query ? { query: Object.entries(query).map(([key, value]) => ({ key, value })) } : {}) }
    }
  };
}

const carpeta = (nombre, descripcion, item) => ({ name: nombre, description: descripcion, item });
const guardar = (variable, expresion) => "pm.collectionVariables.set(" + JSON.stringify(variable) + ", " + expresion + ");";

const DATOS_ASISTENTE = { nombre: 'Ana Pérez', email: 'ana.perez@example.com', documento: '40123456' };
const compraBody = (eventoVar, cantidad) => '{\n  "eventoId": "{{' + eventoVar + '}}",\n  "cantidad": ' + cantidad + ',\n  "asistente": ' + JSON.stringify(DATOS_ASISTENTE) + '\n}';
const nuevaClave = (variable) => "pm.collectionVariables.set(" + JSON.stringify(variable) + ", 'newman:' + pm.variables.replaceIn('{{$guid}}'));";
const eventoBody = (extra) => JSON.stringify({ nombre: 'Evento de prueba (Newman)', descripcion: 'Creado por la colección de Postman', fecha: '{{fechaFutura}}', lugar: 'Sala de pruebas — Córdoba', capacidad: 6, precio: 25000, ...extra }, null, 2);

// --- Peticiones ----------------------------------------------------------------------------------------
const seguridad = carpeta('00 Seguridad: OAuth 2.0, scopes y x-api-key',
  'Token por client_credentials (se obtiene una vez y se reutiliza), 401 sin token, 403 sin el scope y la x-api-key como comparación (no reemplaza a OAuth).', [
    peticion({
      nombre: 'GET /health (pública)', ruta: '/health',
      test: [...PRELUDIO, "pm.test('200 y status ok', function () { pm.response.to.have.status(200); pm.expect(cuerpo().status).to.eql('ok'); });",
        "pm.test('devuelve X-Correlation-Id', function () { pm.expect(pm.response.headers.get('X-Correlation-Id')).to.be.a('string').and.not.empty; });"]
    }),
    peticion({
      nombre: 'GET /token-info con token del organizador', ruta: '/token-info', rol: 'organizador',
      test: [...PRELUDIO, "pm.test('200 con issuer, audience, scopes y vigencia', function () {",
        "  pm.response.to.have.status(200);",
        "  const t = cuerpo();",
        "  pm.expect(t.audience).to.include(pm.collectionVariables.get('audience'));",
        "  pm.expect(t.scopes.split(' ')).to.have.members(['read:eventos', 'write:eventos', 'admin:eventos']);",
        "  pm.expect(t.expiresInSeconds).to.be.above(0);",
        "});"]
    }),
    peticion({
      nombre: 'GET /token-info sin token → 401', ruta: '/token-info',
      test: [...PRELUDIO, "esError(401, 'TOKEN_INVALID');", "pm.test('incluye WWW-Authenticate: Bearer', function () { pm.expect(pm.response.headers.get('WWW-Authenticate')).to.match(/^Bearer/); });"]
    }),
    peticion({
      nombre: 'GET /token-info con un token inventado → 401', ruta: '/token-info', cabeceras: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.firma-falsa' },
      test: [...PRELUDIO, "esError(401, 'TOKEN_INVALID');"]
    }),
    peticion({
      nombre: 'POST /eventos con el token del canal de venta → 403 SCOPE_REQUIRED', metodo: 'POST', ruta: '/eventos', rol: 'canal', cuerpo: '{}',
      test: [...PRELUDIO, "esError(403, 'SCOPE_REQUIRED');"]
    }),
    peticion({
      nombre: 'GET /internal/reportes/ventas sin x-api-key → 401', ruta: '/internal/reportes/ventas',
      test: [...PRELUDIO, "esError(401, 'API_KEY_INVALID');"]
    }),
    peticion({
      nombre: 'GET /internal/reportes/ventas con un token OAuth → 401 (no reemplaza a la x-api-key)', ruta: '/internal/reportes/ventas', rol: 'organizador',
      test: [...PRELUDIO, "esError(401, 'API_KEY_INVALID');"]
    })
  ]);

const eventos = carpeta('01 Eventos: CRUD (organizador)', 'Crear, validar, publicar, modificar la capacidad (mueve el cupo) y listar.', [
  peticion({
    nombre: 'POST /eventos (borrador)', metodo: 'POST', ruta: '/eventos', rol: 'organizador', cuerpo: eventoBody({}),
    test: [...PRELUDIO, "pm.test('201, borrador, cupo = capacidad y Location', function () {",
      "  pm.response.to.have.status(201);",
      "  const e = cuerpo();",
      "  pm.expect(e.estado).to.eql('borrador');",
      "  pm.expect(e.cupoDisponible).to.eql(6);",
      "  pm.expect(e).to.not.have.property('__v');",
      "  pm.expect(pm.response.headers.get('Location')).to.eql('/eventos/' + e._id);",
      "});",
      guardar('eventoId', 'cuerpo()._id')]
  }),
  peticion({
    nombre: 'POST /eventos con fecha pasada → 400 VALIDATION_ERROR', metodo: 'POST', ruta: '/eventos', rol: 'organizador', cuerpo: eventoBody({ fecha: '2020-01-01T10:00:00.000Z' }),
    test: [...PRELUDIO, "esError(400, 'VALIDATION_ERROR');", "pm.test('details indica el campo fecha', function () { pm.expect(cuerpo().details.fecha).to.be.a('string'); });"]
  }),
  peticion({
    nombre: 'POST /eventos con datos inválidos → 400 con details por campo', metodo: 'POST', ruta: '/eventos', rol: 'organizador', cuerpo: '{ "nombre": "", "capacidad": 0, "extra": true }',
    test: [...PRELUDIO, "esError(400, 'VALIDATION_ERROR');", "pm.test('details lista los campos inválidos', function () { pm.expect(Object.keys(cuerpo().details)).to.include.members(['nombre', 'capacidad', 'extra', 'fecha', 'lugar', 'precio']); });"]
  }),
  peticion({
    nombre: 'GET /eventos/{id} con un id mal formado → 400 INVALID_ID', ruta: '/eventos/abc', rol: 'canal',
    test: [...PRELUDIO, "esError(400, 'INVALID_ID');"]
  }),
  peticion({
    nombre: 'GET /eventos/{id} (canal de venta, read:eventos)', ruta: '/eventos/{{eventoId}}', rol: 'canal',
    test: [...PRELUDIO, "pm.test('200 y es el evento creado', function () { pm.response.to.have.status(200); pm.expect(cuerpo()._id).to.eql(pm.collectionVariables.get('eventoId')); });"]
  }),
  peticion({
    nombre: 'PATCH /eventos/{id} publica el evento', metodo: 'PATCH', ruta: '/eventos/{{eventoId}}', rol: 'organizador', cuerpo: '{ "estado": "publicado" }',
    test: [...PRELUDIO, "pm.test('200 y publicado', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('publicado'); });"]
  }),
  peticion({
    nombre: 'PATCH /eventos/{id} con estado cancelado → 400 (se cancela con POST /cancelar)', metodo: 'PATCH', ruta: '/eventos/{{eventoId}}', rol: 'organizador', cuerpo: '{ "estado": "cancelado" }',
    test: [...PRELUDIO, "esError(400, 'VALIDATION_ERROR');"]
  }),
  peticion({
    nombre: 'PATCH /eventos/{id} sube la capacidad y el cupo la acompaña', metodo: 'PATCH', ruta: '/eventos/{{eventoId}}', rol: 'organizador', cuerpo: '{ "capacidad": 8 }',
    test: [...PRELUDIO, "pm.test('capacidad 8 y cupo 8', function () { pm.response.to.have.status(200); pm.expect(cuerpo().capacidad).to.eql(8); pm.expect(cuerpo().cupoDisponible).to.eql(8); });"]
  }),
  peticion({
    nombre: 'GET /eventos?estado=publicado', ruta: '/eventos', query: { estado: 'publicado' }, rol: 'canal',
    test: [...PRELUDIO, "pm.test('200 y lista el evento, ordenados por fecha', function () {",
      "  pm.response.to.have.status(200);",
      "  const lista = cuerpo();",
      "  pm.expect(lista.map(function (e) { return e._id; })).to.include(pm.collectionVariables.get('eventoId'));",
      "  const fechas = lista.map(function (e) { return e.fecha; });",
      "  pm.expect(fechas).to.eql(fechas.slice().sort());",
      "});"]
  })
]);

const compra = carpeta('02 Compra de punta a punta (canal de venta)',
  'Reservar (cupo atómico + Idempotency-Key) → pagar (pasarela simulada) → webhook firmado → RabbitMQ → worker → entradas emitidas.', [
    peticion({
      nombre: 'POST /compras sin Idempotency-Key → 400', metodo: 'POST', ruta: '/compras', rol: 'canal', cuerpo: compraBody('eventoId', 2),
      test: [...PRELUDIO, "esError(400, 'IDEMPOTENCY_KEY_REQUIRED');"]
    }),
    peticion({
      nombre: 'POST /compras reserva 2 entradas', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveCompra}}' }, cuerpo: compraBody('eventoId', 2),
      pre: [nuevaClave('claveCompra'), nuevaClave('clavePago')],
      test: [...PRELUDIO, "pm.test('201, pendiente, total calculado por el servidor y sin datos internos', function () {",
        "  pm.response.to.have.status(201);",
        "  const r = cuerpo();",
        "  pm.expect(r.compra.estado).to.eql('pendiente');",
        "  pm.expect(r.compra.cantidad).to.eql(2);",
        "  pm.expect(r.compra.total).to.eql(50000);",
        "  pm.expect(r.compra.asistente.email).to.eql('ana.perez@example.com');",
        "  pm.expect(r.compra).to.not.have.any.keys('idempotencyKey', 'idempotencyFingerprint', 'emisionEvento');",
        "  pm.expect(r.idempotencia.replayed).to.eql(false);",
        "  pm.expect(pm.response.headers.get('Idempotency-Replayed')).to.eql('false');",
        "});",
        guardar('compraId', 'cuerpo().compra._id')]
    }),
    peticion({
      nombre: 'POST /compras repetida con la misma clave → replay, mismo resultado', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveCompra}}' }, cuerpo: compraBody('eventoId', 2),
      test: [...PRELUDIO, "pm.test('201, replayed y la misma compra', function () {",
        "  pm.response.to.have.status(201);",
        "  pm.expect(cuerpo().idempotencia.replayed).to.eql(true);",
        "  pm.expect(pm.response.headers.get('Idempotency-Replayed')).to.eql('true');",
        "  pm.expect(cuerpo().compra._id).to.eql(pm.collectionVariables.get('compraId'));",
        "});"]
    }),
    peticion({
      nombre: 'POST /compras con la misma clave y otro cuerpo → 409 IDEMPOTENCY_KEY_MISMATCH', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveCompra}}' }, cuerpo: compraBody('eventoId', 3),
      test: [...PRELUDIO, "esError(409, 'IDEMPOTENCY_KEY_MISMATCH');"]
    }),
    peticion({
      nombre: 'GET /eventos/{id}: la reserva descontó el cupo una sola vez', ruta: '/eventos/{{eventoId}}', rol: 'canal',
      test: [...PRELUDIO, "pm.test('cupo 6 (8 − 2), no 4', function () { pm.expect(cuerpo().cupoDisponible).to.eql(6); });"]
    }),
    peticion({
      nombre: 'POST /compras/{id}/pagar (pago aprobado) → 202', metodo: 'POST', ruta: '/compras/{{compraId}}/pagar', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{clavePago}}' }, cuerpo: '{ "escenario": "aprobado" }',
      test: [...PRELUDIO, "pm.test('202, pago_pendiente, con vencimiento y la referencia de la pasarela', function () {",
        "  pm.response.to.have.status(202);",
        "  const c = cuerpo().compra;",
        "  pm.expect(['pago_pendiente', 'pagada']).to.include(c.estado);",
        "  pm.expect(c.pagoExpiraEn).to.be.a('string');",
        "  pm.expect(c.pago.referenciaExterna).to.match(/^PAY-/);",
        "  pm.expect(c.pago).to.not.have.property('idempotencyKey');",
        "  pm.expect(pm.response.headers.get('X-Correlation-Id')).to.be.a('string');",
        "});",
        guardar('referenciaPago', 'cuerpo().compra.pago.referenciaExterna')]
    }),
    peticion({
      nombre: 'POST /compras/{id}/pagar repetida con la misma clave → 202 replay', metodo: 'POST', ruta: '/compras/{{compraId}}/pagar', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{clavePago}}' }, cuerpo: '{ "escenario": "aprobado" }',
      test: [...PRELUDIO, "pm.test('202, replayed y la misma referencia (un solo cobro)', function () {",
        "  pm.response.to.have.status(202);",
        "  pm.expect(cuerpo().idempotencia.replayed).to.eql(true);",
        "  pm.expect(cuerpo().compra.pago.referenciaExterna).to.eql(pm.collectionVariables.get('referenciaPago'));",
        "});"]
    }),
    (() => {
      const nombre = 'GET /compras/{id}: espera el webhook (la compra queda pagada)';
      return peticion({
        nombre, ruta: '/compras/{{compraId}}', rol: 'canal', pre: ESPERA_POLLING,
        test: polling(nombre, "function (c) { return c.estado === 'pagada'; }", [
          "pm.test('la pasarela notificó y la compra quedó pagada, sin exponer el outbox', function () {",
          "  const c = cuerpo();",
          "  pm.expect(c.estado).to.eql('pagada');",
          "  pm.expect(c.pago.estado).to.eql('aprobado');",
          "  pm.expect(c.emisionEstado).to.be.oneOf(['pendiente', 'emitida']);",
          "  pm.expect(c).to.not.have.any.keys('emisionEvento', 'emisionPublicadaEn');",
          "});"
        ])
      });
    })(),
    (() => {
      const nombre = 'GET /compras/{id}/entradas: espera al worker (de [] a 2 entradas)';
      return peticion({
        nombre, ruta: '/compras/{{compraId}}/entradas', rol: 'canal', pre: ESPERA_POLLING,
        test: polling(nombre, "function (e) { return e.length === 2; }", [
          "pm.test('el worker emitió una entrada por unidad, con código único y titular sin email', function () {",
          "  const entradas = cuerpo();",
          "  pm.expect(entradas.map(function (e) { return e.numero; })).to.eql([1, 2]);",
          "  entradas.forEach(function (e) {",
          "    pm.expect(e.codigo).to.match(/^ENT-[A-Z0-9]{12}$/);",
          "    pm.expect(e.estado).to.eql('emitida');",
          "    pm.expect(e.titular).to.eql({ nombre: 'Ana Pérez', documento: '40123456' });",
          "  });",
          "  pm.expect(entradas[0].codigo).to.not.eql(entradas[1].codigo);",
          "});",
          guardar('codigoEntrada', 'cuerpo()[0].codigo'),
          guardar('codigoEntrada2', 'cuerpo()[1].codigo')
        ])
      });
    })(),
    peticion({
      nombre: 'GET /compras/{id}: la emisión queda registrada', ruta: '/compras/{{compraId}}', rol: 'canal',
      test: [...PRELUDIO, "pm.test('emisionEstado emitida', function () { pm.expect(cuerpo().emisionEstado).to.eql('emitida'); pm.expect(cuerpo().emitidaEn).to.be.a('string'); });"]
    }),
    peticion({
      nombre: 'GET /compras (solo las del cliente) incluye la compra', ruta: '/compras', rol: 'canal',
      test: [...PRELUDIO, "pm.test('200 y la lista incluye la compra, de la más nueva a la más vieja', function () {",
        "  pm.response.to.have.status(200);",
        "  const lista = cuerpo();",
        "  pm.expect(lista.map(function (c) { return c._id; })).to.include(pm.collectionVariables.get('compraId'));",
        "  const fechas = lista.map(function (c) { return c.createdAt; });",
        "  pm.expect(fechas).to.eql(fechas.slice().sort().reverse());",
        "});"]
    })
  ]);

const controlAcceso = carpeta('03 Control de acceso (puerta del evento)', 'Validar la entrada una sola vez y rechazar reingreso, otro evento e inexistentes.', [
  peticion({
    nombre: 'GET /entradas/{codigo}', ruta: '/entradas/{{codigoEntrada}}', rol: 'control',
    test: [...PRELUDIO, "pm.test('200, emitida y con el titular', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('emitida'); pm.expect(cuerpo().titular.documento).to.eql('40123456'); });"]
  }),
  peticion({
    nombre: 'POST /entradas/{codigo}/validar en la puerta de otro evento → 409 TICKET_WRONG_EVENT', metodo: 'POST', ruta: '/entradas/{{codigoEntrada}}/validar', rol: 'control', cuerpo: '{ "eventoId": "66f0000000000000000000ff" }',
    test: [...PRELUDIO, "esError(409, 'TICKET_WRONG_EVENT');", "pm.test('informa el evento de la entrada', function () { pm.expect(cuerpo().details.eventoEntrada).to.eql(pm.collectionVariables.get('eventoId')); });"]
  }),
  peticion({
    nombre: 'POST /entradas/{codigo}/validar con el token del canal de venta → 403', metodo: 'POST', ruta: '/entradas/{{codigoEntrada}}/validar', rol: 'canal', cuerpo: '{ "eventoId": "{{eventoId}}" }',
    test: [...PRELUDIO, "esError(403, 'SCOPE_REQUIRED');"]
  }),
  peticion({
    nombre: 'POST /entradas/{codigo}/validar → acceso permitido', metodo: 'POST', ruta: '/entradas/{{codigoEntrada}}/validar', rol: 'control', cuerpo: '{ "eventoId": "{{eventoId}}" }',
    test: [...PRELUDIO, "pm.test('200 acceso_permitido, usada y con quién la validó', function () {",
      "  pm.response.to.have.status(200);",
      "  pm.expect(cuerpo().resultado).to.eql('acceso_permitido');",
      "  pm.expect(cuerpo().entrada.estado).to.eql('usada');",
      "  pm.expect(cuerpo().entrada.validadaPor).to.match(/@clients$/);",
      "  pm.expect(cuerpo().entrada.usadaEn).to.be.a('string');",
      "});"]
  }),
  peticion({
    nombre: 'POST /entradas/{codigo}/validar otra vez → 409 TICKET_ALREADY_USED', metodo: 'POST', ruta: '/entradas/{{codigoEntrada}}/validar', rol: 'control', cuerpo: '{ "eventoId": "{{eventoId}}" }',
    test: [...PRELUDIO, "esError(409, 'TICKET_ALREADY_USED');", "pm.test('informa cuándo se usó', function () { pm.expect(cuerpo().details.usadaEn).to.be.a('string'); });"]
  }),
  peticion({
    nombre: 'GET /entradas/{codigo} inexistente → 404 TICKET_NOT_FOUND', ruta: '/entradas/ENT-ZZZZZZZZZZZZ', rol: 'control',
    test: [...PRELUDIO, "esError(404, 'TICKET_NOT_FOUND');"]
  }),
  peticion({
    nombre: 'POST /entradas/{codigo}/validar con datos inválidos → 400', metodo: 'POST', ruta: '/entradas/{{codigoEntrada2}}/validar', rol: 'control', cuerpo: '{ "eventoId": "no-es-un-id" }',
    test: [...PRELUDIO, "esError(400, 'VALIDATION_ERROR');"]
  })
]);

const errores = carpeta('04 Errores del dominio y webhook de pago', 'Evento agotado, evento no publicado, pago rechazado (libera el cupo) y la integración por webhook: firma, anti-replay, duplicado y contradicción.', [
  peticion({
    nombre: 'POST /eventos crea un evento de 1 lugar, ya publicado', metodo: 'POST', ruta: '/eventos', rol: 'organizador', cuerpo: eventoBody({ nombre: 'Evento de 1 lugar (Newman)', capacidad: 1, estado: 'publicado' }),
    test: [...PRELUDIO, "pm.test('201 publicado con 1 lugar', function () { pm.response.to.have.status(201); pm.expect(cuerpo().estado).to.eql('publicado'); pm.expect(cuerpo().cupoDisponible).to.eql(1); });", guardar('eventoChicoId', 'cuerpo()._id')]
  }),
  peticion({
    nombre: 'POST /compras reserva el único lugar', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveChico1}}' }, cuerpo: compraBody('eventoChicoId', 1),
    pre: [nuevaClave('claveChico1'), nuevaClave('claveChico2')],
    test: [...PRELUDIO, "pm.test('201', function () { pm.response.to.have.status(201); });", guardar('compraChicoId', 'cuerpo().compra._id')]
  }),
  peticion({
    nombre: 'POST /compras sobre un evento agotado → 409 EVENT_SOLD_OUT', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveChico2}}' }, cuerpo: compraBody('eventoChicoId', 1),
    test: [...PRELUDIO, "esError(409, 'EVENT_SOLD_OUT');", "pm.test('details: cupo 0 y solicitado 1', function () { pm.expect(cuerpo().details.cupoDisponible).to.eql(0); pm.expect(cuerpo().details.solicitado).to.eql(1); });"]
  }),
  peticion({
    nombre: 'POST /eventos crea un evento en borrador', metodo: 'POST', ruta: '/eventos', rol: 'organizador', cuerpo: eventoBody({ nombre: 'Evento en borrador (Newman)' }),
    test: [...PRELUDIO, "pm.test('201 borrador', function () { pm.response.to.have.status(201); });", guardar('eventoBorradorId', 'cuerpo()._id')]
  }),
  peticion({
    nombre: 'POST /compras sobre un evento en borrador → 409 EVENT_NOT_PUBLISHED', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveBorrador}}' }, cuerpo: compraBody('eventoBorradorId', 1),
    pre: [nuevaClave('claveBorrador')],
    test: [...PRELUDIO, "esError(409, 'EVENT_NOT_PUBLISHED');", "pm.test('details: estado borrador', function () { pm.expect(cuerpo().details.estado).to.eql('borrador'); });"]
  }),
  peticion({
    nombre: 'POST /compras reserva 1 entrada para el pago que va a ser rechazado', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveRechazo}}' }, cuerpo: compraBody('eventoId', 1),
    pre: [nuevaClave('claveRechazo'), nuevaClave('clavePagoRechazo')],
    test: [...PRELUDIO, "pm.test('201', function () { pm.response.to.have.status(201); });", guardar('compraRechazadaId', 'cuerpo().compra._id')]
  }),
  peticion({
    nombre: 'POST /compras/{id}/pagar con escenario rechazado → 202', metodo: 'POST', ruta: '/compras/{{compraRechazadaId}}/pagar', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{clavePagoRechazo}}' }, cuerpo: '{ "escenario": "rechazado" }',
    test: [...PRELUDIO, "pm.test('202 (el resultado llega por webhook)', function () { pm.response.to.have.status(202); });"]
  }),
  (() => {
    const nombre = 'GET /compras/{id}: espera el webhook (la compra queda rechazada)';
    return peticion({
      nombre, ruta: '/compras/{{compraRechazadaId}}', rol: 'canal', pre: ESPERA_POLLING,
      test: polling(nombre, "function (c) { return c.estado === 'rechazada'; }", [
        "pm.test('rechazada, con el motivo y sin evento de emisión', function () {",
        "  pm.expect(cuerpo().estado).to.eql('rechazada');",
        "  pm.expect(cuerpo().pago.estado).to.eql('rechazado');",
        "  pm.expect(cuerpo().pago.motivoRechazo).to.eql('fondos_insuficientes');",
        "});"
      ])
    });
  })(),
  peticion({
    nombre: 'GET /eventos/{id}: el rechazo devolvió el cupo', ruta: '/eventos/{{eventoId}}', rol: 'canal',
    test: [...PRELUDIO, "pm.test('el cupo volvió a 6', function () { pm.expect(cuerpo().cupoDisponible).to.eql(6); });"]
  }),
  peticion({
    nombre: 'POST /webhooks/pagos con firma inválida → 401 WEBHOOK_SIGNATURE_INVALID', metodo: 'POST', ruta: '/webhooks/pagos', cuerpo: '{}',
    pre: firmarWebhook({ type: 'pago.aprobado', compraVar: 'compraId', referencia: 'PAY-falso', firmaValida: false }),
    test: [...PRELUDIO, "esError(401, 'WEBHOOK_SIGNATURE_INVALID');"]
  }),
  peticion({
    nombre: 'POST /webhooks/pagos con la firma válida pero un timestamp viejo → 401 WEBHOOK_TIMESTAMP_EXPIRED', metodo: 'POST', ruta: '/webhooks/pagos', cuerpo: '{}',
    pre: firmarWebhook({ type: 'pago.aprobado', compraVar: 'compraId', referencia: 'PAY-viejo', desfaseSegundos: -3600 }),
    test: [...PRELUDIO, "esError(401, 'WEBHOOK_TIMESTAMP_EXPIRED');"]
  }),
  peticion({
    nombre: 'POST /webhooks/pagos repetido sobre una compra pagada → 200 duplicado', metodo: 'POST', ruta: '/webhooks/pagos', cuerpo: '{}',
    pre: firmarWebhook({ type: 'pago.aprobado', compraVar: 'compraId', referencia: '{{referenciaPago}}' }),
    test: [...PRELUDIO, "pm.test('200 con duplicado:true y sin efectos', function () {",
      "  pm.response.to.have.status(200);",
      "  pm.expect(cuerpo()).to.eql({ recibido: true, duplicado: true, compraId: pm.collectionVariables.get('compraId'), estadoCompra: 'pagada' });",
      "});"]
  }),
  peticion({
    nombre: 'POST /webhooks/pagos rechazado sobre una compra pagada → 409 PURCHASE_INVALID_STATE', metodo: 'POST', ruta: '/webhooks/pagos', cuerpo: '{}',
    pre: firmarWebhook({ type: 'pago.rechazado', compraVar: 'compraId', referencia: 'PAY-contradictorio', motivo: 'fondos_insuficientes' }),
    test: [...PRELUDIO, "esError(409, 'PURCHASE_INVALID_STATE');", "pm.test('details: sigue pagada', function () { pm.expect(cuerpo().details.estado).to.eql('pagada'); });"]
  }),
  peticion({
    nombre: 'POST /webhooks/pagos de una compra inexistente → 404 PURCHASE_NOT_FOUND', metodo: 'POST', ruta: '/webhooks/pagos', cuerpo: '{}',
    pre: [guardar('compraInexistenteId', "'6702a1b2c3d4e5f6012345ff'"), ...firmarWebhook({ type: 'pago.aprobado', compraVar: 'compraInexistenteId', referencia: 'PAY-nada' })],
    test: [...PRELUDIO, "esError(404, 'PURCHASE_NOT_FOUND');"]
  })
]);

const cancelaciones = carpeta('05 Cancelaciones y cascada', 'Cancelar una reserva (libera el cupo, idempotente), no cancelar una compra pagada y cancelar un evento con ventas.', [
  peticion({
    nombre: 'POST /compras reserva 1 entrada para cancelar', metodo: 'POST', ruta: '/compras', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{claveCancelar}}' }, cuerpo: compraBody('eventoId', 1),
    pre: [nuevaClave('claveCancelar')],
    test: [...PRELUDIO, "pm.test('201', function () { pm.response.to.have.status(201); });", guardar('compraCancelarId', 'cuerpo().compra._id')]
  }),
  peticion({
    nombre: 'POST /compras/{id}/cancelar libera el cupo', metodo: 'POST', ruta: '/compras/{{compraCancelarId}}/cancelar', rol: 'canal',
    test: [...PRELUDIO, "pm.test('200 cancelada', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('cancelada'); });"]
  }),
  peticion({
    nombre: 'POST /compras/{id}/cancelar otra vez → 200 (idempotente)', metodo: 'POST', ruta: '/compras/{{compraCancelarId}}/cancelar', rol: 'canal',
    test: [...PRELUDIO, "pm.test('200 y sigue cancelada', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('cancelada'); });"]
  }),
  peticion({
    nombre: 'GET /eventos/{id}: el cupo se liberó una sola vez', ruta: '/eventos/{{eventoId}}', rol: 'canal',
    test: [...PRELUDIO, "pm.test('cupo 6', function () { pm.expect(cuerpo().cupoDisponible).to.eql(6); });"]
  }),
  peticion({
    nombre: 'POST /compras/{id}/cancelar sobre una compra pagada → 409 PURCHASE_INVALID_STATE', metodo: 'POST', ruta: '/compras/{{compraId}}/cancelar', rol: 'canal',
    test: [...PRELUDIO, "esError(409, 'PURCHASE_INVALID_STATE');"]
  }),
  peticion({
    nombre: 'POST /compras/{id}/pagar sobre una compra cancelada → 409', metodo: 'POST', ruta: '/compras/{{compraCancelarId}}/pagar', rol: 'canal', cabeceras: { 'Idempotency-Key': '{{clavePagoCancelada}}' }, cuerpo: '{}',
    pre: [nuevaClave('clavePagoCancelada')],
    test: [...PRELUDIO, "esError(409, 'PURCHASE_INVALID_STATE');"]
  }),
  peticion({
    nombre: 'DELETE /eventos/{id} de un evento con ventas → 409 EVENT_HAS_SALES', metodo: 'DELETE', ruta: '/eventos/{{eventoId}}', rol: 'organizador',
    test: [...PRELUDIO, "esError(409, 'EVENT_HAS_SALES');"]
  }),
  peticion({
    nombre: 'DELETE /eventos/{id} con el scope write (sin admin) → 403', metodo: 'DELETE', ruta: '/eventos/{{eventoBorradorId}}', rol: 'canal',
    test: [...PRELUDIO, "esError(403, 'SCOPE_REQUIRED');"]
  }),
  peticion({
    nombre: 'POST /eventos/{id}/cancelar cancela el evento con ventas', metodo: 'POST', ruta: '/eventos/{{eventoId}}/cancelar', rol: 'organizador',
    test: [...PRELUDIO, "pm.test('200 cancelado (corta las ventas al instante)', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('cancelado'); });"]
  }),
  (() => {
    const nombre = 'GET /compras/{id}/entradas: la cascada anula la entrada sin usar';
    return peticion({
      nombre, ruta: '/compras/{{compraId}}/entradas', rol: 'canal', pre: ESPERA_POLLING,
      test: polling(nombre, "function (e) { return e.length === 2 && e.every(function (x) { return x.estado !== 'emitida'; }); }", [
        "pm.test('la usada no se toca y la otra queda anulada', function () {",
        "  pm.expect(cuerpo().map(function (e) { return e.estado; })).to.eql(['usada', 'anulada']);",
        "});"
      ])
    });
  })(),
  peticion({
    nombre: 'GET /compras/{id}: la compra pagada queda con reembolsoPendiente', ruta: '/compras/{{compraId}}', rol: 'canal',
    test: [...PRELUDIO, "pm.test('sigue pagada y marcada para reembolso (no hay reembolso real)', function () { pm.expect(cuerpo().estado).to.eql('pagada'); pm.expect(cuerpo().reembolsoPendiente).to.eql(true); });"]
  }),
  peticion({
    nombre: 'POST /entradas/{codigo}/validar en un evento cancelado → 409 EVENT_NOT_ACTIVE', metodo: 'POST', ruta: '/entradas/{{codigoEntrada2}}/validar', rol: 'control', cuerpo: '{ "eventoId": "{{eventoId}}" }',
    test: [...PRELUDIO, "esError(409, 'EVENT_NOT_ACTIVE');", "pm.test('details: cancelado', function () { pm.expect(cuerpo().details.estado).to.eql('cancelado'); });"]
  }),
  peticion({
    nombre: 'POST /eventos/{id}/cancelar otra vez → 200 (idempotente)', metodo: 'POST', ruta: '/eventos/{{eventoId}}/cancelar', rol: 'organizador',
    test: [...PRELUDIO, "pm.test('200 y sigue cancelado', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('cancelado'); });"]
  }),
  peticion({
    nombre: 'POST /eventos/{id}/cancelar sobre un borrador → 409 INVALID_STATE_TRANSITION', metodo: 'POST', ruta: '/eventos/{{eventoBorradorId}}/cancelar', rol: 'organizador',
    test: [...PRELUDIO, "esError(409, 'INVALID_STATE_TRANSITION');"]
  })
]);

const reporte = carpeta('06 Reporte interno (x-api-key)', 'Endpoint de comparación protegido con una clave estática.', [
  peticion({
    nombre: 'GET /internal/reportes/ventas con x-api-key', ruta: '/internal/reportes/ventas', cabeceras: { 'x-api-key': '{{apiKey}}' },
    test: [...PRELUDIO, "pm.test('200 con las ventas del evento de la prueba', function () {",
      "  pm.response.to.have.status(200);",
      "  const r = cuerpo();",
      "  pm.expect(new Date(r.generadoEn).toString()).to.not.eql('Invalid Date');",
      "  const e = r.eventos.filter(function (x) { return x.eventoId === pm.collectionVariables.get('eventoId'); })[0];",
      "  pm.expect(e).to.be.an('object');",
      "  pm.expect(e.entradasVendidas).to.eql(2);",
      "  pm.expect(e.recaudado).to.eql(50000);",
      "  pm.expect(e.capacidad).to.eql(8);",
      "});"]
  })
]);

const limpieza = carpeta('99 Limpieza', 'Borra el evento en borrador (sin ventas). Los eventos con compras no se pueden borrar: se cancelan.', [
  peticion({
    nombre: 'DELETE /eventos/{id} del borrador (admin:eventos)', metodo: 'DELETE', ruta: '/eventos/{{eventoBorradorId}}', rol: 'organizador',
    test: [...PRELUDIO, "pm.test('204 sin cuerpo', function () { pm.response.to.have.status(204); });"]
  }),
  peticion({
    nombre: 'GET /eventos/{id} del evento borrado → 404 EVENT_NOT_FOUND', ruta: '/eventos/{{eventoBorradorId}}', rol: 'organizador',
    test: [...PRELUDIO, "esError(404, 'EVENT_NOT_FOUND');"]
  }),
  peticion({
    nombre: 'POST /eventos/{id}/cancelar del evento de 1 lugar', metodo: 'POST', ruta: '/eventos/{{eventoChicoId}}/cancelar', rol: 'organizador',
    test: [...PRELUDIO, "pm.test('200 cancelado', function () { pm.response.to.have.status(200); pm.expect(cuerpo().estado).to.eql('cancelado'); });"]
  })
]);

// --- Token: se pide una vez por rol y se reutiliza hasta que se acerca a su vencimiento ----------------------
const PRE_REQUEST_COLECCION = [
  "// Variables de ejecución: fechas y claves nuevas en cada corrida.",
  "if (!pm.collectionVariables.get('fechaFutura')) {",
  "  pm.collectionVariables.set('fechaFutura', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());",
  "}",
  "// Tokens (client_credentials): uno por rol, reutilizado hasta 60 s antes de vencer. Pedir un token por",
  "// request agotaría el cupo de tokens de Auth0 y no es lo que haría un cliente real.",
  "const base = pm.environment.get('auth0BaseUrl') || pm.collectionVariables.get('auth0BaseUrl');",
  "const audience = pm.environment.get('audience') || pm.collectionVariables.get('audience');",
  "pm.collectionVariables.set('audience', audience);",
  "const roles = [['organizador', 'clientIdOrganizador', 'clientSecretOrganizador'], ['canal', 'clientIdCanal', 'clientSecretCanal'], ['control', 'clientIdControl', 'clientSecretControl']];",
  "roles.forEach(function (rol) {",
  "  const vence = Number(pm.collectionVariables.get('token_' + rol[0] + '_exp') || 0);",
  "  if (Date.now() < vence - 60000 && pm.collectionVariables.get('token_' + rol[0])) { return; }",
  "  pm.sendRequest({",
  "    url: base + '/oauth/token', method: 'POST', header: { 'Content-Type': 'application/json' },",
  "    body: { mode: 'raw', raw: JSON.stringify({ client_id: pm.environment.get(rol[1]), client_secret: pm.environment.get(rol[2]), audience: audience, grant_type: 'client_credentials' }) }",
  "  }, function (error, respuesta) {",
  "    if (error || respuesta.code !== 200) {",
  "      throw new Error('No se pudo obtener el token de ' + rol[0] + ' (' + (error ? error.message : respuesta.code + ' ' + respuesta.text()) + '). Revisar auth0BaseUrl, audience y las credenciales del ambiente.');",
  "    }",
  "    const t = respuesta.json();",
  "    pm.collectionVariables.set('token_' + rol[0], t.access_token);",
  "    pm.collectionVariables.set('token_' + rol[0] + '_exp', String(Date.now() + t.expires_in * 1000));",
  "  });",
  "});"
];

const coleccion = {
  info: {
    name: 'IAEW 2026 — Eventos y Entradas',
    description: [
      'Colección ejecutable del TPI: recorre la API de punta a punta y verifica cada respuesta con pm.test.',
      '',
      '**Ambientes:** `local` (API en localhost, tokens de Auth0), `pruebas` (API en localhost con el emisor OAuth local de docker-compose.pruebas.yml) y `docker` (corriendo dentro de la red de Compose).',
      '**Tokens:** se piden por `client_credentials` una sola vez por rol y se reutilizan. Las credenciales salen del ambiente y nunca se commitean (en `local` están vacías).',
      '**Ejecución:** `npx newman run postman/iaew-eventos-entradas.postman_collection.json -e postman/pruebas.postman_environment.json`.',
      '**Orden:** las carpetas dependen unas de otras (usan el evento y la compra creados antes): correr la colección completa.',
      '',
      'Se genera con `node postman/generar-coleccion.js`.'
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: PRE_REQUEST_COLECCION } }],
  variable: [
    { key: 'audience', value: 'https://iaew-eventos-api' },
    { key: 'webhookSecret', value: '' }
  ],
  item: [seguridad, eventos, compra, controlAcceso, errores, cancelaciones, reporte, limpieza]
};

// --- Ambientes ----------------------------------------------------------------------------------------------
const ambiente = (nombre, valores) => ({
  id: nombre, name: `IAEW — ${nombre}`,
  values: Object.entries(valores).map(([key, value]) => ({ key, value, type: key.toLowerCase().includes('secret') || key === 'apiKey' ? 'secret' : 'default', enabled: true })),
  _postman_variable_scope: 'environment'
});
const VACIO = '';
// Credenciales del emisor local (scripts/emisor-local.js): valores de prueba, no secretos reales.
const EMISOR_LOCAL = {
  clientIdOrganizador: 'organizador-local', clientSecretOrganizador: 'secreto-organizador-local',
  clientIdCanal: 'canal-venta-local', clientSecretCanal: 'secreto-canal-venta-local',
  clientIdControl: 'control-acceso-local', clientSecretControl: 'secreto-control-acceso-local'
};
const CLAVES_DE_DESARROLLO = { apiKey: 'colocar-api-key-local', webhookSecret: 'colocar-secreto-compartido-local' }; // los valores por defecto de .env.example

const ambientes = {
  // API en localhost con Auth0 real: se completan las credenciales de las tres aplicaciones M2M (README, sección 6).
  local: ambiente('local', {
    baseUrl: 'http://localhost:3000', auth0BaseUrl: 'https://TU-TENANT.us.auth0.com', audience: 'https://iaew-eventos-api',
    clientIdOrganizador: VACIO, clientSecretOrganizador: VACIO, clientIdCanal: VACIO, clientSecretCanal: VACIO, clientIdControl: VACIO, clientSecretControl: VACIO,
    ...CLAVES_DE_DESARROLLO
  }),
  // API en localhost con el emisor OAuth local (docker compose -f docker-compose.yml -f docker-compose.pruebas.yml up -d).
  pruebas: ambiente('pruebas', {
    baseUrl: 'http://localhost:3000', auth0BaseUrl: 'http://localhost:4010', audience: 'https://iaew-eventos-api', ...EMISOR_LOCAL, ...CLAVES_DE_DESARROLLO
  }),
  // Newman corriendo como contenedor dentro de la red de Compose: los hosts son los nombres de servicio.
  docker: ambiente('docker', {
    baseUrl: 'http://api:3000', auth0BaseUrl: 'http://emisor-local:4010', audience: 'https://iaew-eventos-api', ...EMISOR_LOCAL, ...CLAVES_DE_DESARROLLO
  })
};

// POSTMAN_DESTINO permite generar en otra carpeta (los tests comparan el resultado con lo commiteado).
const destino = process.env.POSTMAN_DESTINO || __dirname;
fs.writeFileSync(path.join(destino, 'iaew-eventos-entradas.postman_collection.json'), JSON.stringify(coleccion, null, 2) + '\n');
for (const [nombre, contenido] of Object.entries(ambientes)) {
  fs.writeFileSync(path.join(destino, `${nombre}.postman_environment.json`), JSON.stringify(contenido, null, 2) + '\n');
}
const peticiones = coleccion.item.flatMap((c) => c.item).length;
console.log(`Colección generada: ${coleccion.item.length} carpetas, ${peticiones} peticiones; ${Object.keys(ambientes).length} ambientes.`);
