# ADR 0001 — Estilo de API: REST por recursos con errores uniformes

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

La API la consumen tres tipos de cliente (canal de venta, organizador y control de acceso) más una pasarela de pago. Necesitamos que cualquier integrante y el corrector puedan predecir rutas, métodos, códigos HTTP y errores leyendo solo el contrato. El dominio tiene operaciones que no son CRUD puro: pagar, cancelar y validar. Además, el flujo de compra tiene pasos asincrónicos y los clientes pueden reintentar.

## Decisión

1. **Recursos en plural y en español:** `/eventos`, `/compras`, `/entradas`. Campos en camelCase en español (`cupoDisponible`, `reservaExpiraEn`). Estados como strings en minúscula (`pendiente`, `pagada`).
2. **CRUD con verbos HTTP:** `GET` lista o lee, `POST` crea (201), `PATCH` actualiza parcialmente (200), `DELETE` elimina (204).
3. **Acciones de negocio como sub-recurso con `POST`:** `/compras/{id}/pagar`, `/compras/{id}/cancelar`, `/eventos/{id}/cancelar`, `/entradas/{codigo}/validar`. No se usa un `PATCH` genérico de estado, porque cada acción tiene precondiciones y efectos propios.
4. **Sin versión en la URL.** La versión del contrato vive en `info.version` de OpenAPI y la de los eventos en el campo `version`. Un cambio incompatible futuro se resolvería con un nuevo recurso o un header de versión, y quedaría registrado en un ADR nuevo.
5. **Códigos HTTP:**

   | Código | Uso |
   |---|---|
   | 200 | Lectura o acción completada |
   | 201 | Creación |
   | 202 | Pago solicitado; el resultado llega por webhook |
   | 204 | Borrado |
   | 400 | Validación, JSON inválido, id inválido, Idempotency-Key ausente o inválida |
   | 401 | Token o api key ausente o inválida, o firma de webhook inválida |
   | 403 | Falta el scope |
   | 404 | Recurso inexistente |
   | 409 | Conflicto de estado o de negocio (agotado, ya usada, clave reutilizada) |
   | 500 | Error interno o configuración faltante del servidor (`INTERNAL_ERROR`, `API_KEY_NOT_CONFIGURED`) |
   | 503 | Dependencia caída con estado persistido y reintento posible |
6. **Formato de error único:** `{ error, code, retryable, action, details? }` con `application/json`. `code` es estable y está en UPPER_SNAKE_CASE en inglés. Catálogo inicial: `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_ID`, `TOKEN_INVALID`, `SCOPE_REQUIRED`, `API_KEY_INVALID`, `API_KEY_NOT_CONFIGURED`, `EVENT_NOT_FOUND`, `EVENT_NOT_PUBLISHED`, `EVENT_ALREADY_STARTED`, `EVENT_SOLD_OUT`, `EVENT_HAS_SALES`, `CAPACITY_BELOW_SOLD`, `INVALID_STATE_TRANSITION`, `PURCHASE_NOT_FOUND`, `PURCHASE_INVALID_STATE`, `RESERVATION_EXPIRED`, `PAYMENT_PROVIDER_UNAVAILABLE`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_MISMATCH`, `TICKET_NOT_FOUND`, `TICKET_ALREADY_USED`, `TICKET_VOIDED`, `TICKET_WRONG_EVENT`, `EVENT_NOT_ACTIVE`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_TIMESTAMP_EXPIRED`, `DATABASE_UNAVAILABLE`, `NOT_IMPLEMENTED`, `ROUTE_NOT_FOUND`, `INTERNAL_ERROR`.
7. **Listados sin paginación en v1.** Devuelven el array completo ordenado, con filtros por query (`estado`, `eventoId`). El volumen de la demo lo permite. Si se agrega paginación, será con `limit`/`offset` como cambio aditivo.
8. **CRUD de la entidad Compras como máquina de estados.** La consigna pide CRUD sobre dos entidades. Eventos tiene los cuatro verbos HTTP. Compras es un registro con ciclo de vida, no un recurso editable: tiene sus cuatro operaciones, pero expresadas como transiciones.

   | Operación | Endpoint | Por qué no es el verbo genérico |
   |---|---|---|
   | Create | `POST /compras` | Reserva el cupo de forma atómica |
   | Read | `GET /compras`, `GET /compras/{id}`, `GET /compras/{id}/entradas` | Solo las compras propias del cliente ([ADR 0012](adr-0012-titularidad-trazabilidad-validacion.md)) |
   | Update | `POST /compras/{id}/pagar` (y el webhook) | Un `PATCH` libre dejaría al cliente forzar estados; cada transición tiene precondiciones |
   | Delete | `POST /compras/{id}/cancelar` | Baja lógica: la compra se conserva como registro auditable y las entradas la referencian. Libera el cupo |

9. **Contrato primero:** `docs/openapi.json` es la fuente de verdad, se publica en `/api-docs` y la app responde 501 en las operaciones documentadas que todavía no están implementadas.

## Consecuencias

- Los clientes distinguen errores por `code` y deciden si reintentar con `retryable`, sin parsear mensajes.
- Las acciones como sub-recurso dejan precondiciones explícitas y se documentan por separado en OpenAPI.
- No usar `application/problem+json` (RFC 9457) nos aleja de un estándar, a cambio de dos campos que el cliente necesita para decidir: `retryable` y `action`.
- Sin paginación, un listado grande sería costoso. Se acepta para el alcance del TPI.

## Alternativas descartadas

- `/api/v1` en la ruta: duplica la versión que ya está en el contrato y obliga a cambiar todas las URLs ante cualquier versión nueva.
- `PATCH /compras/{id}` con `{ estado: 'pagada' }`: oculta precondiciones y deja que el cliente fuerce transiciones.
- `application/problem+json`: válido, pero no trae de forma estándar los campos `retryable` y `action`, que habría que agregar como extensiones.
