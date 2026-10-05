# C4 — Nivel 3: Componentes del contenedor `api`

**Alcance:** los componentes internos del contenedor `api` y sus relaciones. No baja a funciones ni clases. El worker se documenta en [docs/eventos](eventos/README.md).

```mermaid
flowchart LR
  cliente["Cliente M2M"]
  pasarela["pagos-mock"]
  mongo[("mongodb")]
  rabbit[["rabbitmq"]]
  auth0["Auth0 (JWKS)"]

  subgraph api["Contenedor api"]
    direction LR
    routers["Routers Express<br/><i>eventos, compras, entradas,<br/>webhooks, internal</i>"]
    authmw["Validación JWT y scope<br/><i>express-oauth2-jwt-bearer</i>"]
    apikey["Validación x-api-key"]
    firma["Verificación de firma HMAC<br/><i>webhook de pagos</i>"]
    idem["Control de idempotencia<br/><i>Idempotency-Key</i>"]
    svcEventos["Servicio de eventos<br/><i>reglas de capacidad y estados</i>"]
    svcCompras["Servicio de compras<br/><i>reserva atómica, expiración,<br/>cancelación, resultado del pago</i>"]
    svcEntradas["Servicio de validación<br/><i>emitida → usada</i>"]
    clientePagos["Cliente de pasarela<br/><i>HTTP</i>"]
    modelos["Modelos Mongoose<br/><i>Evento, Asistente, Compra,<br/>Entrada, EventoProcesado</i>"]
    relay["Relay del outbox<br/><i>publica entrada.comprada<br/>pendientes cada 1 s</i>"]
    errores["Formato de errores<br/><i>sendError</i>"]
  end

  cliente -->|"HTTPS + Bearer"| routers
  pasarela -->|"POST /webhooks/pagos"| routers
  routers -->|"Autoriza por scope"| authmw
  authmw -->|"Obtiene claves públicas"| auth0
  routers -->|"Autoriza /internal"| apikey
  routers -->|"Autentica el webhook"| firma
  routers -->|"Deduplica intenciones"| idem
  routers -->|"Gestiona eventos"| svcEventos
  routers -->|"Ejecuta el flujo de compra"| svcCompras
  routers -->|"Valida ingreso"| svcEntradas
  svcCompras -->|"Solicita cobro"| clientePagos
  clientePagos -->|"HTTP/JSON"| pasarela
  svcCompras -->|"Registra pagada + evento<br/>en una sola escritura"| modelos
  relay -->|"Busca compras pagadas sin publicar<br/>y las marca"| modelos
  relay -->|"Publica entrada.comprada<br/>AMQP confirm channel"| rabbit
  idem -->|"Lee y guarda claves"| modelos
  svcEventos -->|"Lee y persiste"| modelos
  svcCompras -->|"Lee y persiste"| modelos
  svcEntradas -->|"Lee y persiste"| modelos
  modelos -->|"Mongoose"| mongo
  routers -->|"Responde errores uniformes"| errores
```

## Componentes y ubicación en el código

| Componente | Archivo | Estado |
|---|---|---|
| Routers Express | `src/routes/{eventos,compras,entradas,webhooks,internal}.js` | Entrega 2 (hoy, `src/lib/contrato.js` responde 501 en cada operación del contrato) |
| Validación JWT y scope | [`src/middleware/auth0.js`](../src/middleware/auth0.js) | Implementado (`validateAccessToken`, `requireScope`) |
| Validación x-api-key | [`src/middleware/apiKey.js`](../src/middleware/apiKey.js) | Implementado |
| Verificación de firma HMAC | `src/middleware/webhookFirma.js` | Entrega 2 |
| Control de idempotencia | `src/lib/idempotency.js` | Entrega 2 |
| Servicios de eventos, compras y validación | `src/services/*.js` | Entrega 2 |
| Cliente de pasarela | `src/lib/pagos.js` | Entrega 2 |
| Modelos Mongoose | [`src/models/`](../src/models) | Implementado |
| Relay del outbox | [`src/lib/outbox.js`](../src/lib/outbox.js) + [`src/lib/rabbit.js`](../src/lib/rabbit.js) | Implementado (ADR 0009) |
| Formato de errores | [`src/lib/errors.js`](../src/lib/errors.js) | Implementado |

