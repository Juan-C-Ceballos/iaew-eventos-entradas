# ADR 0009 — Patrón outbox para publicar `entrada.comprada`

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

Cuando llega un pago aprobado, la API tiene que hacer dos escrituras en dos sistemas distintos: marcar la compra como `pagada` en MongoDB y publicar `entrada.comprada` en RabbitMQ. No hay una transacción que abarque los dos. Si la API se cae, o RabbitMQ no está disponible entre una escritura y la otra, la compra queda pagada pero el evento no se publica, y las entradas nunca se emiten.

Una forma de cubrirlo es responder 503 a la pasarela para que reintente el webhook. Pero eso deja la garantía en manos de un tercero: si la pasarela no reintenta, o deja de hacerlo, el sistema queda inconsistente sin que nadie lo note.

## Decisión

1. **El webhook solo escribe en MongoDB.** En un único `findOneAndUpdate` condicional (`pago_pendiente → pagada`) guarda el estado, el sobre completo del evento en `compras.emisionEvento` (con su `eventId`) y `emisionEstado: pendiente`. Como es un solo documento, la escritura es atómica: si el estado cambió, el evento quedó registrado.
2. **Un relay dentro del contenedor `api`** (`src/lib/outbox.js`) recorre cada `OUTBOX_INTERVALO_MS` (1000 ms) las compras `pagada` con `emisionEvento` y sin `emisionPublicadaEn`. Las publica en orden con confirm channel y después marca `emisionPublicadaEn`.
3. **Ante un fallo del broker**, el relay corta la pasada y deja el resto pendiente para la siguiente. No hay pérdida, solo demora.
4. **El relay vive en el productor** (`api`) y no en el `worker`, para mantener separados productor y consumidor, como muestra la vista C4 Container.
5. El índice `{ estado, emisionPublicadaEn }` (migración `20261003150000-indice-outbox.js`) hace barata la búsqueda de pendientes.

## Consecuencias

- **Garantía:** toda compra `pagada` termina publicando su `entrada.comprada`, aunque la API o RabbitMQ se caigan. No depende de que la pasarela reintente.
- El webhook responde 200 apenas persiste el resultado, sin esperar a RabbitMQ.
- **Duplicados posibles:** si la API se cae entre publicar y marcar, o si corre más de una réplica de `api`, el mismo `eventId` puede publicarse dos veces. Es aceptable porque la entrega ya es *at least once* y el consumidor deduplica por `eventId` ([ADR 0005](adr-0005-broker-rabbitmq.md)).
- **Latencia adicional** de hasta `OUTBOX_INTERVALO_MS` entre el pago y la publicación. Para la emisión de entradas es irrelevante.
- Consultas periódicas a MongoDB, acotadas por el índice y por un límite de 50 compras por pasada.
- Un fallo del broker se registra **una sola vez** (y otra vez solo si el error cambia), con un aviso cuando la publicación se restablece. Registrarlo en cada pasada llenaría los logs con miles de líneas iguales.

## Alternativas descartadas

- **Publicar directamente desde el webhook y responder 503 si falla:** deja la consistencia en manos del reintento de un tercero.
- **Colección `outbox` separada:** necesitaría escribir dos documentos de forma atómica (compra + mensaje), y eso requiere transacciones multi-documento y un replica set. Embeber el mensaje en la compra da la misma atomicidad con una sola escritura.
- **Change Streams de MongoDB:** también requieren replica set y suman complejidad operativa a Compose.
- **Relay en el `worker`:** mezcla los roles de productor y consumidor en el mismo proceso.
