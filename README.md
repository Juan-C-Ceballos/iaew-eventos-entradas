# TPI IAEW 2026 — Eventos y Entradas

Trabajo Práctico Integrador de la cátedra **Integración de Aplicaciones en Entornos Web** (UTN FRC, 2026).

> **Estado: Entrega 2 (implementación y defensa) — 16/11/2026.** Todo lo diseñado en la Entrega 1 está implementado y probado: las 18 operaciones del contrato, el flujo de compra multi-paso con webhook de pago, la emisión asincrónica de entradas con RabbitMQ, el barrido del worker, la observabilidad (logs JSON y dashboard) y las pruebas (suite automatizada, colección de Postman y prueba de carga). Para recorrerlo en la defensa: [docs/demo.md](docs/demo.md).

Consigna: https://utn-frc-iaew.github.io/iaew-2026-ecommerce-api/tpi/index.html

## 1. Proyecto, dominio e integrantes

| Integrante | Legajo |
|---|---|
| Juan Cruz Ceballos | 94239 |
| Santino Magris | 91999 |
| Mateo Estrada Uriz | 95556 |

**Dominio 6 — Eventos y entradas:** publicar eventos, vender entradas y validar el ingreso.

## 2. Problema y alcance

Un organizador publica eventos con capacidad limitada. Un canal de venta compra entradas en nombre de los asistentes y el control de acceso las valida en la puerta. Hay que evitar la **sobreventa**, las **compras duplicadas** por reintentos, los **pagos rechazados** que retienen cupo y el **reingreso** con una entrada ya usada.

| Requisito de la consigna | Cómo se cubre |
|---|---|
| CRUD de 2 entidades | **Eventos** (CRUD completo) y **Compras** (crear = reservar, leer, actualizar = pagar y eliminar = cancelar, como baja lógica; [ADR 0001](docs/adr/adr-0001-estilo-api-rest.md)) |
| Transacción multi-paso | Reservar cupo → pagar (pasarela simulada) → confirmar por webhook → emitir entradas |
| OAuth 2.0 + JWT con scopes | Auth0 `client_credentials` con `read:eventos`, `write:eventos`, `admin:eventos`, `buy:entradas` y `validate:entradas` |
| Endpoint con `x-api-key` | `GET /internal/reportes/ventas` |
| Productor → broker → consumidor | `api` publica `entrada.comprada` en RabbitMQ (patrón outbox) y `worker` emite las entradas |
| Integración adicional | **Webhook de pago** firmado con HMAC-SHA256 (`POST /webhooks/pagos`) |
| Errores del dominio | `EVENT_SOLD_OUT`, `PAYMENT_REJECTED` (compra `rechazada`), `TICKET_ALREADY_USED`, `IDEMPOTENCY_KEY_MISMATCH` |
| Logs JSON y dashboard | Logs de pino con correlation id; Prometheus + Grafana con p95, throughput y error rate |
| Postman y prueba de carga | Colección ejecutable con Newman (72 peticiones) y plan de JMeter con su reporte |
| Resiliencia | Idempotencia, outbox, retry con espera y DLQ, timeouts, conciliación y reconciliación del cupo: mapa falla → patrón → prueba en el [ADR 0013](docs/adr/adr-0013-patrones-de-resiliencia.md) |

## 3. Arquitectura en un vistazo

```mermaid
flowchart LR
  clientes["Clientes M2M"] -->|"HTTPS + Bearer JWT"| api["api<br/>Node.js + Express"]
  clientes -.->|"client_credentials"| auth0["Auth0"]
  api -->|"JWKS"| auth0
  api -->|"Mongoose"| mongodb[("mongodb")]
  api -->|"publica entrada.comprada"| rabbitmq[["rabbitmq"]]
  api -->|"solicita cobro"| pagos["pagos-mock"]
  pagos -->|"webhook HMAC"| api
  rabbitmq -->|"at least once"| worker["worker"]
  worker -->|"emite entradas, barrido"| mongodb
  worker -->|"consulta pagos vencidos"| pagos
  prometheus["prometheus"] -->|"/metrics"| api
  prometheus -->|"/metrics"| worker
  grafana["grafana"] --> prometheus
```

