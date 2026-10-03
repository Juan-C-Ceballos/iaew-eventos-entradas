# ADR 0003 — MongoDB con Mongoose, migraciones con migrate-mongo y seed idempotente

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

Necesitamos persistir eventos, asistentes, compras, entradas y eventos procesados, y además:

- Reservar cupo sin sobreventa cuando hay compras concurrentes.
- Garantizar la unicidad de claves de idempotencia, códigos de entrada y `eventId`.
- Que la base se pueda reproducir con migraciones o seed.

El equipo ya trabajó con MongoDB y Mongoose, y los patrones de idempotencia, worker y deduplicación que vamos a usar en la Entrega 2 están pensados para ese stack. Mongoose no trae una herramienta de migraciones ni de seed, así que hay que elegir una.

## Decisión

1. **MongoDB 7** como único motor y **Mongoose 8** como ODM.
2. **Modelado orientado a documentos.** El pago y el sobre de `entrada.comprada` van embebidos en la compra. Evento, asistente y entrada son colecciones con referencias. Detalle en el [modelo de datos](../modelo-datos.md).
3. **Consistencia sin transacciones multi-documento.** Cada paso crítico modifica **un solo documento** con un update atómico condicional ([ADR 0007](adr-0007-reserva-cupo-idempotencia.md)). Los efectos sobre más de un documento, como la reserva de cupo seguida de crear la compra, se compensan si falla el segundo paso.
4. **Migraciones con migrate-mongo**, en `migrations/` con `up` y `down`, historial en la colección `migraciones` y lock contra ejecuciones concurrentes. Las migraciones son dueñas de los índices: Mongoose corre con `autoIndex: false`.
5. **Seed idempotente** (`npm run seed`) con `_id` fijos y `$setOnInsert`.
6. **En Compose**, el job `db-init` ejecuta `migrate` y después `seed` antes de levantar la `api`. Los datos persisten en el volumen `mongo-data` y `docker compose down -v` reinicia todo.

## Consecuencias

- Los documentos se mapean directamente a los recursos JSON de la API, sin capa de mapeo objeto-relacional.
- Los índices únicos son la última barrera contra duplicados (compra, pago, entrada, evento procesado).
- Sin `autoIndex`, olvidar una migración deja una colección sin su índice. Por eso la migración y el esquema declaran los mismos índices.
- No hay integridad referencial: la API valida las referencias y el borrado de eventos con ventas está prohibido (`EVENT_HAS_SALES`).
- La cantidad de compras por evento no tiene un límite físico. El reporte de ventas se resuelve con una agregación indexada por `{ eventoId, estado }`.

## Alternativas descartadas

- **PostgreSQL + Prisma/Knex:** da transacciones ACID y FKs, pero el modelo de compra con pago y evento embebidos encaja mejor en documentos.
- **`autoIndex: true` sin migraciones:** crea índices en silencio al arrancar, sin historial ni rollback. Un índice único que falla sobre datos existentes pasa desapercibido.
- **Transacciones multi-documento de MongoDB:** requieren replica set en Compose y no hacen falta si cada transición toca un único documento.
- **Seed con `insertMany` sin ids fijos:** duplica datos en cada ejecución.
