# Prueba de carga

Plan de JMeter ([`plan-carga.jmx`](plan-carga.jmx)), su generador, el script que lo corre y el reporte de la última corrida ([`reporte/`](reporte)).

## Escenario

Un canal de venta, repetido por cada hilo durante la duración indicada, con una espera de 100 a 400 ms entre pasos:

1. `GET /eventos`
2. `GET /eventos/{id}`
3. `POST /compras`, con una `Idempotency-Key` nueva en cada llamada
4. `GET /compras/{id}`
5. En el 30% de las iteraciones, `POST /compras/{id}/pagar`. Eso dispara la pasarela simulada, el webhook, el outbox, RabbitMQ y la emisión de entradas del worker, así que la carga también pasa por el flujo asincrónico.

Cada respuesta se verifica por su código HTTP (200, 201 o 202). El token del canal de venta se pide **una sola vez** y se reutiliza en toda la prueba, como haría un cliente real (un token por solicitud agotaría el cupo de tokens de Auth0).

## Cómo correrla

```bash
# Con el stack y el emisor OAuth local (no hace falta Auth0):
docker compose -f docker-compose.yml -f docker-compose.pruebas.yml up -d --build
HILOS=30 RAMPA=10 DURACION=90 node carga/ejecutar.js          # o: npm run carga
```

`ejecutar.js` pide los tokens, crea un evento con un millón de lugares (la prueba mide la API, no el agotamiento del cupo), corre JMeter en el contenedor `justb4/jmeter:5.5`, consulta a Prometheus lo que pasó durante la misma ventana y **cancela el evento al terminar**. Con Auth0 real: `TOKEN_CANAL` y `TOKEN_ORGANIZADOR`. Sin Docker: `SIN_DOCKER=1` con un `jmeter` instalado. El token viaja en un archivo temporal de propiedades y no como argumento, porque la imagen de JMeter imprime sus argumentos.

El plan se genera con `npm run carga:generar`; un test comprueba que el `.jmx` commiteado coincide con su generador.

## Última corrida

30 hilos, 10 s de rampa y 90 s de duración. API, worker, MongoDB, RabbitMQ y la pasarela en Docker Desktop sobre la misma máquina que corre JMeter. **No es una medición de capacidad:** sirve para ver que el sistema se sostiene y para tener un punto de comparación.

| Operación | Muestras | Errores | req/s | Promedio | p95 | p99 |
|---|---|---|---|---|---|---|
| `GET /eventos` | 1495 | 0 | 16,7 | 119 ms | 320 ms | 597 ms |
| `GET /eventos/{id}` | 1490 | 0 | 16,7 | 113 ms | 319 ms | 534 ms |
| `POST /compras` | 1484 | 0 | 16,7 | 210 ms | 555 ms | 1111 ms |
| `GET /compras/{id}` | 1476 | 0 | 16,7 | 115 ms | 298 ms | 591 ms |
| `POST /compras/{id}/pagar` | 450 | 0 | 5,1 | 278 ms | 739 ms | 1400 ms |
| **Total** | **6395** | **0** | **71,4** | **149 ms** | **437 ms** | **805 ms** |

Los objetivos que nos fijamos (la consigna no los impone) son **sin errores y p95 total por debajo de 500 ms**: se cumplen. Prometheus, en la misma ventana, midió un p95 máximo de 488 ms y 0 errores 5xx.

**Efecto asincrónico bajo carga.** Se pagaron 450 compras y el sistema vendió, procesó y emitió exactamente 450: `entradas_vendidas`, `mensajes_ok` y `entradas_emitidas` crecieron 450, sin reintentos ni mensajes en la DLQ. Al terminar, comprobado en la base:

- 450 entradas emitidas, 450 eventos procesados y ningún código de entrada repetido;
- ninguna `Idempotency-Key` repetida entre las 1484 compras;
- `capacidad − cupoDisponible` = 1484 = compras pagadas + compras reservadas que canceló el evento: ni sobreventa ni cupo perdido;
- las colas `emision.entrada-comprada`, `.retry` y `.dlq` quedaron vacías.

## Qué se observó

- **La latencia sube de una corrida a otra.** En una corrida anterior con el mismo escenario el p95 total fue de 338 ms y en esta de 437 ms. Cada corrida deja un evento más y miles de compras en la base, y `GET /eventos` no tiene paginación: devuelve todos los eventos. Es una limitación conocida del diseño ([README](../README.md), limitaciones) y la primera mejora a hacer si el listado crece.
- **Lo más lento es lo que escribe más.** `POST /compras/{id}/pagar` (738 ms de p95) hace dos escrituras y una llamada HTTP a la pasarela, y `POST /compras` (555 ms) hace la reserva atómica, el alta del asistente y el de la compra.
- **No se afinó nada** (pool de conexiones de MongoDB, número de procesos de la API, índices adicionales). Con 30 hilos en una sola máquina el margen respecto del objetivo es chico: un p95 de 437 ms contra 500 ms.

## Archivos

| Archivo | Contenido |
|---|---|
| [`reporte/html/index.html`](reporte/html/index.html) | Dashboard HTML de JMeter: latencia en el tiempo, percentiles, throughput y errores por operación |
| [`reporte/resumen.json`](reporte/resumen.json) | Estadísticas por operación, lo que midió Prometheus en la ventana y si se cumplieron los objetivos |
| `reporte/resultados.jtl` | Resultados crudos de cada muestra. No se commitea (se regenera en cada corrida) |
