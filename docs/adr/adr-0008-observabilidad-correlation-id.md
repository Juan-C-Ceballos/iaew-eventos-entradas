# ADR 0008 — Correlation ID, logs JSON y métricas para el dashboard

- Estado: propuesta (se confirma al implementarla en la Entrega 2)
- Fecha: 2026-10-03

## Contexto

La Entrega 2 exige logs JSON, un dashboard con latencia p95, throughput y error rate, y logs correlacionables mediante correlation ID. Una compra atraviesa la `api`, la pasarela, el webhook, RabbitMQ y el `worker`, así que hace falta seguirla de punta a punta. Aunque se implemente en la Entrega 2, conviene decidirlo ahora para que el contrato y el sobre del evento ya lo contemplen.

## Decisión (propuesta)

1. **Header `X-Correlation-Id`.** Si llega en la solicitud se respeta (validado: 1 a 128 caracteres `[A-Za-z0-9._:-]`). Si no, la API genera un UUID v4. Se devuelve siempre en la respuesta y se propaga:
   - a la llamada a `pagos-mock`, que lo reenvía en el webhook;
   - al campo `correlationId` del sobre de `entrada.comprada` (ya está en el contrato v1);
   - a los logs del `worker`.
2. **Logs JSON con pino** (`pino-http` en la `api`). Una línea por request con `correlationId`, `method`, `route`, `statusCode`, `durationMs`, `sub` (cliente OAuth) y `code` de error. Nunca tokens, secretos ni datos personales completos.
3. **Métricas con `prom-client`** expuestas en `GET /metrics`:
   - histograma `http_request_duration_seconds{method,route,status_code}` para p95 y throughput;
   - contadores de dominio: `entradas_vendidas_total`, `validaciones_total{resultado}`, `pagos_fallidos_total` y `rechazos_acceso_total`.
4. **Dashboard:** Prometheus + Grafana como contenedores nuevos en Compose, con el dashboard provisionado desde el repo:
   - p95: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))`;
   - throughput: `sum(rate(http_request_duration_seconds_count[1m]))`;
   - error rate: proporción de `status_code` 5xx (y, aparte, 4xx).
5. **Opcional con bonus:** OpenTelemetry → Jaeger reutilizando el mismo `correlationId`.

## Consecuencias

- El contrato y el evento ya prevén la correlación, así que la Entrega 2 no rompe compatibilidad.
- Suma dos contenedores y la dependencia de pino y prom-client.
- Si al implementarlo conviene otra convención (por ejemplo, `x-request-id` u otra herramienta), este ADR se reemplaza por uno nuevo y se ajusta el header. El campo `correlationId` del evento se mantiene.

## Alternativas descartadas

- **`console.log` de texto libre** (lo que usa hoy el esqueleto): no se puede consultar ni correlacionar.
- **Usar `eventId` como correlación:** identifica un mensaje, no la operación completa que empezó en un request HTTP.
- **Servicios SaaS de logs o APM:** dependen de cuentas externas y atentan contra la reproducibilidad local.
