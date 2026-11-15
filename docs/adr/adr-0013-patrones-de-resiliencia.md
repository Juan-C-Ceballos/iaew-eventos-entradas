# ADR 0013 — Patrones de resiliencia: qué falla, qué patrón lo cubre y por qué no hay circuit breaker

- Estado: aceptada
- Fecha: 2026-10-17

## Contexto

El sistema depende de cuatro cosas que pueden fallar en cualquier momento: MongoDB, RabbitMQ, la pasarela de pago (un tercero) y sus propios procesos (`api` y `worker`). En este dominio una falla no puede traducirse en una compra perdida, en un cobro doble ni en una entrada que no se emite. Los ADR [0005](adr-0005-broker-rabbitmq.md), [0006](adr-0006-webhook-pago-hmac.md), [0007](adr-0007-reserva-cupo-idempotencia.md), [0009](adr-0009-outbox-entrada-comprada.md) y [0010](adr-0010-ciclo-de-vida-compra-pago-conciliacion.md) toman cada una de esas decisiones por separado. Este ADR las junta en un mapa de conjunto para poder responder, falla por falla, qué patrón de resiliencia la cubre y cómo se comprueba.

## Decisión

Cada falla tiene un patrón, está implementado y tiene una prueba que lo ejercita:

| Falla | Patrón | Dónde está | Cómo se prueba |
|---|---|---|---|
| El cliente reintenta una compra o un pago (perdió la respuesta) | **Idempotencia** con `Idempotency-Key` | [`idempotencia.js`](../../src/lib/idempotencia.js), [ADR 0007](adr-0007-reserva-cupo-idempotencia.md) | [`compras.db.test.js`](../../test/compras.db.test.js): 10 solicitudes simultáneas con la misma clave crean una sola compra |
| Cae RabbitMQ, o la API, entre cobrar y publicar | **Transactional outbox** | [`outbox.js`](../../src/lib/outbox.js), [ADR 0009](adr-0009-outbox-entrada-comprada.md) | [`worker.rabbit.test.js`](../../test/worker.rabbit.test.js): con el broker caído la compra queda pendiente de publicar y se publica sola al volver |
| El worker falla al procesar un mensaje | **Retry con espera + Dead Letter Queue**, con consumidor idempotente | [`consumidor.js`](../../src/lib/consumidor.js), [`rabbit.js`](../../src/lib/rabbit.js), [ADR 0005](adr-0005-broker-rabbitmq.md) | [`worker.rabbit.test.js`](../../test/worker.rabbit.test.js) y [`consumidor.test.js`](../../test/consumidor.test.js) |
| La pasarela responde lento o no responde | **Timeout** y degradación controlada: 503, la compra queda en `pago_pendiente` y reintentar con la misma clave es seguro | [`pasarela.js`](../../src/lib/pasarela.js), [`pagos.js`](../../src/services/pagos.js), [ADR 0010](adr-0010-ciclo-de-vida-compra-pago-conciliacion.md) | [`pagos.db.test.js`](../../test/pagos.db.test.js): con la pasarela caída responde 503 y completa el cobro al reintentar |
| El webhook se pierde, o la API no lo recibe | **Reintentos con backoff exponencial** del emisor y **conciliación** del receptor | [`pagos-mock/server.js`](../../services/pagos-mock/server.js), [`barrido.js`](../../src/lib/barrido.js), [ADR 0006](adr-0006-webhook-pago-hmac.md) y [ADR 0010](adr-0010-ciclo-de-vida-compra-pago-conciliacion.md) | [`pagos-mock.test.js`](../../test/pagos-mock.test.js) y [`barrido.db.test.js`](../../test/barrido.db.test.js) |
| Un proceso muere a mitad de una operación | Transiciones condicionales, **compensación** y **reconciliación** del cupo | [`compras.js`](../../src/services/compras.js), [`barrido.js`](../../src/lib/barrido.js) | [`compras.db.test.js`](../../test/compras.db.test.js) (compensación) y [`barrido.db.test.js`](../../test/barrido.db.test.js) (cupo) |
| MongoDB no responde | Falla explícita y reintentable: 503 `DATABASE_UNAVAILABLE` | [`errors.js`](../../src/lib/errors.js) | [`webhooks.api.test.js`](../../test/webhooks.api.test.js) |
| La pasarela no responde durante el barrido | **Aislamiento de pasos** y corte al primer fallo | [`barrido.js`](../../src/lib/barrido.js) | [`barrido.unit.test.js`](../../test/barrido.unit.test.js) y [`barrido.db.test.js`](../../test/barrido.db.test.js) |
| El worker pierde la conexión con RabbitMQ | **Salir sin confirmar y reiniciar**: el mensaje sin ack vuelve a la cola | [`worker.js`](../../src/worker.js), [`docker-compose.yml`](../../docker-compose.yml) (`restart: unless-stopped`) | [`consumidor.test.js`](../../test/consumidor.test.js): si no se puede reencolar ni derivar el mensaje, no se confirma |

### El patrón central: retry con espera + DLQ, y por qué va de la mano con la idempotencia

Un mensaje `entrada.comprada` puede fallar por un motivo transitorio (MongoDB un instante caído) o permanente (no cumple el contrato, la compra no existe). Tratarlos igual es el error clásico: reintentar para siempre lo permanente traba la cola, y descartar lo transitorio pierde una compra pagada.

