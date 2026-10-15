const { ApiError } = require('./errors');
const { logger } = require('./logger');
const metricas = require('./metricas');

const TIMEOUT_MS = 5000;

const pasarelaCaida = () => {
  metricas.pagosFallidos.inc({ motivo: 'pasarela_no_disponible' });
  return new ApiError({
    status: 503, error: 'La pasarela de pago no responde', code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    action: 'Reintentar la misma solicitud', retryable: true
  });
};

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
    logger.error({ compraId: String(compraId), err: error }, 'Pasarela: no se pudo solicitar el cobro');
    throw pasarelaCaida();
  }
  if (res.status !== 200 && res.status !== 201) {
    logger.error({ compraId: String(compraId), statusCode: res.status }, 'Pasarela: respuesta inesperada al solicitar el cobro');
    throw pasarelaCaida();
  }
  const cuerpo = await res.json().catch(() => null);
  if (!cuerpo || typeof cuerpo.referenciaExterna !== 'string') {
    logger.error({ compraId: String(compraId) }, 'Pasarela: respuesta sin referenciaExterna');
    throw pasarelaCaida();
  }
  return { referenciaExterna: cuerpo.referenciaExterna };
}

const ESTADOS_DE_PAGO = ['pendiente', 'aprobado', 'rechazado'];

// Consulta el estado de un pago a la pasarela para conciliar una compra cuyo webhook no llegó
// (ADR 0010). Devuelve `{ estado, referenciaExterna, motivo? }`, o `null` si la pasarela dice que
// no conoce ese pago. Cualquier otra cosa (red, 5xx, respuesta inesperada) lanza: expirar una
// compra porque la pasarela no respondió dejaría plata cobrada sin entrada, así que ante la duda
// no se concluye nada y se vuelve a consultar en el próximo barrido.
async function consultarPago(compraId, { baseUrl = process.env.PAGOS_URL || 'http://localhost:4000', fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/pagos?compraId=${encodeURIComponent(String(compraId))}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`No se pudo consultar el pago de la compra ${compraId}: ${error.message}`);
  }
  const cuerpo = await res.json().catch(() => null);
  // Un 404 solo vale como "no la conozco" si lo dice la pasarela: otro servicio o una ruta
  // equivocada también responden 404 y no deben expirar compras.
  if (res.status === 404 && cuerpo?.code === 'PAYMENT_NOT_FOUND') return null;
  if (res.status !== 200 || !ESTADOS_DE_PAGO.includes(cuerpo?.estado) || typeof cuerpo.referenciaExterna !== 'string') {
    throw new Error(`Respuesta inesperada de la pasarela al consultar la compra ${compraId}: ${res.status}`);
  }
  return { estado: cuerpo.estado, referenciaExterna: cuerpo.referenciaExterna, motivo: cuerpo.motivo };
}

module.exports = { solicitarCobro, consultarPago };
