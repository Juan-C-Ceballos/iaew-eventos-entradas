const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { plazosConfig, retryConfig } = require('../src/lib/config');

const VARIABLES = ['PAGO_TIMEOUT_MINUTOS', 'BARRIDO_INTERVALO_MS', 'EVENTO_FINALIZA_TRAS_HORAS', 'RETRY_DELAY_MS', 'MAX_RETRIES'];
afterEach(() => { for (const nombre of VARIABLES) delete process.env[nombre]; });

test('los plazos tienen valores por defecto', () => {
  assert.deepEqual(plazosConfig(), { pagoTimeoutMinutos: 30, barridoIntervaloMs: 60000, eventoFinalizaTrasHoras: 12 });
  assert.deepEqual(retryConfig(), { retryDelayMs: 3000, maxRetries: 3 });
});

test('los plazos se leen del entorno', () => {
  process.env.PAGO_TIMEOUT_MINUTOS = '10';
  process.env.BARRIDO_INTERVALO_MS = '5000';
  process.env.EVENTO_FINALIZA_TRAS_HORAS = '6';
  assert.deepEqual(plazosConfig(), { pagoTimeoutMinutos: 10, barridoIntervaloMs: 5000, eventoFinalizaTrasHoras: 6 });
});

test('el issuer de Auth0 se deriva del dominio y se puede reemplazar para las pruebas', () => {
  const { auth0Config } = require('../src/lib/config');
  const env = { AUTH0_DOMAIN: 'dev-xxxx.us.auth0.com', AUTH0_AUDIENCE: 'https://iaew-eventos-api' };
  assert.deepEqual(auth0Config(env), { issuerBaseURL: 'https://dev-xxxx.us.auth0.com', audience: 'https://iaew-eventos-api', tokenSigningAlg: 'RS256' });
  assert.equal(auth0Config({ ...env, AUTH0_ISSUER_URL: 'http://127.0.0.1:4010' }).issuerBaseURL, 'http://127.0.0.1:4010');
});

test('un plazo inválido falla al arrancar con un mensaje claro', () => {
  process.env.PAGO_TIMEOUT_MINUTOS = 'abc';
  assert.throws(() => plazosConfig(), /PAGO_TIMEOUT_MINUTOS debe ser un entero/);
  process.env.PAGO_TIMEOUT_MINUTOS = '30';
  process.env.BARRIDO_INTERVALO_MS = '10';
  assert.throws(() => plazosConfig(), /BARRIDO_INTERVALO_MS debe ser un entero entre 1000/);
});
