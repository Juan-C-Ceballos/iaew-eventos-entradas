# C4 — Nivel 1: Contexto del sistema de Eventos y Entradas

**Alcance:** el sistema como caja negra, las personas o sistemas que lo usan y las dependencias externas. No muestra detalles internos (ver [Container](c4-container.md)).

```mermaid
flowchart LR
  organizador["Organizador de eventos<br/><i>[Persona]</i><br/>Publica y administra eventos"]
  canal["Canal de venta<br/><i>[Sistema cliente M2M]</i><br/>Vende entradas a los asistentes"]
  acceso["Control de acceso<br/><i>[Sistema cliente M2M]</i><br/>Lector de QR en la puerta"]
  backoffice["Herramienta interna<br/><i>[Script de reportes]</i>"]

  sistema["<b>Sistema de Eventos y Entradas</b><br/><i>[Sistema de software]</i><br/>Publica eventos, vende entradas<br/>con reserva de cupo, emite y valida entradas"]

  auth0["Auth0<br/><i>[Sistema externo]</i><br/>Authorization Server OAuth 2.0"]
  pasarela["Pasarela de pago<br/><i>[Sistema externo, simulado]</i><br/>Cobra y notifica el resultado"]

  organizador -->|"Crea, publica y cancela eventos<br/>HTTPS/JSON + Bearer JWT"| sistema
  canal -->|"Reserva, paga y consulta compras<br/>HTTPS/JSON + Bearer JWT"| sistema
  acceso -->|"Valida entradas en el ingreso<br/>HTTPS/JSON + Bearer JWT"| sistema
  backoffice -->|"Consulta el reporte de ventas<br/>HTTPS/JSON + x-api-key"| sistema

  organizador -.->|"Obtiene access token<br/>client_credentials"| auth0
  canal -.->|"Obtiene access token<br/>client_credentials"| auth0
  acceso -.->|"Obtiene access token<br/>client_credentials"| auth0

  sistema -->|"Valida firma de tokens (JWKS)<br/>HTTPS"| auth0
  sistema -->|"Solicita el cobro de una compra<br/>HTTPS/JSON"| pasarela
  pasarela -->|"Notifica pago aprobado o rechazado<br/>Webhook HTTPS + firma HMAC"| sistema
```

**Leyenda:** rectángulo = persona o sistema (el sistema propio es el que está en **negrita**; los demás son clientes o sistemas externos) · flecha continua = el origen inicia una llamada hacia el destino · **flecha punteada = obtención del token**, previa al uso de la API.

## Elementos

| Elemento | Tipo | Responsabilidad | Scopes / credencial |
|---|---|---|---|
| Organizador de eventos | Persona (vía cliente M2M) | Alta, modificación, publicación y baja de eventos | `read:eventos`, `write:eventos`, `admin:eventos` |
| Canal de venta | Sistema cliente | Ejecuta el flujo de compra en nombre del asistente | `read:eventos`, `buy:entradas` |
| Control de acceso | Sistema cliente | Consulta y valida entradas en la puerta | `validate:entradas` |
| Herramienta interna | Script | Lee métricas de ventas | `x-api-key` (comparación, no OAuth) |
| Sistema de Eventos y Entradas | Sistema propio | Ver [Container](c4-container.md) | — |
| Auth0 | Externo | Emite tokens JWT RS256 con audience `https://iaew-eventos-api` | — |
| Pasarela de pago | Externo (simulado por `pagos-mock`) | Cobra y avisa el resultado por webhook firmado | Secreto compartido `WEBHOOK_SECRET` |

En la demo, cada cliente M2M es una aplicación Machine to Machine de Auth0 con los scopes de su rol, usada desde Postman o curl.
