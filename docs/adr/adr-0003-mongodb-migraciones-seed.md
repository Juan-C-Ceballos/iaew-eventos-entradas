# ADR 0003 — MongoDB con Mongoose, migraciones con migrate-mongo y seed idempotente

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

Necesitamos persistir eventos, asistentes, compras, entradas y eventos procesados, y además:

- Reservar cupo sin sobreventa cuando hay compras concurrentes.
- Garantizar la unicidad de claves de idempotencia, códigos de entrada y `eventId`.
- Que la base se pueda reproducir con migraciones o seed.

El dominio es transaccional (cupo, compra, pago, entradas), así que SQL era una opción seria y la elección de MongoDB tiene que justificarse por el diseño, no solo por costumbre:

- **La compra es un agregado.** Compra, pago, snapshot del asistente y sobre del evento a publicar se leen y escriben siempre juntos, y su cambio de estado debe ser atómico. En un documento eso es una sola escritura.
- **El invariante central se resuelve con un contador.** No sobrevender equivale a un `findOneAndUpdate` condicional (`cupoDisponible >= n`) sobre un único documento, que MongoDB garantiza atómico sin locks ni transacciones.
- **El equipo conoce el stack** (Mongoose, migrate-mongo). Es un factor real, porque baja el riesgo de las seis semanas hasta la Entrega 2, pero no es el argumento.

Mongoose no trae una herramienta de migraciones ni de seed, así que hay que elegir una.

## Decisión

1. **MongoDB 7** como único motor y **Mongoose 8** como ODM.
2. **Modelado orientado a documentos.** El pago y el sobre de `entrada.comprada` van embebidos en la compra. Evento, asistente y entrada son colecciones con referencias. Detalle en el [modelo de datos](../modelo-datos.md).
3. **Consistencia sin transacciones multi-documento.** Cada paso crítico modifica **un solo documento** con un update atómico condicional ([ADR 0007](adr-0007-reserva-cupo-idempotencia.md)). Los efectos sobre más de un documento, como la reserva de cupo seguida de crear la compra, se compensan si falla el segundo paso.
4. **Migraciones con migrate-mongo**, en `migrations/` con `up` y `down`, historial en la colección `migraciones` y lock contra ejecuciones concurrentes. Las migraciones son dueñas de los índices: Mongoose corre con `autoIndex: false`.
5. **Seed idempotente** (`npm run seed`) con `_id` fijos y `$setOnInsert`.
6. **En Compose**, el job `db-init` ejecuta `migrate` y después `seed` antes de levantar la `api`. Los datos persisten en el volumen `mongo-data` y `docker compose down -v` reinicia todo.
7. **Lo que se resigna respecto de SQL, y con qué se compensa:**

   | SQL ofrece | Acá se resuelve con |
   |---|---|
   | `CHECK (cupo >= 0)` | El filtro `$gte` del update atómico, el validador de Mongoose y el reconciliador de cupo ([ADR 0010](adr-0010-ciclo-de-vida-compra-pago-conciliacion.md)) |
   | Claves foráneas | La API valida las referencias; no se borra un evento con ventas (`EVENT_HAS_SALES`) |
   | Transacciones entre tablas | Diseño: outbox embebido ([ADR 0009](adr-0009-outbox-entrada-comprada.md)), una transición por documento y compensaciones |
   | JOINs para reportes | Agregación indexada; solo el reporte interno cruza colecciones |
   | Esquema impuesto por la base | Mongoose, migraciones aditivas y el test que compara índices con modelos |

## Consecuencias

- Los documentos se mapean directamente a los recursos JSON de la API, sin capa de mapeo objeto-relacional.
- Los índices únicos son la última barrera contra duplicados (compra, pago, entrada, evento procesado).
- Sin `autoIndex`, olvidar una migración deja una colección sin su índice. Por eso la migración y el esquema declaran los mismos índices.
- No hay integridad referencial: la API valida las referencias y el borrado de eventos con ventas está prohibido (`EVENT_HAS_SALES`).
- La cantidad de compras por evento no tiene un límite físico. El reporte de ventas se resuelve con una agregación indexada por `{ eventoId, estado }`.

## Alternativas descartadas

- **PostgreSQL + Prisma/Knex:** es una alternativa válida y daría `CHECK`, claves foráneas y transacciones. Se descartó porque el agregado de compra encaja en un documento y el único invariante crítico (el cupo) ya se garantiza con una operación atómica por documento. Si la lógica de compensación creciera mucho en la Entrega 2, se reevaluaría con un ADR nuevo.
- **`autoIndex: true` sin migraciones:** crea índices en silencio al arrancar, sin historial ni rollback. Un índice único que falla sobre datos existentes pasa desapercibido.
- **Transacciones multi-documento de MongoDB:** exigen un replica set. Un replica set de un solo nodo es sencillo de levantar en Compose, así que el costo no es la infraestructura sino la complejidad (healthcheck con `rs.initiate`, reintentos ante `TransientTransactionError`). No se adoptan porque cada paso crítico ya es atómico por documento y los huecos restantes están cubiertos por compensaciones y reconciliación.
- **Seed con `insertMany` sin ids fijos:** duplica datos en cada ejecución.
