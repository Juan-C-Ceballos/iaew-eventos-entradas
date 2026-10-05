# ADR 0010 — Ciclo de vida de la compra: orden de `/pagar`, timeout de pago, conciliación y reconciliación de cupo

- Estado: aceptada
- Fecha: 2026-10-05

## Contexto

El [ADR 0007](adr-0007-reserva-cupo-idempotencia.md) resuelve la reserva atómica y la idempotencia, pero la revisión del flujo completo encontró tres huecos:

1. **Carrera entre `/pagar` y el webhook.** Si la API llama a la pasarela y *después* pasa la compra a `pago_pendiente`, un webhook rápido encuentra la compra todavía en `pendiente` y falla.
2. **`pago_pendiente` sin salida.** Si el webhook no llega (pasarela caída, notificación perdida), la compra queda trabada reteniendo cupo. Expirarla sin preguntar es peor: si el `aprobado` llega tarde, hay plata cobrada sin entrada.
3. **El cupo es un contador desnormalizado.** La compensación del ADR 0007 solo cubre excepciones. Si el proceso muere entre descontar el cupo y crear la compra, el cupo se pierde y nada lo repone.

## Decisión

1. **Orden de `/pagar`: primero se persiste, después se llama a la pasarela.**
   1. `findOneAndUpdate({ _id, estado: 'pendiente', reservaExpiraEn: { $gt: ahora } })` pasa la compra a `pago_pendiente`, guarda `pago { estado: pendiente, idempotencyKey, solicitadoEn }` y fija `pagoExpiraEn = ahora + PAGO_TIMEOUT_MINUTOS` (30 por defecto).
   2. `POST /pagos` a la pasarela con `compraId`, `monto`, `escenario` y la `Idempotency-Key` del pago. La pasarela es idempotente por `compraId`.
   3. Se guarda `pago.referenciaExterna` con la que devolvió la pasarela.

   El webhook correlaciona por `data.compraId`, no por `referenciaExterna`: si llega antes del paso 3, se procesa igual y guarda la referencia que trae.

2. **Si la pasarela no responde, la compra no vuelve a `pendiente`.** Un timeout es ambiguo (la pasarela pudo aceptar el cobro y perder la respuesta), así que devolver la compra a `pendiente` permitiría un doble cobro. Se responde `503 PAYMENT_PROVIDER_UNAVAILABLE` y la compra queda en `pago_pendiente`. Reintentar `/pagar` sobre una compra en `pago_pendiente`:
   - misma `Idempotency-Key` y sin `referenciaExterna`: se vuelve a enviar el cobro (seguro, la pasarela es idempotente);
   - misma clave y con `referenciaExterna`: se devuelve el 202 original con `Idempotency-Replayed: true`;
   - otra clave: `409 PURCHASE_INVALID_STATE`.

3. **Conciliación de pagos vencidos** (barrido del `worker`). Para cada compra `pago_pendiente` con `pagoExpiraEn` vencido se consulta `GET /pagos?compraId=…` a la pasarela:

   | Respuesta de la pasarela | Resultado |
   |---|---|
   | `aprobado` | Mismo camino que el webhook: `pagada` + `emisionEvento` en una sola escritura |
   | `rechazado` | `rechazada` y se libera el cupo |
   | 404 (no la conoce) | `expirada` y se libera el cupo |
   | `pendiente` o la pasarela no responde | No se toca: se vuelve a consultar en el próximo barrido |

   Toda transición es un `findOneAndUpdate` condicionado a `estado: 'pago_pendiente'`, así que el barrido y un webhook tardío compiten sin doble efecto. Un webhook `aprobado` sobre una compra ya `expirada`, `rechazada` o `cancelada` responde `409`, marca `reembolsoPendiente: true` y registra un error en el log. Es el único caso residual (la pasarela dijo "no la conozco" y después cobró) y queda documentado como limitación.

4. **Vencimiento de reservas.** El barrido pasa a `expirada` (y libera el cupo, de forma condicional) las compras `pendiente` con `reservaExpiraEn` vencido. `/pagar` hace el mismo control de forma perezosa.

5. **Reconciliación de cupo.** Por cada evento `publicado`, el barrido calcula `esperado = capacidad − Σ cantidad` de las compras en `pendiente`, `pago_pendiente` y `pagada`. Si `cupoDisponible` difiere, **solo se corrige cuando la diferencia se repite en dos barridos consecutivos** (una reserva en curso produce una diferencia de milisegundos, no de minutos), con un update condicionado al valor observado (`{ _id, cupoDisponible: observado }`) y un log de error `cupo_reconciliado`.

6. **Configuración:** `PAGO_TIMEOUT_MINUTOS` (30), `BARRIDO_INTERVALO_MS` (60000). El barrido corre en el `worker`; con más de una réplica, las transiciones condicionales hacen inofensivas las ejecuciones simultáneas.

7. **`pagos-mock`:** `POST /pagos` idempotente por `compraId` y `GET /pagos?compraId=` para consultar. Guarda el estado en memoria: si se reinicia, responde 404 y la compra termina `expirada`. Es aceptable para una pasarela simulada.

## Consecuencias

- Ningún pago queda sin resolver: aprobado, rechazado o expirado, siempre hay una salida con una sola fuente de verdad (la pasarela).
- Una caída de la pasarela retiene cupo hasta `PAGO_TIMEOUT_MINUTOS` (más que los 15 minutos de la reserva). Es el costo de no devolver la compra a `pendiente`.
- El `worker` pasa a tener más responsabilidades (consumir, barrer, consultar la pasarela). Está reflejado en el [C4 de componentes](../c4-component.md).
- El invariante `capacidad − cupoDisponible = reservadas + vendidas` deja de ser una esperanza: hay un proceso que lo vigila.
- Cada pasada consulta MongoDB; los índices `{ estado, reservaExpiraEn }` y `{ estado, pagoExpiraEn }` la mantienen barata.

## Alternativas descartadas

- **Volver a `pendiente` si falla la llamada a la pasarela:** con un timeout ambiguo permite un doble cobro.
- **Expirar `pago_pendiente` sin consultar a la pasarela:** un `aprobado` tardío deja plata cobrada sin entrada y obliga a inventar un reembolso.
- **Llamar a la pasarela primero y persistir después** (el diseño original): el webhook puede llegar antes que la transición a `pago_pendiente`.
- **Índice TTL de MongoDB para expirar compras:** borra documentos en vez de cambiar su estado y no libera cupo.
- **Transacción multi-documento para reservar y crear la compra:** elimina la fuga de cupo pero exige replica set ([ADR 0003](adr-0003-mongodb-migraciones-seed.md)); el reconciliador logra el mismo efecto sin cambiar la infraestructura.
