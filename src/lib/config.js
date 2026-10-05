function integerFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function retryConfig() {
  return {
    retryDelayMs: integerFromEnv('RETRY_DELAY_MS', 3000, { min: 1, max: 3600000 }),
    maxRetries: integerFromEnv('MAX_RETRIES', 3, { min: 0, max: 20 })
  };
}

// Plazos del ciclo de vida (ADR 0010): vencimiento del pago, cadencia del barrido del worker
// y cuánto después de `fecha` un evento publicado pasa a `finalizado`.
function plazosConfig() {
  return {
    pagoTimeoutMinutos: integerFromEnv('PAGO_TIMEOUT_MINUTOS', 30, { min: 1, max: 1440 }),
    barridoIntervaloMs: integerFromEnv('BARRIDO_INTERVALO_MS', 60000, { min: 1000, max: 3600000 }),
    eventoFinalizaTrasHoras: integerFromEnv('EVENTO_FINALIZA_TRAS_HORAS', 12, { min: 1, max: 168 })
  };
}

module.exports = { integerFromEnv, retryConfig, plazosConfig };
