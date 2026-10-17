# Guion de la demo (15 minutos)

La demo tiene que mostrar el caso visible de la integración (el webhook de pago) y el efecto del flujo asincrónico (las entradas que aparecen). Los tiempos son una guía; lo que no puede faltar es el paso 3.

## Antes de empezar

```bash
docker compose down -v && docker compose up -d --build     # ~2 minutos: dejarlo listo antes
docker compose ps                                          # todo healthy, db-init "exited (0)"
```

Pestañas abiertas: [Swagger](http://localhost:3000/api-docs), [RabbitMQ](http://localhost:15672) (`iaew` / `iaew-local`, *Queues*), [Grafana](http://localhost:3001) y una terminal con `docker compose logs -f --no-log-prefix api worker pagos-mock`.

Variables de la terminal de trabajo (un token por rol, pedidos una sola vez; ver el [README, sección 7](../README.md#7-obtener-un-token-client_credentials)):

```bash
API=http://localhost:3000
EVENTO=66f000000000000000000001          # Recital de Rock Sinfónico (500 lugares)
JAZZ=66f000000000000000000002            # Charla de Jazz (2 lugares)
token() {  # token <client_id> <client_secret>
  curl -s -X POST "https://$AUTH0_DOMAIN/oauth/token" -H 'content-type: application/json' \
    -d "{\"client_id\":\"$1\",\"client_secret\":\"$2\",\"audience\":\"$AUTH0_AUDIENCE\",\"grant_type\":\"client_credentials\"}" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token'
}
T_ORG=$(token "$ID_ORGANIZADOR" "$SECRETO_ORGANIZADOR")
T_CANAL=$(token "$ID_CANAL" "$SECRETO_CANAL")
T_PUERTA=$(token "$ID_CONTROL" "$SECRETO_CONTROL")
campo() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }   # campo '.compra._id'
```

Si Auth0 no responde, el [emisor local](../README.md#7-obtener-un-token-client_credentials) entrega tokens con los mismos scopes: `docker compose -f docker-compose.yml -f docker-compose.pruebas.yml up -d` y `token()` apuntando a `http://localhost:4010/oauth/token`.

## 1. Arquitectura (1 min)

[C4 de contenedores](c4-container.md) y `docker compose ps`: `api`, `worker`, `mongodb`, `rabbitmq`, `pagos-mock`, `prometheus` y `grafana`. Decir qué es cada uno y que los nombres coinciden con el diagrama.

## 2. Seguridad (2 min)

```bash
curl -s $API/token-info -H "Authorization: Bearer $T_CANAL"            # iss, aud, scopes y vigencia
curl -i $API/eventos                                                    # 401 TOKEN_INVALID
curl -i -X POST $API/eventos -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' -d '{}'   # 403 SCOPE_REQUIRED
curl -i $API/internal/reportes/ventas                                   # 401 API_KEY_INVALID
curl -s $API/internal/reportes/ventas -H "x-api-key: $INTERNAL_API_KEY" # 200: la clave estática, solo como comparación
```

Mensaje: JWT con firma, issuer, audience, expiración y scope por endpoint; la `x-api-key` no reemplaza a OAuth.

## 3. La compra de punta a punta y el efecto asincrónico (4 min)

```bash
# Reservar 2 entradas (cupo atómico). La misma clave siempre devuelve la misma compra.
RESP=$(curl -s -X POST $API/compras -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo:ana:0001' \
  -d "{\"eventoId\":\"$EVENTO\",\"cantidad\":2,\"asistente\":{\"nombre\":\"Ana Pérez\",\"email\":\"ana.perez@example.com\",\"documento\":\"40123456\"}}")
COMPRA=$(echo "$RESP" | campo '.compra._id'); echo "$RESP"                 # estado: pendiente
curl -si -X POST $API/compras -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' -H 'Idempotency-Key: demo:ana:0001' \
  -d "{\"eventoId\":\"$EVENTO\",\"cantidad\":2,\"asistente\":{\"nombre\":\"Ana Pérez\",\"email\":\"ana.perez@example.com\",\"documento\":\"40123456\"}}" | grep -i "idempotency-replayed"   # true: no reservó de nuevo

# Pagar: responde 202 y el resultado llega por webhook
curl -si -X POST $API/compras/$COMPRA/pagar -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo:pago:0001' -H 'X-Correlation-Id: demo-0001' -d '{"escenario":"aprobado"}'

# El efecto: la compra queda pagada y las entradas pasan de [] a 2
curl -s $API/compras/$COMPRA -H "Authorization: Bearer $T_CANAL" | campo '.estado'            # pagada
curl -s $API/compras/$COMPRA/entradas -H "Authorization: Bearer $T_CANAL"                      # 2 entradas ENT-...
```

Mostrar mientras tanto:

- En la terminal de logs: `docker compose logs --no-log-prefix api worker pagos-mock | grep demo-0001` muestra la solicitud, el pago aprobado y las entradas emitidas con el **mismo `correlationId`**, de la `api` a la pasarela, al webhook y al worker.
- En RabbitMQ: `entradas.exchange` y `emision.entrada-comprada` con la actividad del mensaje; la DLQ vacía.
- El diagrama de secuencia de [c4-component.md](c4-component.md#secuencia-del-flujo-multi-paso): outbox, relay y consumidor idempotente.

Guardar `COMPRA` y el código de una entrada (`CODIGO=$(curl -s $API/compras/$COMPRA/entradas -H "Authorization: Bearer $T_CANAL" | campo '[0].codigo')`) para el paso 5.

## 4. Errores del dominio (2 min)

```bash
# Evento agotado: el Jazz tiene 2 lugares
curl -s -X POST $API/compras -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' -H 'Idempotency-Key: demo:jazz:0001' \
  -d "{\"eventoId\":\"$JAZZ\",\"cantidad\":2,\"asistente\":{\"nombre\":\"Ana Pérez\",\"email\":\"ana.perez@example.com\",\"documento\":\"40123456\"}}" | campo '.compra.estado'
curl -s -X POST $API/compras -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' -H 'Idempotency-Key: demo:jazz:0002' \
  -d "{\"eventoId\":\"$JAZZ\",\"cantidad\":1,\"asistente\":{\"nombre\":\"Luis Gómez\",\"email\":\"luis@example.com\",\"documento\":\"30111222\"}}"   # 409 EVENT_SOLD_OUT

# La misma clave con otro cuerpo: 409 IDEMPOTENCY_KEY_MISMATCH
curl -s -X POST $API/compras -H "Authorization: Bearer $T_CANAL" -H 'content-type: application/json' -H 'Idempotency-Key: demo:ana:0001' \
  -d "{\"eventoId\":\"$EVENTO\",\"cantidad\":5,\"asistente\":{\"nombre\":\"Ana Pérez\",\"email\":\"ana.perez@example.com\",\"documento\":\"40123456\"}}"
```

Pago rechazado: repetir el paso 3 con otra `Idempotency-Key` y `{"escenario":"rechazado"}`. La compra queda `rechazada` y `GET /eventos/$EVENTO` muestra que el cupo se devolvió. Todos los errores tienen el formato `{ error, code, retryable, action }`.

## 5. Control de acceso (2 min)

```bash
curl -s -X POST $API/entradas/$CODIGO/validar -H "Authorization: Bearer $T_PUERTA" -H 'content-type: application/json' -d "{\"eventoId\":\"$EVENTO\"}"   # acceso_permitido
curl -s -X POST $API/entradas/$CODIGO/validar -H "Authorization: Bearer $T_PUERTA" -H 'content-type: application/json' -d "{\"eventoId\":\"$EVENTO\"}"   # 409 TICKET_ALREADY_USED
curl -s -X POST $API/entradas/$CODIGO/validar -H "Authorization: Bearer $T_PUERTA" -H 'content-type: application/json' -d "{\"eventoId\":\"$JAZZ\"}"      # 409 TICKET_WRONG_EVENT (otra puerta)
```

La validación es una transición atómica: dos puertas a la vez no dejan entrar la misma entrada dos veces (hay una prueba con 20 puertas simultáneas).

## 6. Observabilidad (2 min)

En [Grafana](http://localhost:3001), con el dashboard *Eventos y Entradas*, mientras se corre `npm run postman` en otra terminal con el stack del emisor local, o un tramo corto de `npm run carga`:

- **p95**, **throughput** y **error rate** (arriba), y la latencia por ruta;
- entradas vendidas y emitidas, validaciones por resultado y pagos fallidos (negocio);
- mensajes del worker: ok, reintento y DLQ.

Resultado de la prueba de carga adjunta ([carga/README.md](../carga/README.md)): 6395 solicitudes, 0 errores, p95 total de 437 ms, y 450 pagos igual a 450 entradas emitidas, sin sobreventa.

## 7. Margen y preguntas (2 min)

Cualquiera de estas sirve si sobra tiempo o preguntan por la resiliencia:

- **Webhook perdido y conciliación:** `WEBHOOK_HABILITADO=false PAGO_TIMEOUT_MINUTOS=1 BARRIDO_INTERVALO_MS=5000 docker compose up -d`, pagar y esperar un minuto: el barrido consulta a la pasarela y la compra pasa a `pagada` ([ADR 0010](adr/adr-0010-ciclo-de-vida-compra-pago-conciliacion.md)). Volver a levantar sin esas variables.
- **Webhook inválido:** el paso `POST /webhooks/pagos` con una firma incorrecta responde 401, y repetido sobre una compra pagada responde 200 con `duplicado: true`. Está en la colección de Postman (carpeta 04).
- **RabbitMQ caído:** `docker compose stop rabbitmq`, pagar, `docker compose start rabbitmq`: la compra quedó `pagada` y las entradas aparecen solas cuando vuelve el broker (outbox).
- **Cancelar un evento con ventas:** `POST /eventos/{id}/cancelar` con el token del organizador corta las ventas al instante y la cascada anula las entradas y marca `reembolsoPendiente` ([ADR 0011](adr/adr-0011-ciclo-de-vida-evento.md)).
- **Resiliencia, el mapa completo:** [ADR 0013](adr/adr-0013-patrones-de-resiliencia.md), una tabla con cada falla, el patrón que la cubre y la prueba que lo comprueba. Las demos de arriba cubren tres: el webhook perdido (reintentos y conciliación), RabbitMQ caído (outbox) y el mensaje inválido en la DLQ (retry con espera + DLQ, [README, sección 13](../README.md#13-flujo-asincrónico-cómo-dispararlo-y-dónde-ver-el-efecto)). Si preguntan por qué no hay circuit breaker, la respuesta razonada está en ese ADR.
- **Limitaciones declaradas:** sin paginación, sin reembolsos reales, `/metrics` abierto en la red local ([README, sección 18](../README.md#18-limitaciones-conocidas-y-mejoras-futuras)).
