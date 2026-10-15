const { ApiError } = require('./errors');

const TIMEOUT_MS = 5000;

const pasarelaCaida = () => new ApiError({
  status: 503, error: 'La pasarela de pago no responde', code: 'PAYMENT_PROVIDER_UNAVAILABLE',
  action: 'Reintentar la misma solicitud', retryable: true
});

// Cliente HTTP de la pasarela (pagos-mock). Un timeout o un error de red es ambiguo: la pasarela
// pudo haber aceptado el cobro y perder la respuesta (ADR 0010). Por eso todo fallo, sea de red,
// 5xx o cualquier respuesta que no sea 2xx, se informa igual: la compra no se toca y el pago se
// reintenta con la misma Idempotency-Key, que la pasarela trata como idempotente por `compraId`.
async function solicitarCobro({ compraId, monto, escenario, correlationId }, { baseUrl = process.env.PAGOS_URL || 'http://localhost:4000', fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/pagos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}) },
      body: JSON.stringify({ compraId: String(compraId), monto, escenario }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    console.error(`Pasarela: no se pudo solicitar el cobro de la compra ${compraId}: ${error.message}`);
    throw pasarelaCaida();
  }
  if (res.status !== 200 && res.status !== 201) {
    console.error(`Pasarela: respondió ${res.status} al cobro de la compra ${compraId}`);
    throw pasarelaCaida();
  }
  const cuerpo = await res.json().catch(() => null);
  if (!cuerpo || typeof cuerpo.referenciaExterna !== 'string') {
    console.error(`Pasarela: respuesta sin referenciaExterna para la compra ${compraId}`);
    throw pasarelaCaida();
  }
  return { referenciaExterna: cuerpo.referenciaExterna };
}

module.exports = { solicitarCobro };
