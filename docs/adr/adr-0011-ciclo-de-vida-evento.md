# ADR 0011 — Ciclo de vida del evento: estados, fechas, cierre automático y cancelación

- Estado: aceptada
- Fecha: 2026-10-05

## Contexto

El modelo declaraba los estados `borrador`, `publicado`, `cancelado` y `finalizado`, pero la revisión encontró cabos sueltos:

- Nadie pasaba un evento a `finalizado`, y un evento con fecha pasada seguía vendiendo.
- No estaba definido qué ocurre con las compras y las entradas cuando se cancela un evento con ventas.
- La cancelación se hacía con `PATCH { estado: cancelado }`, lo contrario de lo que dice el [ADR 0001](adr-0001-estilo-api-rest.md) para las acciones con precondiciones y efectos propios.
- Las fechas del seed eran fijas: pasada esa fecha, la demo dejaba de poder vender.

## Decisión

1. **Estados y transiciones** (los únicos válidos):

   | Desde | Hacia | Cómo |
   |---|---|---|
   | `borrador` | `publicado` | `PATCH { estado: publicado }` (exige fecha futura) |
   | `publicado` | `finalizado` | automático (punto 3) o `PATCH { estado: finalizado }` |
   | `publicado` | `cancelado` | `POST /eventos/{id}/cancelar` (punto 4) |

   `cancelado` y `finalizado` son terminales. El `PATCH` ya no acepta `estado: cancelado`. Un evento sin compras se puede eliminar (`DELETE`, `EVENT_HAS_SALES` si tiene).

2. **Fechas.** `fecha` es el inicio del evento. Crear o modificar un evento, o publicarlo, con `fecha` pasada responde `400 VALIDATION_ERROR`. La reserva de cupo agrega `fecha: { $gt: ahora }` al filtro atómico del [ADR 0007](adr-0007-reserva-cupo-idempotencia.md); si no hay resultado, se distingue en este orden: inexistente (404), no publicado (`EVENT_NOT_PUBLISHED`), ya comenzó (`EVENT_ALREADY_STARTED`) y sin cupo (`EVENT_SOLD_OUT`).

3. **Cierre automático.** El barrido del `worker` pasa a `finalizado` los eventos `publicado` cuya `fecha` superó `EVENTO_FINALIZA_TRAS_HORAS` (12 por defecto). Es un estado persistido y no calculado al leer, así que `GET /eventos?estado=` es siempre veraz. Durante esas horas el evento sigue `publicado`: la validación en la puerta funciona después del inicio.

4. **Cancelación: `POST /eventos/{id}/cancelar`** (scope `write:eventos`). Pasa el evento de `publicado` a `cancelado` con un update condicional, lo que **corta las ventas al instante**. Cancelar un evento ya cancelado devuelve el evento (idempotente); desde `borrador` o `finalizado` responde `409 INVALID_STATE_TRANSITION`. La cascada sobre compras y entradas es idempotente, la dispara la API a continuación y la retoma el barrido mientras `cancelacionProcesadaEn` esté vacío:

   | Elemento | Tratamiento |
   |---|---|
   | Compra `pendiente` | → `cancelada` (sin liberar cupo: el evento ya no vende) |
   | Compra `pago_pendiente` | No se toca; la resuelven el webhook o la conciliación ([ADR 0010](adr-0010-ciclo-de-vida-compra-pago-conciliacion.md)). Si el pago se aprueba, la compra queda `pagada` con `reembolsoPendiente: true` |
   | Compra `pagada` | `reembolsoPendiente: true` |
   | Entrada `emitida` | → `anulada` |
   | Entrada `usada` | No se toca |
   | Emisión en curso (`pagada` sin entradas todavía) | El worker emite las entradas ya `anulada` si el evento está cancelado |

   `cancelacionProcesadaEn` se completa cuando no quedan compras `pendiente` ni `pago_pendiente`, ni entradas `emitida`, ni emisiones pendientes. Aunque una entrada `emitida` quedara rezagada, `POST /entradas/{codigo}/validar` rechaza cualquier entrada de un evento no `publicado` (`EVENT_NOT_ACTIVE`).

5. **No hay reembolsos.** `reembolsoPendiente` es una marca para que alguien los gestione; queda como limitación declarada.

6. **Seed con fechas relativas.** Los eventos de demostración se crean con fecha a 45, 52 y 65 días de la primera ejecución del seed, para que la demo siga pudiendo vender cuando se corrija o se presente.

## Consecuencias

- Las ventas se detienen en el mismo instante de la cancelación, aunque la cascada tarde segundos.
- La cascada no necesita transacciones: cada paso es un update condicional y se puede repetir sin efectos dobles.
- Un cliente que pagó un evento cancelado ve su compra `pagada` con `reembolsoPendiente: true` y entradas `anuladas`: el dato queda, el dinero no se devuelve solo.
- Hay una operación más en el contrato y la API de eventos deja de aceptar `cancelado` en el `PATCH`.

## Alternativas descartadas

- **`PATCH { estado: cancelado }`:** oculta los efectos de la cancelación y contradice el criterio del ADR 0001.
- **Calcular `finalizado` al leer:** no necesita barrido, pero los filtros por estado devuelven datos falsos.
- **Cancelar compras `pago_pendiente` junto con el evento:** si el pago ya estaba en la pasarela, un `aprobado` posterior dejaría plata cobrada sin ningún rastro.
- **Transacción multi-documento para la cascada:** exige replica set ([ADR 0003](adr-0003-mongodb-migraciones-seed.md)) y no es necesaria con pasos idempotentes.
- **Fechas fijas en el seed:** la demo se rompe sola cuando pasa la fecha.
