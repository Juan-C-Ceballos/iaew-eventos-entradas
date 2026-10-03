# ADR 0007 — Reserva de cupo atómica e Idempotency-Key en la compra

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

Dos errores del dominio son críticos: **evento agotado**, que no puede terminar en sobreventa con compras concurrentes, y **compra duplicada**, que no debe ocurrir si el cliente reintenta porque perdió la respuesta. Leer el cupo, verificarlo y después descontarlo en pasos separados es una condición de carrera clásica.

## Decisión

1. **Reserva atómica condicional** en un único documento:
   ```js
   Evento.findOneAndUpdate(
     { _id: eventoId, estado: 'publicado', cupoDisponible: { $gte: cantidad } },
     { $inc: { cupoDisponible: -cantidad } },
     { new: true }
   )
   ```
   Si devuelve `null`, se distingue entre inexistente (404), no publicado (409 `EVENT_NOT_PUBLISHED`) y sin cupo (409 `EVENT_SOLD_OUT`) con una lectura posterior.
2. **Compensación:** si falla la creación de la compra después de reservar, se devuelve el cupo (`$inc: +cantidad`). Las liberaciones (cancelación, rechazo, expiración) también son `$inc` positivos y siempre van atadas a una transición de estado condicional, para no liberar dos veces.
3. **Vencimiento de la reserva:** `reservaExpiraEn = ahora + RESERVA_TTL_MINUTOS` (configurable por entorno, 15 por defecto). Se fija al crear la compra, así que cambiar la variable no altera las reservas existentes. Se controla de forma perezosa en `/pagar` (vencida → `expirada` + liberación) y con un barrido periódico en el worker sobre el índice `{ estado, reservaExpiraEn }`.
4. **`Idempotency-Key` obligatoria** en `POST /compras` y `POST /compras/{id}/pagar`: entre 8 y 128 caracteres de `[A-Za-z0-9._:-]`. Se guarda con un índice único y la huella SHA-256 del cuerpo.
   - Misma clave y mismo cuerpo: devuelve el resultado original con `Idempotency-Replayed: true`, sin volver a reservar ni a cobrar.
   - Misma clave con otro cuerpo: 409 `IDEMPOTENCY_KEY_MISMATCH`.
   - Clave ausente o inválida: 400 `IDEMPOTENCY_KEY_REQUIRED` o `IDEMPOTENCY_KEY_INVALID`.
   - El índice único resuelve la carrera entre dos requests simultáneos con la misma clave: el segundo recibe E11000 y responde con un replay.
5. **Transiciones de estado** como `findOneAndUpdate({ _id, estado: <origen> }, ...)`. Solo una solicitud concurrente gana.

## Consecuencias

- No hay sobreventa sin transacciones multi-documento ni locks: MongoDB garantiza la atomicidad por documento.
- El cupo es un contador desnormalizado: el invariante (capacidad − cupo = reservadas + vendidas) depende de que todas las liberaciones pasen por transiciones condicionales. El reporte de ventas permite auditarlo.
- Un cliente que pierde la respuesta puede reintentar sin miedo, siempre que conserve la clave.
- Las reservas abandonadas bloquean cupo hasta que vence `RESERVA_TTL_MINUTOS`. Un valor bajo libera cupo antes, pero deja menos tiempo para pagar.

## Alternativas descartadas

- **Leer y después actualizar** (`find` + `save`): tiene una condición de carrera que provoca sobreventa.
- **Transacción multi-documento:** requiere replica set y no es necesaria.
- **Contar entradas vendidas en cada compra** (agregación): es más lento y también tiene carreras.
- **Usar el token o el `sub` como clave de idempotencia:** un mismo cliente hace muchas compras distintas, y mezclar seguridad con identidad de negocio expone información sensible.