- **Transitorio:** se republica en `emision.entrada-comprada.retry` con `x-retry-count + 1` y una espera. La espera viaja como `expiration` del mensaje y no como argumento de la cola, así `api` y `worker` declaran exactamente la misma topología aunque tengan un `RETRY_DELAY_MS` distinto ([ADR 0005](adr-0005-broker-rabbitmq.md)). Es una espera fija (`RETRY_DELAY_MS`, 3 s) y no exponencial: con una espera constante la cola de retry conserva el orden y no se traba en la cabeza. Hasta `MAX_RETRIES` (3).
- **Permanente, o reintentos agotados:** va directo a `emision.entrada-comprada.dlq` con el motivo en `x-dlq-reason` y el último error en `x-last-error`. El mensaje no se pierde ni traba nada: queda a la vista en la consola de RabbitMQ para que alguien lo revise.
- **Nunca se usa `nack` con requeue:** reencolar el mismo mensaje de inmediato lo haría girar sin espera. Se publica el reintento y recién después se confirma el original; si no se puede publicar, no se confirma, el worker sale y RabbitMQ devuelve el mensaje a la cola.

Reintentar solo es seguro si repetir no duplica el efecto. Por eso el consumidor es idempotente (upsert de cada entrada por `(compraId, numero)` y registro del `eventId` **al final**, para que un fallo a mitad no marque como hecho algo que no se hizo) y por eso la API exige `Idempotency-Key`. Sin esa pareja, el retry produciría entradas duplicadas.

## Por qué no hay circuit breaker

Se evaluó un circuit breaker sobre la llamada a la pasarela y **se descartó**. Cuestionándolo punto por punto:

- **¿Qué aportaría?** Con la pasarela colgada, cada `POST /compras/{id}/pagar` espera hasta 5 s (el timeout) y deja la compra en `pago_pendiente`. Esa compra no se puede cancelar (cancelar exige `pendiente`) y con otra clave de idempotencia responde 409 hasta que se reintenta con la misma clave o hasta que la conciliación la resuelve, una vez vencido `pagoExpiraEn` (30 min). Un breaker puesto **antes** de persistir cortaría en milisegundos y dejaría la compra en `pendiente`.
- **¿Es necesario para que el sistema sea correcto?** No. La correctitud ya la garantizan el timeout, el reintento idempotente y la conciliación del barrido ([ADR 0010](adr-0010-ciclo-de-vida-compra-pago-conciliacion.md)). El breaker sería una válvula de seguridad, no una pieza que falte.
- **¿Cubre lo que cuesta?** Poco. Con la pasarela caída "dura" (conexión rechazada o nombre no resuelto) la llamada ya falla al instante, así que el breaker solo ahorraría tiempo en el caso colgado. Y el efecto que evitaría está acotado: un cliente que reintenta con la misma clave, como indica el contrato, completa el pago, y lo que queda trabado lo resuelve la conciliación.
- **¿Cuánto cuesta?** Estado por proceso (y no compartido entre réplicas), umbrales que calibrar, un caso nuevo que probar y explicar, y un riesgo propio: un falso positivo bloquearía todos los pagos mientras el circuito esté abierto. Para un único servicio externo, el costo supera el beneficio.
- **¿Hay otra forma más simple de lo que sí molestaba?** Sí: el barrido consultaba hasta 50 pagos en serie y cada consulta fallida esperaba el timeout, así que una pasada podía tardar minutos y retrasar los pasos que vienen después. Eso se resuelve cortando el paso conciliación en la primera consulta fallida, sin estado entre pasadas. Medido con una pasarela colgada: 3 compras vencidas pasaron de 15,1 s a 5 s, y con 50 el paso dura 5 s en lugar de unos 250 s (50 × 5 s).

**Cuándo se reconsidera:** si aparecen varias dependencias síncronas en el camino de una solicitud, si el tráfico de pagos crece lo bastante para que apilar esperas de 5 s importe, o si se reemplaza la pasarela simulada por una real con límites de tasa.

## Consecuencias

- Cada falla de la tabla tiene un comportamiento definido y verificable, no una excepción sin manejar.
- **Costo asumido:** con la pasarela colgada, `/pagar` puede tardar hasta 5 s y dejar la compra en `pago_pendiente` hasta reintentar con la misma clave o hasta la conciliación. Está declarado en las limitaciones del README.
- Los reintentos son siempre sobre operaciones idempotentes; ningún camino reintenta un cobro "a ciegas".
- La DLQ requiere que alguien la mire: el sistema no la vacía ni la reprocesa solo. El dashboard muestra `mensajes_dlq_total` ([ADR 0008](adr-0008-observabilidad-correlation-id.md)).

## Alternativas descartadas

- **Circuit breaker con una librería (opossum):** trae ventanas móviles, eventos y estadísticas que no se usan, y es una dependencia más para un solo destino.
- **Circuit breaker casero:** ver el análisis de arriba. Es poco código, pero el costo de calibrarlo, probarlo y explicarlo no se justifica hoy.
- **Estado del breaker compartido entre réplicas (en MongoDB):** más piezas que fallar para proteger contra fallas.
- **Rate limiting y bulkheads:** hay un único tipo de cliente de tráfico y una sola dependencia síncrona; no hay nada que aislar.
- **Reintentar `/pagar` de inmediato dentro de la misma solicitud:** un timeout es ambiguo (la pasarela pudo haber aceptado el cobro) y repetirlo a ciegas arriesga un doble cobro. Se reintenta desde el cliente con la misma clave, que la pasarela trata como idempotente por `compraId`.
- **Reencolar con `nack`:** el mensaje giraría sin espera y sin límite.
