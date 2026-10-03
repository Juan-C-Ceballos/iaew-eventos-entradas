# Architecture Decision Records

Formato liviano (Michael Nygard): Estado, Fecha, Contexto, Decisión, Consecuencias y Alternativas descartadas. Un ADR reemplazado no se borra: se marca como `reemplazada por ADR NNNN`.

| ADR | Decisión | Estado |
|---|---|---|
| [0001](adr-0001-estilo-api-rest.md) | Estilo de API: REST por recursos, acciones como sub-recurso, sin versión en la URL, formato de error uniforme | aceptada |
| [0002](adr-0002-rest-vs-grpc.md) | REST/HTTP+JSON para la API pública; gRPC descartado | aceptada |
| [0003](adr-0003-mongodb-migraciones-seed.md) | MongoDB + Mongoose, migraciones con migrate-mongo y seed idempotente | aceptada |
| [0004](adr-0004-seguridad-auth0-scopes.md) | Auth0 con client_credentials, 5 scopes, 401/403 y x-api-key como comparación | aceptada |
| [0005](adr-0005-broker-rabbitmq.md) | RabbitMQ para `entrada.comprada`, con at-least-once, retry con TTL, DLQ y deduplicación | aceptada |
| [0006](adr-0006-webhook-pago-hmac.md) | Integración adicional: webhook de pago firmado con HMAC-SHA256 | aceptada |
| [0007](adr-0007-reserva-cupo-idempotencia.md) | Reserva de cupo con update atómico condicional, más Idempotency-Key | aceptada |
| [0008](adr-0008-observabilidad-correlation-id.md) | Correlation ID, logs JSON y métricas para el dashboard | propuesta |
| [0009](adr-0009-outbox-entrada-comprada.md) | Patrón outbox para publicar `entrada.comprada` | aceptada |
