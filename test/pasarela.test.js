const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solicitarCobro } = require('../src/lib/pasarela');
const { correlacion } = require('../src/middleware/correlacion');
const { ApiError } = require('../src/lib/errors');

const COBRO = { compraId: '6702a1b2c3d4e5f601234567', monto: 50000, escenario: 'aprobado', correlationId: 'corr-1' };
const respuesta = (status, cuerpo) => ({ status, json: async () => cuerpo });
const sinLog = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};
const esIndisponible = (error) => error instanceof ApiError && error.status === 503 && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE' && error.retryable === true;

test('solicitarCobro envía el pedido con el correlation id y devuelve la referencia', async () => {
  let pedido;
  const fetchImpl = async (url, opciones) => { pedido = { url, opciones }; return respuesta(201, { referenciaExterna: 'PAY-1234abcd' }); };
  const resultado = await solicitarCobro(COBRO, { baseUrl: 'http://pagos-mock:4000', fetchImpl });
  assert.deepEqual(resultado, { referenciaExterna: 'PAY-1234abcd' });
  assert.equal(pedido.url, 'http://pagos-mock:4000/pagos');
  assert.equal(pedido.opciones.method, 'POST');
  assert.equal(pedido.opciones.headers['X-Correlation-Id'], 'corr-1');
  assert.deepEqual(JSON.parse(pedido.opciones.body), { compraId: COBRO.compraId, monto: 50000, escenario: 'aprobado' });
});

test('un cobro repetido (200) también devuelve la referencia', async () => {
  const resultado = await solicitarCobro(COBRO, { fetchImpl: async () => respuesta(200, { referenciaExterna: 'PAY-1234abcd' }) });
  assert.equal(resultado.referenciaExterna, 'PAY-1234abcd');
});

test('un error de red, un timeout, un status no 2xx o una respuesta sin referencia son 503 PAYMENT_PROVIDER_UNAVAILABLE', async () => {
  const casos = [
    async () => { throw new TypeError('fetch failed'); },
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => respuesta(500, {}),
    async () => respuesta(400, { code: 'VALIDATION_ERROR' }),
    async () => respuesta(201, { sinReferencia: true }),
    async () => ({ status: 201, json: async () => { throw new SyntaxError('no es JSON'); } })
  ];
  await sinLog(async () => {
    for (const fetchImpl of casos) await assert.rejects(solicitarCobro(COBRO, { fetchImpl }), esIndisponible);
  });
});

test('el middleware de correlación respeta un id válido y genera un UUID si falta o es inválido', () => {
  const correr = (recibido) => {
    const cabeceras = {};
    const req = { header: () => recibido };
    let siguio = false;
    correlacion(req, { set: (k, v) => { cabeceras[k] = v; } }, () => { siguio = true; });
    return { id: req.correlationId, cabeceras, siguio };
  };
  const conocido = correr('mi-correlacion.123:abc');
  assert.equal(conocido.id, 'mi-correlacion.123:abc');
  assert.equal(conocido.cabeceras['X-Correlation-Id'], 'mi-correlacion.123:abc');
  assert.equal(conocido.siguio, true);

  for (const invalido of [undefined, '', 'con espacios', 'x'.repeat(129), 'ñ']) {
    const generado = correr(invalido);
    assert.match(generado.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, String(invalido));
    assert.equal(generado.cabeceras['X-Correlation-Id'], generado.id);
  }
});
