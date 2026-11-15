# ADR 0008 — Correlation ID, logs JSON y métricas para el dashboard

- Estado: aceptada (implementada en la Entrega 2)
- Fecha: 2026-10-03, ajustada el 2026-10-15 al implementarla

## Contexto

Hacen falta logs JSON correlacionables y un dashboard con latencia p95, throughput y error rate. Una compra atraviesa la `api`, la pasarela, el webhook, RabbitMQ y el `worker`, así que hay que poder seguirla de punta a punta.

## Decisión

1. **Header `X-Correlation-Id`.** Si llega en la solicitud se respeta (validado: 1 a 128 caracteres `[A-Za-z0-9._:-]`). Si falta o no es válido, la API genera un UUID v4. Se devuelve siempre en la respuesta y se propaga:
   - a la llamada a `pagos-mock`, que lo reenvía en el webhook;
   - al campo `correlationId` del sobre de `entrada.comprada` (el webhook toma el que trae la notificación);
   - a los logs del `worker`, que abre un contexto con el `correlationId` del evento en cada mensaje y uno propio (`barrido-<uuid>`) en cada pasada del barrido.
2. **El correlation id viaja en un contexto, no por parámetro.** El middleware de correlación abre un `AsyncLocalStorage` (`src/lib/contexto.js`) y el logger lo agrega a cada línea con el `mixin` de pino. Así los servicios, que no conocen `req`, escriben logs correlacionados sin cambiar sus firmas. El `mixin` devuelve una copia del contexto: pino mezcla en ese objeto los campos de cada llamada, y sin copiar lo registrado en una línea se filtraría a las siguientes.
3. **Logs JSON con pino** (`src/lib/logger.js`). Una línea por evento, con `level` (texto), `time` ISO, `service` (`api`, `worker` o `pagos-mock`), `msg` y `correlationId`. Nivel configurable con `LOG_LEVEL`. Los módulos que reciben un `log` inyectable usan `comoConsola(logger)`, así los tests siguen pasando el suyo.
4. **Una línea por solicitud** (`src/middleware/observabilidad.js`), escrita al terminar la respuesta: `correlationId`, `method`, `route` (la plantilla `/compras/:id/pagar`, no la URL), `statusCode`, `durationMs`, `sub` (el cliente OAuth) y `code` (el código de error de la API). Nivel `info`, `warn` en 4xx y `error` en 5xx. No se registran cabeceras, cuerpos ni la URL con su query, y el logger redacta `authorization`, `token`, `secret`, `email` y `documento` por si alguien los agrega. El código de una entrada (el contenido del QR) se registra solo por sus últimos 4 caracteres. `/health` y `/metrics` no se registran.
5. **Métricas con `prom-client`**, un registro por proceso:
   - `http_request_duration_seconds{method,route,status_code}`, histograma de la `api`, de donde salen el p95, el throughput y el error rate. La etiqueta `route` es la plantilla (una ruta inexistente es `desconocida`) para que la cardinalidad no crezca con los ids;
   - contadores de negocio: `entradas_vendidas_total` (donde se aplica el pago aprobado, ya sea por el webhook en la `api` o por la conciliación en el `worker`), `entradas_emitidas_total`, `validaciones_total{resultado}` (acceso permitido y cada motivo de rechazo, que cubre los rechazos de acceso), `pagos_fallidos_total{motivo}` (rechazado, expirado o pasarela no disponible);
   - contadores del `worker`: `mensajes_procesados_total{resultado}`, `mensajes_dlq_total{razon}`, `barrido_acciones_total{accion}` y `barrido_errores_total{paso}`;
   - las métricas por defecto del proceso (CPU, memoria, event loop).
   Las series con etiquetas conocidas se publican en cero desde el arranque.
6. **Dónde se exponen.** La `api` en `GET /metrics`; el `worker`, que no tiene API HTTP, en su propio puerto (`METRICS_PORT`, 9464). No están en el contrato OpenAPI y no se autentican, porque las consulta Prometheus dentro de la red de Compose: fuera del uso local hay que restringirlas.
7. **Dashboard:** Prometheus y Grafana como contenedores de Compose, con la configuración y el dashboard provisionados desde `observabilidad/`:
   - p95: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[1m])))`;
   - throughput: `sum(rate(http_request_duration_seconds_count[1m]))`;
   - error rate: proporción de `status_code` 5xx y, aparte, 4xx;
   - además, por ruta, y los paneles de negocio y del worker.
   Un test verifica que cada consulta del dashboard use métricas que existen en el registro, y que Prometheus apunte a los puertos que la `api` y el `worker` exponen.
8. **Opcional con bonus:** OpenTelemetry → Jaeger reutilizando el mismo `correlationId`.

## Consecuencias

- Una operación se sigue con un solo id: `docker compose logs api worker pagos-mock | grep <correlationId>` muestra la solicitud, el webhook, el mensaje y la emisión.
- Suma dos contenedores (`prometheus`, `grafana`) y las dependencias `pino` y `prom-client`.
- Los logs de la aplicación se silencian bajo `node --test` para no mezclarse con el reporte de las pruebas.
- La conciliación y el cierre de eventos del `worker` no pasan por HTTP: se ven en `barrido_acciones_total`, no en el histograma.
- Con el acceso anónimo de Grafana como `Viewer`, el dashboard se ve sin iniciar sesión. Es una decisión de uso local.

## Alternativas descartadas

- **`console.log` de texto libre** (lo que usaba el esqueleto): no se puede consultar ni correlacionar.
- **`pino-http`:** registra la solicitud al empezar y al terminar, con las propiedades calculadas dos veces, y el JSON salía con claves repetidas (`route`, `statusCode`, `correlationId`) y la ruta equivocada en la primera. Un middleware propio de 20 líneas escribe una sola línea con todo lo que se sabe al responder.
- **Pasar el `correlationId` por parámetro a cada función:** ensucia todas las firmas. El contexto asincrónico lo resuelve sin tocarlas.
- **Usar `eventId` como correlación:** identifica un mensaje, no la operación completa que empezó en un request HTTP.
- **Etiquetar las métricas con la URL:** cada id crearía una serie nueva y la cardinalidad crecería sin límite.
- **Servicios SaaS de logs o APM:** dependen de cuentas externas y atentan contra la reproducibilidad local.