| Documento | Contenido |
|---|---|
| [docs/c4-context.md](docs/c4-context.md) | C4 nivel 1: actores y sistemas externos |
| [docs/c4-container.md](docs/c4-container.md) | C4 nivel 2: contenedores (coinciden con `docker-compose.yml`, salvo la tarea de arranque `db-init`) |
| [docs/c4-component.md](docs/c4-component.md) | C4 nivel 3: componentes de `api` y `worker` + secuencia del flujo de compra |
| [docs/openapi.json](docs/openapi.json) | Contrato OpenAPI 3.1 (también en http://localhost:3000/api-docs) |
| [docs/modelo-datos.md](docs/modelo-datos.md) | Colecciones, índices, máquinas de estado, migraciones y seed |
| [docs/eventos/](docs/eventos/README.md) | Contrato de `entrada.comprada` y topología de RabbitMQ |
| [docs/adr/](docs/adr/README.md) | Decisiones de arquitectura |
| [docs/demo.md](docs/demo.md) | Guion de la demo de 15 minutos |
| [carga/README.md](carga/README.md) | Prueba de carga: escenario, resultados y lo observado |

## 4. Requisitos previos

- Docker Desktop (Docker Engine 24 o posterior, con Compose v2).
- Node.js 22 o posterior y npm (para desarrollo local, tests y Newman; el sistema corre completo en Docker).
- Una cuenta gratuita de Auth0, para probar los endpoints protegidos con tokens reales. Sin ella, el [emisor OAuth local](#7-obtener-un-token-client_credentials) de pruebas hace de Auth0.
- curl o Postman.

## 5. Variables de entorno

```bash
cp .env.example .env
```

| Variable | Uso | Valor local por defecto |
|---|---|---|
| `PORT` | Puerto de la API | `3000` |
| `MONGODB_URI` | Conexión a MongoDB (en Compose se reemplaza por `mongodb:27017`) | `mongodb://127.0.0.1:27017/iaew_eventos` |
| `AUTH0_DOMAIN` | Tenant de Auth0 (issuer `https://<dominio>/`) | `tu-tenant.us.auth0.com` |
| `AUTH0_AUDIENCE` | Identifier de la API en Auth0 | `https://iaew-eventos-api` |
| `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` | Cliente M2M, solo para pedir tokens; la API no las usa | vacío |
| `AUTH0_ISSUER_URL` | **Solo pruebas:** reemplaza a `https://$AUTH0_DOMAIN` por un emisor local. No definir en uso normal | sin definir |
| `INTERNAL_API_KEY` | Clave del endpoint `/internal` | `colocar-api-key-local` |
| `RABBIT_URL`, `RABBIT_USER`, `RABBIT_PASS` | RabbitMQ | `iaew` / `iaew-local` |
| `RETRY_DELAY_MS`, `MAX_RETRIES` | Reintentos del worker | `3000`, `3` |
| `OUTBOX_INTERVALO_MS` | Cada cuánto el relay del outbox publica los eventos pendientes | `1000` |
| `PAGOS_URL`, `WEBHOOK_URL` | Pasarela simulada y URL del webhook | `http://localhost:4000`, `http://localhost:3000/webhooks/pagos` |
| `PAGO_DEMORA_MS` | Solo `pagos-mock`: demora hasta que resuelve el pago | `200` |
| `WEBHOOK_HABILITADO` | Solo `pagos-mock`: con `false` resuelve el pago pero no envía el webhook (para mostrar la conciliación) | `true` |
| `WEBHOOK_SECRET`, `WEBHOOK_TOLERANCIA_SEGUNDOS` | Secreto HMAC compartido y ventana anti-replay | `colocar-secreto-compartido-local`, `300` |
| `RESERVA_TTL_MINUTOS` | Vencimiento de una reserva sin pagar | `15` |
| `PAGO_TIMEOUT_MINUTOS` | Cuánto espera un pago pendiente antes de que el barrido lo concilie con la pasarela | `30` |
| `BARRIDO_INTERVALO_MS` | Cada cuánto corre el barrido del worker (vencimientos, conciliación de pagos, cupo) | `60000` |
| `EVENTO_FINALIZA_TRAS_HORAS` | Horas después de la fecha del evento en que pasa a `finalizado` | `12` |
| `LOG_LEVEL` | Nivel de los logs JSON (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) | `info` |
| `METRICS_PORT` | Puerto donde el worker expone `/metrics` | `9464` |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` | Administrador de Grafana (solo uso local) | `admin` / `admin-local` |

`.env` está en `.gitignore`. **Nunca se commitean valores reales.**

## 6. Configuración de Auth0

1. **Applications → APIs → Create API:** Name `IAEW Eventos API`, Identifier `https://iaew-eventos-api` (es el `AUTH0_AUDIENCE`), Signing Algorithm `RS256`.
2. En la API, en la pestaña **Permissions**, agregar los scopes `read:eventos`, `write:eventos`, `admin:eventos`, `buy:entradas` y `validate:entradas`.
3. Crear una aplicación **Machine to Machine** por rol (*Applications → Create Application*). Al crear la API, Auth0 genera sola una "IAEW Eventos API (Test Application)", que se puede renombrar y usar como la primera.
4. En cada aplicación, ir a la pestaña **API Access**, elegir `IAEW Eventos API` y, en la pestaña **Client Access**, otorgar solo los scopes del rol. *User-Delegated Access* no se usa y debe quedar en 0.

   | Aplicación M2M | Scopes (Client Access) |
   |---|---|
   | `iaew-organizador` | `read:eventos`, `write:eventos`, `admin:eventos` |
   | `iaew-canal-venta` | `read:eventos`, `buy:entradas` |
   | `iaew-control-acceso` | `validate:entradas` |

5. **Expiración del token:** en *APIs → IAEW Eventos API → Settings*, poner **Token Expiration (Seconds)** en `3600` (por defecto es `86400`). La API valida `exp` y rechaza un token vencido con 401 `TOKEN_INVALID` ([ADR 0004](docs/adr/adr-0004-seguridad-auth0-scopes.md)).
6. Copiar el **Domain** de la aplicación (por ejemplo `dev-xxxx.us.auth0.com`, sin `https://`) a `AUTH0_DOMAIN`, y su Client ID y Client Secret a `AUTH0_CLIENT_ID` y `AUTH0_CLIENT_SECRET` en `.env`. Después, recrear la API para que tome los valores: `docker compose up -d api`.

La API valida la firma (RS256, con las claves públicas del JWKS del tenant), el issuer, la audience, la expiración y el scope que exige cada endpoint.

## 7. Obtener un token (`client_credentials`)

Con Auth0:

```bash
set -a; . ./.env; set +a
TOKEN=$(curl -s --request POST "https://$AUTH0_DOMAIN/oauth/token" \
  --header 'content-type: application/json' \
  --data "{\"client_id\":\"$AUTH0_CLIENT_ID\",\"client_secret\":\"$AUTH0_CLIENT_SECRET\",\"audience\":\"$AUTH0_AUDIENCE\",\"grant_type\":\"client_credentials\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
```

Los clientes deben reutilizar el token hasta que se acerque a `expiresAt` y no pedir uno por request.

**Sin Auth0 (solo pruebas).** [`scripts/emisor-local.js`](scripts/emisor-local.js) imita a Auth0: publica el discovery y el JWKS y entrega tokens por `client_credentials` con un cliente por rol. No es un sistema de autenticación: sus credenciales son de prueba y la clave de firma se genera en memoria. Se levanta con un override de Compose que además apunta la API a ese emisor:

```bash
docker compose -f docker-compose.yml -f docker-compose.pruebas.yml up -d --build

# Roles: organizador-local, canal-venta-local y control-acceso-local (el secreto es "secreto-<rol>-local")
TOKEN=$(curl -s -X POST http://localhost:4010/oauth/token -H 'content-type: application/json' \
  -d '{"client_id":"canal-venta-local","client_secret":"secreto-canal-venta-local","audience":"https://iaew-eventos-api","grant_type":"client_credentials"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
```

La demo y la entrega usan Auth0; el emisor local sirve para la colección de Postman, la prueba de carga y el CI, donde no hay un tenant ni secretos.

## 8. Probar endpoints protegidos con Bearer

```bash
curl -s http://localhost:3000/token-info -H "Authorization: Bearer $TOKEN"   # 200: iss, aud, sub, scopes y vigencia
curl -i http://localhost:3000/token-info                                      # 401 TOKEN_INVALID
curl -s http://localhost:3000/eventos -H "Authorization: Bearer $TOKEN"       # 200 con read:eventos; 403 SCOPE_REQUIRED sin él
```

Cada operación exige el scope que declara el contrato: sin token responde 401 `TOKEN_INVALID` y con un token válido sin el scope, 403 `SCOPE_REQUIRED`. Para ver la expiración en acción: bajar *Token Expiration* a `60`, pedir un token, esperar más de un minuto y repetir la llamada. Responde 401 `TOKEN_INVALID`; con un token nuevo vuelve a 200. Restaurar `3600` después.

## 9. Probar el endpoint con `x-api-key`

```bash
curl -s http://localhost:3000/internal/reportes/ventas -H "x-api-key: $INTERNAL_API_KEY"   # 200
curl -i http://localhost:3000/internal/reportes/ventas                                     # 401 API_KEY_INVALID
```

Es el endpoint de comparación: una clave estática sin identidad ni scopes, que ve todos los eventos. Un token OAuth no sirve acá (401) ni la clave sirve en los demás endpoints ([ADR 0004](docs/adr/adr-0004-seguridad-auth0-scopes.md)).

## 10. Levantar el sistema

```bash
cp .env.example .env            # opcional: Compose tiene valores por defecto locales
docker compose up -d --build
docker compose ps               # todo healthy, db-init "exited (0)"
```

| Servicio | URL |
|---|---|
| API (health) | http://localhost:3000/health |
| Swagger UI | http://localhost:3000/api-docs |
| Contrato JSON | http://localhost:3000/api-docs/openapi.json |
| Métricas de la API | http://localhost:3000/metrics |
| RabbitMQ management | http://localhost:15672 (`iaew` / `iaew-local`) |
| Pasarela simulada | http://localhost:4000/health |
| Prometheus | http://localhost:9090 |
| Grafana (dashboard) | http://localhost:3001 |

**Desarrollo sin contenerizar la API** (con `mongodb` y `rabbitmq` en Docker):

```bash
docker compose up -d mongodb rabbitmq
npm ci
npm run migrate && npm run seed
npm run dev          # API con recarga
npm run worker       # en otra terminal
set -a; . ./.env; set +a; npm run pagos-mock   # otra más: la pasarela simulada, que lee WEBHOOK_URL y WEBHOOK_SECRET del entorno
```

Detener: `docker compose down`. Borrar también los datos: `docker compose down -v`.

> Si ya habías levantado una versión anterior del repo, corré `docker compose down` antes de `up`: RabbitMQ no usa volumen y conservaría la cola de retry vieja, con argumentos distintos a los actuales.

## 11. Datos iniciales

El job `db-init` corre `npm run migrate` (índices con migrate-mongo) y `npm run seed` (3 eventos de demostración, con fechas a 45, 52 y 65 días de la primera ejecución para que sigan vendiendo) antes de que arranque la API. Ambos son idempotentes. Detalle en [docs/modelo-datos.md](docs/modelo-datos.md#estrategia-de-migraciones-y-seed).

| Evento | Id | Para probar |
|---|---|---|
| Recital de Rock Sinfónico | `66f000000000000000000001` | Flujo feliz (500 lugares) |
| Charla íntima de Jazz | `66f000000000000000000002` | `EVENT_SOLD_OUT` (2 lugares) |
| Obra de teatro (en preparación) | `66f000000000000000000003` | `EVENT_NOT_PUBLISHED` (borrador) |

Para ver el estado de las migraciones: `npm run migrate:status`.

## 12. Ejecutar las pruebas

```bash
npm test                 # unitarias, de API y de contrato; omite las que necesitan MongoDB o RabbitMQ
npm run check            # sintaxis de los puntos de entrada
npm run lint:openapi     # valida docs/openapi.json con Redocly (reglas en redocly.yaml)
docker compose config --quiet
```

**Integración con MongoDB y RabbitMQ reales.** Cada archivo `*.db.test.js` y `worker.rabbit.test.js` usa una base propia (`<nombre>_<sufijo>`) y vacía sus colecciones, así que el nombre de `MONGODB_URI_TEST` debe contener `test`:

```bash
docker compose up -d mongodb rabbitmq
MONGODB_URI_TEST=mongodb://127.0.0.1:27017/iaew_eventos_test \
RABBIT_URL_TEST=amqp://iaew:iaew-local@127.0.0.1:5672 npm test
```

La prueba con RabbitMQ vacía las colas de `entrada.comprada`: no correrla con el `worker` del stack encendido, que consume de la misma cola. Estas pruebas cubren lo que no se puede comprobar con dobles: la reserva atómica (25 compras simultáneas sobre 2 lugares dejan exactamente 2), la idempotencia con requests simultáneos, la validación de una entrada desde 20 puertas a la vez, el webhook de punta a punta con la pasarela real, el retry y la DLQ, y el barrido.

**Colección de Postman con Newman** (72 peticiones: seguridad, CRUD, flujo de compra completo con espera del efecto asincrónico, errores del dominio, webhook, cancelaciones y reporte). Los tokens se piden una vez por rol y se reutilizan:

```bash
docker compose -f docker-compose.yml -f docker-compose.pruebas.yml up -d --build   # stack con el emisor OAuth local
npm run postman                                                                    # ambiente "pruebas"
```

Los ambientes están en [`postman/`](postman): `pruebas` (emisor local), `local` (Auth0 real: completar las credenciales de las tres aplicaciones M2M, que se commitean vacías) y `docker` (Newman dentro de la red de Compose). La colección se genera con `npm run postman:generar`.

**Prueba de carga con JMeter:** `npm run carga` (30 hilos durante 90 s con `HILOS=30 RAMPA=10 DURACION=90`). Escenario, resultados y reporte HTML en [carga/README.md](carga/README.md): 6395 solicitudes, 0 errores y p95 total de 437 ms en la última corrida.

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) corre las pruebas con MongoDB y RabbitMQ, el lint del contrato y la colección de Postman con Newman contra el stack completo.

## 13. Flujo asincrónico: cómo dispararlo y dónde ver el efecto

1. Crear una compra (`POST /compras`, ver [§16](#16-endpoints-principales)) y pagarla con `POST /compras/{id}/pagar` y `{"escenario":"aprobado"}`.
2. La pasarela llama al webhook. La compra pasa a `pagada` y registra el evento en el outbox, y en menos de un segundo el relay de la API publica `entrada.comprada`.
3. El worker emite las entradas. El efecto se ve en `GET /compras/{id}/entradas`, que pasa de `[]` a N entradas, y en `emisionEstado: emitida`. En la consola de RabbitMQ (http://localhost:15672 → *Queues*) se ve `emision.entrada-comprada`, y en los logs del worker su `eventId` y `correlationId`.

Para ver la DLQ, publicar un mensaje que no cumple el contrato con la API de administración de RabbitMQ. El worker lo deriva a `emision.entrada-comprada.dlq` con su `x-dlq-reason` (`contract_invalid`); se ve en http://localhost:15672 → *Queues* → *Get messages*:

```bash
curl -s -u iaew:iaew-local -X POST 'http://localhost:15672/api/exchanges/%2F/entradas.exchange/publish' -H 'content-type: application/json' \n  -d '{"properties":{"delivery_mode":2,"headers":{"x-retry-count":0}},"routing_key":"entrada.comprada","payload":"{\"no\":\"cumple el contrato\"}","payload_encoding":"string"}'
```

Un fallo transitorio (por ejemplo, MongoDB caído) pasa por `emision.entrada-comprada.retry` y se reintenta `MAX_RETRIES` veces antes de ir a la DLQ.

Si RabbitMQ está detenido, la compra queda `pagada` con su evento pendiente y se publica sola cuando el broker vuelve (outbox, [ADR 0009](docs/adr/adr-0009-outbox-entrada-comprada.md)). Contrato y topología: [docs/eventos/README.md](docs/eventos/README.md).

## 14. Probar la integración elegida (webhook de pago)

`pagos-mock` firma cada notificación con `X-Pago-Firma: sha256=HMAC(WEBHOOK_SECRET, "<timestamp>.<cuerpo>")` y `X-Pago-Timestamp`. Escenarios:

- `{"escenario":"aprobado"}`: la compra queda `pagada` y se emiten las entradas.
- `{"escenario":"rechazado"}`: la compra queda `rechazada` y se libera el cupo (`GET /eventos/{id}`).
- Firma alterada o timestamp viejo: 401 `WEBHOOK_SIGNATURE_INVALID` / `WEBHOOK_TIMESTAMP_EXPIRED`.
- Notificación repetida: 200 con `duplicado: true`, sin efectos dobles.
- Webhook que nunca llega: con `WEBHOOK_HABILITADO=false` la pasarela resuelve el pago sin notificar. Al vencer `pagoExpiraEn` (`PAGO_TIMEOUT_MINUTOS`), el barrido del worker consulta `GET /pagos?compraId=` a la pasarela y resuelve la compra (`pagada`, `rechazada` o `expirada`). Para verlo sin esperar 30 minutos: `WEBHOOK_HABILITADO=false PAGO_TIMEOUT_MINUTOS=1 BARRIDO_INTERVALO_MS=5000 docker compose up -d`.
- Pasarela caída al pagar: `/pagar` responde 503 y la compra queda en `pago_pendiente`. Reintentar con la misma `Idempotency-Key` vuelve a enviar el cobro.

Diseño: [ADR 0006](docs/adr/adr-0006-webhook-pago-hmac.md) y [ADR 0010](docs/adr/adr-0010-ciclo-de-vida-compra-pago-conciliacion.md).

## 15. Observar el sistema

**Logs JSON correlacionables** ([ADR 0008](docs/adr/adr-0008-observabilidad-correlation-id.md)). Cada línea tiene `service`, hora ISO, `level` y `correlationId`; la de cada solicitud suma método, ruta (la plantilla `/compras/:id`), estado, duración, cliente y código de error. Nunca se registran tokens, secretos ni datos personales. Una operación se sigue de punta a punta con su id:

```bash
curl -si -X POST http://localhost:3000/compras/$COMPRA_ID/pagar -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: pago:demo-0001' \n  -H 'Content-Type: application/json' -H 'X-Correlation-Id: demo-0001' -d '{"escenario":"aprobado"}'   # el id vuelve en la respuesta
docker compose logs --no-log-prefix api worker pagos-mock | grep demo-0001
```

Si no se envía `X-Correlation-Id`, la API genera uno (UUID v4) y lo devuelve. Viaja a la pasarela, al webhook, al evento `entrada.comprada` y a los logs del worker.

**Métricas y dashboard.** La API (`/metrics`) y el worker (puerto `9464`) exponen métricas de Prometheus. En Grafana, http://localhost:3001 (se ve sin iniciar sesión; el acceso anónimo es de solo lectura), el dashboard *Eventos y Entradas* muestra:

- **API:** latencia p95 (global y por ruta), throughput y error rate 5xx y 4xx;
- **Negocio:** entradas vendidas y emitidas, validaciones por resultado y pagos fallidos;
- **Worker y RabbitMQ:** mensajes procesados, reintentados y en la DLQ, y correcciones del barrido.

Se provisiona desde [`observabilidad/`](observabilidad). Para verlo moverse: `npm run postman` o `npm run carga` con el stack arriba.

## 16. Endpoints principales

| Método y ruta | Scope / credencial | Descripción |
|---|---|---|
| `GET /health` | pública | Estado del servicio |
| `GET /metrics` | pública (red interna) | Métricas de Prometheus. No está en el contrato |
| `GET /token-info` | Bearer (cualquier scope) | Diagnóstico del token |
| `GET /eventos`, `GET /eventos/{id}` | `read:eventos` | Listar y obtener eventos |
| `POST /eventos`, `PATCH /eventos/{id}` | `write:eventos` | Crear, modificar y publicar eventos |
| `POST /eventos/{id}/cancelar` | `write:eventos` | Cancelar un evento: corta ventas y anula entradas |
| `DELETE /eventos/{id}` | `admin:eventos` | Eliminar un evento sin ventas |
| `POST /compras` | `buy:entradas` + `Idempotency-Key` | Paso 1: reservar cupo |
| `POST /compras/{id}/pagar` | `buy:entradas` + `Idempotency-Key` | Paso 2: solicitar el pago (202) |
| `POST /webhooks/pagos` | firma HMAC | Paso 3: resultado del pago |
| `GET /compras/{id}/entradas` | `buy:entradas` | Paso 4: entradas emitidas |
| `GET /compras`, `GET /compras/{id}`, `POST /compras/{id}/cancelar` | `buy:entradas` | Consultar y cancelar **las compras propias** (`creadaPor` = `sub` del token; una compra ajena responde 404) |
| `GET /entradas/{codigo}`, `POST /entradas/{codigo}/validar` | `validate:entradas` | Control de acceso. `validar` recibe `{ "eventoId": "…" }` (el evento de la puerta) |
| `GET /internal/reportes/ventas` | `x-api-key` | Reporte de ventas |

Ejemplo del paso 1, con sus ejemplos completos de respuesta en el contrato:

```bash
curl -s -X POST http://localhost:3000/compras \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: compra:ana-40123456:recital:0001' \
  -d '{"eventoId":"66f000000000000000000001","cantidad":2,"asistente":{"nombre":"Ana Pérez","email":"ana.perez@example.com","documento":"40123456"}}'
```

Repetir el mismo pedido con la misma clave devuelve la compra original con `Idempotency-Replayed: true`, sin reservar de nuevo. Los errores siempre tienen el formato `{ "error", "code", "retryable", "action", "details"? }` ([ADR 0001](docs/adr/adr-0001-estilo-api-rest.md)).

## 17. Decisiones técnicas

Stack: **Node.js 22 + Express 4 (CommonJS), MongoDB 7 + Mongoose 8, RabbitMQ 4.2 + amqplib, Auth0 + express-oauth2-jwt-bearer, pino, prom-client, Prometheus y Grafana**.

| ADR | Decisión |
|---|---|
| [0001](docs/adr/adr-0001-estilo-api-rest.md) | Estilo REST, acciones como sub-recurso, sin `/v1`, errores uniformes |
| [0002](docs/adr/adr-0002-rest-vs-grpc.md) | REST/JSON y no gRPC |
| [0003](docs/adr/adr-0003-mongodb-migraciones-seed.md) | MongoDB, migrate-mongo y seed idempotente |
| [0004](docs/adr/adr-0004-seguridad-auth0-scopes.md) | Auth0, scopes, 401/403, x-api-key |
| [0005](docs/adr/adr-0005-broker-rabbitmq.md) | RabbitMQ con retry, DLQ y deduplicación |
| [0006](docs/adr/adr-0006-webhook-pago-hmac.md) | Webhook de pago con HMAC |
| [0007](docs/adr/adr-0007-reserva-cupo-idempotencia.md) | Reserva de cupo atómica + Idempotency-Key |
| [0008](docs/adr/adr-0008-observabilidad-correlation-id.md) | Correlation ID, logs JSON y métricas |
| [0009](docs/adr/adr-0009-outbox-entrada-comprada.md) | Patrón outbox para publicar `entrada.comprada` |
| [0010](docs/adr/adr-0010-ciclo-de-vida-compra-pago-conciliacion.md) | Orden de `/pagar`, timeout de pago con conciliación y reconciliación de cupo |
| [0011](docs/adr/adr-0011-ciclo-de-vida-evento.md) | Estados del evento, fechas, cierre automático y cancelación con cascada |
| [0012](docs/adr/adr-0012-titularidad-trazabilidad-validacion.md) | `creadaPor`, idempotencia por cliente, asistente como snapshot y validación por evento |
| [0013](docs/adr/adr-0013-patrones-de-resiliencia.md) | Patrones de resiliencia: qué falla, qué patrón la cubre y por qué no hay circuit breaker |

## 18. Limitaciones conocidas y mejoras futuras

**Limitaciones del diseño:**

- Con `client_credentials` no hay usuario final: cada compra guarda `creadaPor` (el `sub` del cliente M2M) y un cliente solo ve las suyas, pero no hay "mis compras" por persona ([ADR 0012](docs/adr/adr-0012-titularidad-trazabilidad-validacion.md)).
- El asistente se identifica por DNI de 7 u 8 dígitos: no admite pasaportes ni documentos extranjeros. Cada compra conserva una copia (snapshot) de los datos informados.
- **Los listados no tienen paginación.** `GET /eventos` devuelve todos los eventos y fue lo primero que se notó en la prueba de carga: la latencia sube a medida que crece la base ([carga/README.md](carga/README.md)).
- Un token revocado en Auth0 sigue valiendo hasta su `exp` (la API valida la firma, no consulta a Auth0 en cada request); por eso el TTL es corto.
- `mongodb` y `rabbitmq` publican sus puertos en el host: MongoDB sin autenticación y RabbitMQ con credenciales de desarrollo (`iaew` / `iaew-local`). `GET /metrics` no se autentica y Grafana admite acceso anónimo de solo lectura. Es una configuración solo para uso local y no debe desplegarse así.
- El emisor OAuth local (`docker-compose.pruebas.yml`) es solo para pruebas: obliga a `NODE_ENV=development` en la API porque la librería de JWT rechaza un issuer `http://` en producción.
- Las reservas abandonadas retienen cupo hasta que vencen (`RESERVA_TTL_MINUTOS`, 15 minutos por defecto), y un pago pendiente hasta que llega el resultado o vence `PAGO_TIMEOUT_MINUTOS` (30 minutos).
- Si la pasarela cobra después de haber respondido "no conozco ese pago", la compra queda `expirada` con `reembolsoPendiente`: no hay reembolso real ([ADR 0010](docs/adr/adr-0010-ciclo-de-vida-compra-pago-conciliacion.md)).
- No hay circuit breaker sobre la pasarela (decisión analizada en el [ADR 0013](docs/adr/adr-0013-patrones-de-resiliencia.md)): con la pasarela colgada, `/pagar` espera hasta 5 s por intento y puede dejar la compra en `pago_pendiente` hasta reintentar con la misma `Idempotency-Key` o hasta que la conciliación la resuelva.
- No hay reembolsos: una compra `pagada` no se cancela. Si el evento se cancela, la compra queda con `reembolsoPendiente: true` y sus entradas `anuladas` ([ADR 0011](docs/adr/adr-0011-ciclo-de-vida-evento.md)).
- Una entrada validada justo cuando se cancela el evento puede quedar `usada`: la cascada anula solo las `emitida` (la validación ya rechaza lo posterior con `EVENT_NOT_ACTIVE`).
- La prueba de carga corrió con todo en una sola máquina y sin afinar nada (pool de MongoDB, procesos de la API, índices adicionales): sirve de punto de comparación, no mide capacidad.
- El apagado ordenado del `worker` con señales no se pudo comprobar en Windows (`kill` termina el proceso sin correr el manejador); en Linux y en Docker se comporta como se espera.

**Mejoras futuras:**

- Paginación de los listados.
- QR como imagen.
- Notificación por email.
- Despliegue en AWS Academy.
- Autenticar `/metrics` y quitar el acceso anónimo de Grafana fuera del uso local.
- Trazas distribuidas (OpenTelemetry → Jaeger) reutilizando el `correlationId`.

## 19. Versión de esta entrega

| Entrega | Tag | Commit |
|---|---|---|
| Entrega 1 — Diseño y esqueleto | `v1.0.0` | `9836280` |
| Entrega 2 — Implementación y defensa | `v2.0.0` | — |

El hash documentado corresponde al último commit de contenido de la entrega; el tag apunta al commit siguiente, que solo registra ese hash acá. El `.zip` subido a UV se genera desde el tag: `git archive --format=zip -o iaew-eventos-entradas-v2.0.0.zip v2.0.0`.

## Estructura del repositorio

```
docker-compose.yml         api, worker, mongodb, rabbitmq, db-init, pagos-mock, prometheus, grafana
docker-compose.pruebas.yml override solo para pruebas: emisor OAuth local en lugar de Auth0
Dockerfile                 imagen de api / worker / db-init
.env.example               variables de referencia (sin secretos)
migrate-mongo-config.js    configuración de migraciones
redocly.yaml               reglas del lint de OpenAPI
migrations/                migraciones versionadas (índices)
scripts/                   seed idempotente y emisor OAuth local para pruebas
src/
  app.js                   API Express
  worker.js                consumidor de entrada.comprada y barrido periódico
  db.js                    conexión Mongoose
  routes/                  eventos, compras, entradas, webhooks, internal
  services/                reglas de negocio: eventos, compras, pagos, entradas, emision, reporte
  lib/                     errores, config, validación contra el contrato, idempotencia, firma HMAC, RabbitMQ,
                           outbox, consumidor, barrido, pasarela, logger, métricas, contexto de correlación
  middleware/              Auth0 (JWT + scopes), x-api-key, webhook, correlación, observabilidad
  models/                  Evento, Asistente, Compra, Entrada, EventoProcesado
services/pagos-mock/       pasarela de pago simulada (Dockerfile propio, sin dependencias)
observabilidad/            configuración de Prometheus y Grafana (datasource y dashboard)
docs/                      C4, ADRs, OpenAPI, modelo de datos, eventos, guion de la demo
test/                      node --test (unitarias, API, integración con MongoDB y RabbitMQ)
postman/                   colección, ambientes y su generador
carga/                     plan de JMeter, runner, reporte y resumen de la prueba de carga
.github/workflows/         CI
```
