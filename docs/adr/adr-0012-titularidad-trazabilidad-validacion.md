# ADR 0012 — Titularidad y trazabilidad: `creadaPor`, asistente como snapshot y validación por evento

- Estado: aceptada
- Fecha: 2026-10-05

## Contexto

Con `client_credentials` no hay usuario final: el token identifica a una aplicación. La revisión del diseño encontró cuatro problemas relacionados:

1. El README decía que las compras se asocian al cliente M2M, pero ningún modelo guardaba el `sub`. Cualquier cliente con `buy:entradas` listaba y operaba **todas** las compras.
2. `idempotencyKey` era única de forma **global**: un cliente que usara la clave de otro recibía como "replay" una compra ajena.
3. El asistente se reutilizaba por DNI. Si el mismo DNI llegaba con otro nombre o email, había que elegir entre pisar los datos (cambiando retroactivamente el titular de compras y entradas viejas, y permitiendo que un cliente modifique el email de otra persona) o rechazar la compra.
4. `POST /entradas/{codigo}/validar` solo recibía el código: una entrada del evento A entraba por la puerta del evento B.

## Decisión

1. **`Compra.creadaPor`** = `sub` del token. `GET /compras` devuelve solo las compras del cliente autenticado. `GET /compras/{id}`, `/pagar`, `/cancelar` y `/entradas` sobre una compra ajena responden `404 PURCHASE_NOT_FOUND` (no 403, para no revelar que existe). No es "mis compras" por persona: sigue sin haber usuario final, solo cliente.
2. **Idempotencia por cliente.** Los índices únicos pasan a `{ creadaPor, idempotencyKey }` y `{ creadaPor, pago.idempotencyKey }` (parcial). Dos clientes pueden usar la misma clave sin interferir. La migración `20261005120000-creada-por-e-idempotencia-por-cliente.js` reemplaza los índices globales.
3. **Asistente como snapshot.**
   - `Compra.asistente { nombre, email, documento }` es una copia de lo informado al comprar, igual que `precioUnitario`: el historial no cambia.
   - La colección `asistentes` sigue deduplicando por `documento` y conserva **los últimos datos informados** (`$set` en cada compra). Es un directorio actual, no una fuente de historial.
   - `Entrada.titular { nombre, documento }` se copia al emitir (el `worker` lo lee del snapshot de la compra). En la puerta se ve el titular sin join y sin exponer el email.
4. **`Entrada.validadaPor`** = `sub` del cliente de control de acceso, escrito junto con `usadaEn` en la misma transición atómica.
5. **`POST /entradas/{codigo}/validar` recibe `{ eventoId }`** (el evento de la puerta). Orden de las comprobaciones:
   1. entrada inexistente → `404 TICKET_NOT_FOUND`;
   2. `entrada.eventoId ≠ eventoId` → `409 TICKET_WRONG_EVENT`;
   3. evento que no está `publicado` → `409 EVENT_NOT_ACTIVE`;
   4. `findOneAndUpdate({ codigo, estado: 'emitida' }, { estado: 'usada', usadaEn, validadaPor })`; si no encuentra, `409 TICKET_ALREADY_USED` o `409 TICKET_VOIDED` según el estado actual.
6. **Documento de identidad.** `documento` es un DNI de 7 u 8 dígitos. Es una limitación declarada: no admite pasaportes ni documentos extranjeros. Ampliarlo exigiría un `tipoDocumento`.

## Consecuencias

- Un cliente solo ve y opera sus compras, y puede reutilizar claves de idempotencia sin colisionar con otros.
- Cambiar nombre o email de un DNI no altera compras ni entradas ya emitidas, y un cliente no puede pisar datos que otro informó antes en el historial.
- Cada compra y cada entrada ocupan algunos bytes más por la copia. Es el mismo trade-off que `precioUnitario`.
- Auditoría básica: se sabe qué cliente creó cada compra y cuál validó cada entrada.
- Los clientes de control de acceso tienen que conocer su `eventoId`. Es una exigencia razonable: una puerta pertenece a un evento.
- El reporte `x-api-key` sigue viendo todo: es una vista interna, sin identidad.

## Alternativas descartadas

- **Gana el último dato sobre el Asistente, sin snapshot:** es lo más simple, pero reescribe el historial y deja pisar el email de otra persona.
- **Rechazar con 409 si el DNI llega con otros datos:** bloquea cambios legítimos (un email nuevo) y obliga a un trámite que la API no tiene.
- **Guardar el email en la entrada:** el control de acceso no lo necesita; menos datos personales en el camino de la puerta.
- **Un claim de Auth0 con el `eventoId` permitido** para limitar cada puerta: Auth0 M2M otorga scopes por API, no por recurso, y complicaría la configuración.
- **Dejar `GET /compras` sin filtro por cliente:** expone todas las compras, con los datos de los asistentes, a cualquier cliente con `buy:entradas`.
