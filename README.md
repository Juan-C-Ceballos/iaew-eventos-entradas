# TPI IAEW 2026 — Eventos y Entradas

Trabajo Práctico Integrador de la cátedra **Integración de Aplicaciones en Entornos Web** (UTN FRC, 2026).

> **Estado actual:** proyecto en fase de arranque — sin implementación aún. Este README documenta la consigna completa para que el equipo pueda planificar el trabajo.

Consigna original: https://utn-frc-iaew.github.io/iaew-2026-ecommerce-api/tpi/index.html#entregas

## Integrantes

- Juan Cruz Ceballos - 94239
- Marinangeli Mateo - 97179
- Santino Magris - 91999
- Mateo Estrada Uriz - 95556

## Dominio: Eventos y Entradas

CRUD de **eventos** y **compras**, con validación de disponibilidad y pago. Ejemplo de flujo multi-paso: reservar entradas para un evento, validar cupo disponible y confirmar la compra con pago.

## Alcance mínimo obligatorio

- API REST sobre HTTP con contrato **OpenAPI 3.1**
- CRUD de dos entidades (p. ej. eventos y compras/entradas)
- Una transacción multi-paso (p. ej. reserva → validación de disponibilidad → confirmación de pago)
- **OAuth 2.0 + JWT** con scopes/roles
- Flujo asincrónico productor → broker → consumidor (RabbitMQ, Kafka, SQS, EventBridge o equivalente)
- Una integración adicional: **Webhook**, **gRPC** o **WebSocket**
- Docker por servicio + **Docker Compose** funcional
- Logs en formato JSON + dashboard (p95, throughput, error rate)
- Postman collection + prueba de carga (JMeter o Postman)
- README reproducible + demo presencial

## Fechas de entrega

| Entrega | Fecha | Contenido |
|---|---|---|
| **Entrega 1** | 28/09/2026 | Diseño y esqueleto: diagramas C4 (Context/Container/Component), ADRs, contrato OpenAPI 3.1, modelo de datos y estrategia de migraciones, Docker Compose inicial, tag `v1.0.0` y README básico |
| **Entrega 2** | 16/11/2026 | Implementación, pruebas y defensa (15 min): código operativo completo, sistema levantado con Docker Compose, tag `v1.0.0` con último commit hash, `.zip` subido a UV/Moodle |

## Checklist de requisitos técnicos

### Seguridad
- [ ] Authorization Server (Auth0 o equivalente)
- [ ] Flow `client_credentials` para obtener Bearer token
- [ ] Resource Server: validar firma, issuer, audience, expiración y scopes
- [ ] Mínimo 4 scopes definidos (ej: `read:eventos`, `write:eventos`, `confirm:compras`, `admin:eventos`)
- [ ] Endpoint adicional protegido con `x-api-key` (comparación, no reemplazo del OAuth)
- [ ] Sin credenciales reales commiteadas al repositorio

### Base de datos
- [ ] Motor SQL o NoSQL (a definir por el equipo)
- [ ] Migraciones o seed reproducibles
- [ ] Validación de entrada y manejo de errores estructurado

### Asincronía
- [ ] Broker de mensajes elegido (RabbitMQ, Kafka, SQS, EventBridge o equivalente aprobado)
- [ ] Patrón productor → broker → consumidor implementado
- [ ] Efecto visible en la demo

### Integración adicional (elegir una)
- [ ] Webhook (con firma/secreto compartido), o
- [ ] gRPC (con proto/stub definido), o
- [ ] WebSocket (con stream/suscripción)

### Operación y observabilidad
- [ ] Docker por servicio + compose funcional
- [ ] Logs en formato JSON
- [ ] Dashboard con métricas: latencia p95, throughput, error rate
- [ ] Correlation ID para trazabilidad
- [ ] Postman collection con variables/ambientes
- [ ] Prueba de carga (JMeter o Postman) con reporte adjunto

## Criterios de evaluación (10 puntos totales)

| Criterio | Puntaje | Qué se observa |
|---|---|---|
| Funcionalidad end-to-end | 2.5 | CRUD, flujo multi-paso, asincronía e integración operativos |
| Diseño y arquitectura | 2.5 | Diagramas C4, coherencia despliegue-código, ADRs |
| API y seguridad | 1.5 | Contrato, HTTP codes, OAuth 2.0/JWT, scopes, protección |
| Observabilidad y pruebas | 1.5 | Dashboard, logs correlacionables, Postman ejecutable, carga |
| README y reproducibilidad | 2.0 | Exhaustivo, Docker Compose punta a punta, versión y commit |

**Aprobación:** 6/10 o superior, con demo defendible y ejecución reproducible.

## Bonus optativo (sin penalización si no se incluye)

- Despliegue en AWS Academy u entorno aprobado
- BFF/GraphQL además de REST
- Observabilidad avanzada (OpenTelemetry → Jaeger/Grafana)
- CI: linters, tests y Newman automáticos

## Estructura del repositorio

```
/README.md              # este archivo
/docs/                  # diagramas C4, ADRs, contrato OpenAPI 3.1, diagramas de flujo asincrónico
/postman/                # collection de Postman y reporte de prueba de carga
/tests/                  # suite de pruebas unitarias/integración
.env.example             # variables de entorno de referencia (sin valores reales)
docker-compose.yml        # orquestación de servicios (a completar en Entrega 1)
package.json               # proyecto Node.js
.gitignore
```

## Cómo empezar

El runtime es **Node.js** (`package.json` ya inicializado). El resto del stack (framework, DB, broker de mensajes, proveedor OAuth) todavía no está definido por el equipo. Antes de escribir código:

1. Elegir el resto del stack (framework, DB, broker de mensajes, proveedor OAuth)
2. Definir diagramas C4 y ADRs en `docs/`
3. Diseñar el contrato OpenAPI 3.1 en `docs/`
4. Completar `.env.example` con las variables reales que use el proyecto
5. Completar `docker-compose.yml` con los servicios definidos
6. Correr `npm install` para instalar dependencias a medida que se agreguen

## Notas

- Repositorio de equipo (3-5 integrantes), se recomienda mantenerlo privado
- No commitear secretos ni credenciales reales — usar siempre `.env.example`
- Cada entrega requiere tag `v1.0.0` y el hash del último commit documentado acá
