# ADR 0006 — Integración adicional: webhook de pago firmado con HMAC

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

La consigna pide una integración adicional entre tres opciones: webhook con firma o secreto compartido, gRPC con proto/stub, o WebSocket con stream. Para este dominio, las opciones naturales son webhook de pago, WebSocket de control de acceso o gRPC a un validador. El flujo multi-paso incluye "simular pago" y el error "pago rechazado". Las pasarelas reales informan el resultado del cobro de forma asincrónica mediante webhooks.

## Decisión

1. **Webhook de pago.** El contenedor `pagos-mock` simula la pasarela. `POST /compras/{id}/pagar` le pide el cobro y responde 202. Después, la pasarela llama a `POST /webhooks/pagos` con `pago.aprobado` o `pago.rechazado`.
2. **Firma:** `X-Pago-Firma: sha256=<hex>`, donde `hex = HMAC-SHA256(WEBHOOK_SECRET, "<X-Pago-Timestamp>.<cuerpo crudo>")`. La API:
   - calcula la firma sobre el **cuerpo crudo**, no sobre el JSON re-serializado;
   - compara con `crypto.timingSafeEqual`;
   - rechaza un timestamp fuera de ±`WEBHOOK_TOLERANCIA_SEGUNDOS` (300 s) para evitar replays;
   - responde 401 `WEBHOOK_SIGNATURE_INVALID` o `WEBHOOK_TIMESTAMP_EXPIRED`.
3. **Idempotencia por estado.** La transición `pago_pendiente → pagada|rechazada` es condicional. Una notificación repetida responde 200 con `duplicado: true`, sin efectos. Una notificación contradictoria (por ejemplo, `rechazado` sobre una compra `pagada`) responde 409.
4. **El webhook no publica en RabbitMQ.** Persiste el resultado, con el evento a publicar, en una sola escritura, y responde 200. La publicación la hace el relay del outbox ([ADR 0009](adr-0009-outbox-entrada-comprada.md)), así que una caída del broker no afecta a la pasarela.
5. **Reintentos de la pasarela:** ante 5xx o timeout, `pagos-mock` reintenta con backoff. La API solo responde 503 si MongoDB no está disponible y no pudo persistir el resultado.
6. **Escenario de demo:** el cuerpo de `/pagar` acepta `escenario: aprobado|rechazado` para forzar el resultado. No se envían ni se guardan datos de tarjeta.
7. **El webhook se protege con la firma HMAC en lugar de OAuth.** Quien llama es un tercero (la pasarela) que no obtiene tokens de nuestro Auth0. Por eso queda fuera del esquema de scopes y se documenta en OpenAPI con un esquema de seguridad propio (`webhookFirma`).

## Consecuencias

- La integración participa en el flujo principal: sin webhook no hay compra pagada ni emisión. Esto le da peso en la demo.
- Cubre el error "pago rechazado" (libera el cupo) y la resiliencia (reintentos más idempotencia).
- El secreto es compartido: hay que rotarlo en los dos extremos. Se acepta para el TPI.
- Hay que tener cuidado de que `express.json()` no consuma el cuerpo antes de verificar la firma. Se usa `express.raw()` en esa ruta, o el `verify` de `express.json` para conservar el buffer.

## Alternativas descartadas

- **WebSocket de control de acceso:** es vistoso, pero necesita un cliente o panel adicional y no participa en el flujo de compra.
- **gRPC a un validador:** suma un `.proto`, stubs y otro contenedor por una sola operación ([ADR 0002](adr-0002-rest-vs-grpc.md)).
- **Pago sincrónico dentro de `/pagar`:** es más simple, pero no tiene integración adicional ni refleja cómo funcionan las pasarelas reales.
- **Secreto en query string o header fijo sin firma:** se puede reenviar (replay) y no protege la integridad del cuerpo.
