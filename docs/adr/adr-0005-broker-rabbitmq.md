# ADR 0005 — RabbitMQ para la emisión diferida de entradas

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

Cuando se aprueba un pago, hay que emitir N entradas con código único, y más adelante quizás generar el QR o notificar al asistente. Hacerlo dentro del webhook acopla la respuesta a la pasarela con trabajo que puede fallar o tardar. La consigna exige productor → broker → consumidor con efecto visible. El hecho de negocio que dispara la emisión es `entrada.comprada`.

## Decisión

1. **Broker: RabbitMQ 4.2** (imagen `rabbitmq:4.2-management`) con **amqplib**.
2. **Topología** (detalle en [docs/eventos](../eventos/README.md)): exchange direct `entradas.exchange`, routing key `entrada.comprada`, cola `emision.entrada-comprada`. Retry con `entradas.retry.exchange` y la cola `.retry` (TTL `RETRY_DELAY_MS` que vuelve por dead-letter al exchange principal). DLQ en `entradas.dlx` y la cola `.dlq`.
3. **Productor (`api`):** publica mediante el relay del patrón outbox ([ADR 0009](adr-0009-outbox-entrada-comprada.md)), con confirm channel (`waitForConfirms`), mensajes `persistent` y `messageId = eventId`. El sobre se persiste en `compras.emisionEvento` junto con el cambio a `pagada`, así que un reintento republica siempre el **mismo** `eventId`.
4. **Consumidor (`worker`):** `prefetch(1)` y ack manual **después** de persistir. Deduplica por `eventos_procesados.eventId` y usa el índice único `(compraId, numero)` en `entradas`. Los errores transitorios van a retry hasta `MAX_RETRIES` y los permanentes (contrato inválido, compra inexistente) van directo a la DLQ. No usa `nack` con requeue.
5. **Contrato del mensaje:** JSON Schema `entrada.comprada` v1 con `additionalProperties: false` y solo cambios aditivos.
6. **Efecto visible en la demo:** `GET /compras/{id}/entradas` pasa de `[]` a N entradas y `emisionEstado` de `pendiente` a `emitida`. En la consola de RabbitMQ (puerto 15672) se ven las colas y los mensajes en retry o DLQ.

## Consecuencias

- El webhook responde rápido y no depende de la emisión. Si el worker está caído, los mensajes esperan en la cola.
- La entrega *at least once* obliga a que el consumidor sea idempotente, y eso está cubierto con doble barrera.
- La ventana de inconsistencia entre persistir `pagada` y publicar se elimina con el outbox ([ADR 0009](adr-0009-outbox-entrada-comprada.md)).
- Hay un contenedor más que operar.

## Alternativas descartadas

- **Kafka:** está pensado para streaming y retención, que no necesitamos. Es más pesado en Compose y no tiene DLQ nativa.
- **SQS/EventBridge:** requieren AWS y no corren 100% local con Compose sin emuladores.
- **Emitir las entradas en el mismo request del webhook:** acopla la latencia y las fallas, y no cumple el requisito de asincronía.
