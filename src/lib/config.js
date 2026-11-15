function integerFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, env = process.env) {
  const raw = env[name];
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

// Plazos del ciclo de vida (ADR 0007, 0010 y 0011): vencimiento de la reserva y del pago,
// cadencia del barrido del worker y cuánto después de `fecha` un evento publicado pasa a `finalizado`.
function plazosConfig() {
  return {
    reservaTtlMinutos: integerFromEnv('RESERVA_TTL_MINUTOS', 15, { min: 1, max: 1440 }),
    pagoTimeoutMinutos: integerFromEnv('PAGO_TIMEOUT_MINUTOS', 30, { min: 1, max: 1440 }),
    barridoIntervaloMs: integerFromEnv('BARRIDO_INTERVALO_MS', 60000, { min: 1000, max: 3600000 }),
    eventoFinalizaTrasHoras: integerFromEnv('EVENTO_FINALIZA_TRAS_HORAS', 12, { min: 1, max: 168 })
  };
}

// Verificación del webhook de pago (ADR 0006): secreto compartido con la pasarela y ventana
// anti-replay. Se lee en cada solicitud, así que el secreto se puede rotar reiniciando solo la api.
function webhookConfig(env = process.env) {
  return {
    secreto: env.WEBHOOK_SECRET,
    toleranciaSegundos: integerFromEnv('WEBHOOK_TOLERANCIA_SEGUNDOS', 300, { min: 1, max: 86400 }, env)
  };
}

// Validación del access token. `AUTH0_ISSUER_URL` es opcional y existe para apuntar a un emisor
// local en las pruebas; en el sistema real el issuer se deriva de `AUTH0_DOMAIN`. La librería
// rechaza un issuer http:// cuando NODE_ENV=production.
function auth0Config(env = process.env) {
  return {
    issuerBaseURL: env.AUTH0_ISSUER_URL || `https://${env.AUTH0_DOMAIN}`,
    audience: env.AUTH0_AUDIENCE,
    tokenSigningAlg: 'RS256'
  };
}

module.exports = { integerFromEnv, retryConfig, plazosConfig, webhookConfig, auth0Config };