## Secuencia del flujo multi-paso

```mermaid
sequenceDiagram
  autonumber
  participant C as Canal de venta
  participant A as api
  participant M as mongodb
  participant P as pagos-mock
  participant R as rabbitmq
  participant W as worker

  C->>A: POST /compras (buy:entradas, Idempotency-Key)
  A->>M: findOneAndUpdate evento publicado con cupo ≥ n ($inc -n)
  alt sin cupo
    A-->>C: 409 EVENT_SOLD_OUT
  else con cupo
    A->>M: crear Compra pendiente (reservaExpiraEn)
    A-->>C: 201 compra pendiente
  end
  C->>A: POST /compras/{id}/pagar (Idempotency-Key)
  A->>M: compra pendiente → pago_pendiente (condicional, fija pagoExpiraEn)
  A->>P: POST /pagos (compraId, monto, Idempotency-Key)
  alt la pasarela no responde
    A-->>C: 503 (sigue en pago_pendiente; reintentar con la misma clave)
  else acepta el cobro
    P-->>A: referenciaExterna
    A->>M: guarda pago.referenciaExterna
    A-->>C: 202 pago solicitado
  end
  P->>A: POST /webhooks/pagos (X-Pago-Firma, X-Pago-Timestamp)
  alt pago.aprobado
    A->>M: compra → pagada + emisionEvento (eventId), una sola escritura
    A-->>P: 200
    Note over A,R: relay del outbox (cada 1 s)
    A->>M: busca compras pagadas sin emisionPublicadaEn
    A->>R: publica entrada.comprada (confirm)
    A->>M: marca emisionPublicadaEn
    R->>W: entrega entrada.comprada
    W->>M: dedup eventId, crea entradas, emisionEstado → emitida
    W->>R: ack
  else pago.rechazado
    A->>M: compra → rechazada y devuelve el cupo ($inc +n)
    A-->>P: 200
  end
  opt el webhook no llegó antes de pagoExpiraEn
    W->>P: GET /pagos?compraId (barrido)
    W->>M: pagada + outbox, rechazada o expirada (libera cupo)
  end
  C->>A: GET /compras/{id}/entradas
  A-->>C: 200 entradas emitidas
```

## Componentes del contenedor `worker`

El `worker` tiene dos responsabilidades: consumir `entrada.comprada` y ejecutar un **barrido** periódico (`BARRIDO_INTERVALO_MS`, 60 s). Todas las transiciones del barrido son `findOneAndUpdate` condicionales, así que varias réplicas pueden convivir ([ADR 0010](adr/adr-0010-ciclo-de-vida-compra-pago-conciliacion.md)).

| Componente | Responsabilidad | Estado |
|---|---|---|
| Declaración de topología | `declararTopologia` en [`src/lib/rabbit.js`](../src/lib/rabbit.js): exchanges, colas, retry y DLQ (la misma que ejecuta `api`) | Implementado |
| Consumidor de `entrada.comprada` | Deduplica por `eventId`, emite las entradas, gestiona retry y DLQ | Entrega 2 |
| Barrido de vencimientos | Reservas `pendiente` vencidas → `expirada` y libera cupo | Entrega 2 |
| Conciliación de pagos | Compras `pago_pendiente` con `pagoExpiraEn` vencido: consulta `GET /pagos?compraId` a la pasarela y resuelve la compra | Entrega 2 |
| Reconciliación de cupo | Recalcula el cupo esperado por evento y lo corrige si la diferencia persiste dos barridos | Entrega 2 |
| Cierre de eventos | `publicado` → `finalizado` pasadas `EVENTO_FINALIZA_TRAS_HORAS` de la fecha, y cascada de cancelación ([ADR 0011](adr/adr-0011-ciclo-de-vida-evento.md)) | Entrega 2 |
