const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leerClave, requerirIdempotencyKey, huella } = require('../src/lib/idempotencia');
const { ApiError } = require('../src/lib/errors');

const rechazaCon = (codigo) => (error) => error instanceof ApiError && error.status === 400 && error.code === codigo;

test('leerClave acepta entre 8 y 128 caracteres permitidos', () => {
  for (const clave of ['abcd1234', 'compra:ana-40123456:recital:0001', 'a.b_c-d:e1', 'x'.repeat(128)]) {
    assert.equal(leerClave(clave), clave);
  }
});

test('leerClave distingue la clave ausente de la inválida', () => {
  assert.throws(() => leerClave(undefined), rechazaCon('IDEMPOTENCY_KEY_REQUIRED'));
  assert.throws(() => leerClave(''), rechazaCon('IDEMPOTENCY_KEY_REQUIRED'));
  for (const clave of ['corta', 'x'.repeat(129), 'con espacios 123', 'ñandú-12345', 'a,b,c,d,e,f,g,h']) {
    assert.throws(() => leerClave(clave), rechazaCon('IDEMPOTENCY_KEY_INVALID'), clave);
  }
});

test('el middleware deja la clave en req.idempotencyKey o deriva el error al manejador', () => {
  const req = { header: (nombre) => (nombre === 'Idempotency-Key' ? 'clave-valida-1' : undefined) };
  let recibido = 'sin llamar';
  requerirIdempotencyKey(req, {}, (error) => { recibido = error; });
  assert.equal(recibido, undefined);
  assert.equal(req.idempotencyKey, 'clave-valida-1');

  requerirIdempotencyKey({ header: () => undefined }, {}, (error) => { recibido = error; });
  assert.equal(recibido.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('la huella no depende del orden de los campos pero sí de los valores', () => {
  const a = { eventoId: '1', cantidad: 2, asistente: { nombre: 'Ana', documento: '40123456' } };
  const mismoCuerpo = { asistente: { documento: '40123456', nombre: 'Ana' }, cantidad: 2, eventoId: '1' };
  assert.equal(huella(a), huella(mismoCuerpo));
  assert.notEqual(huella(a), huella({ ...a, cantidad: 3 }));
  assert.notEqual(huella(a), huella({ ...a, asistente: { ...a.asistente, nombre: 'Ana P' } }));
  assert.match(huella(a), /^[0-9a-f]{64}$/);
  assert.equal(huella(undefined), huella({}));
});
