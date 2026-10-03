# ADR 0002 — REST sobre HTTP/JSON para la API pública en lugar de gRPC

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

La consigna exige una API REST con contrato OpenAPI 3.1 y permite gRPC como integración adicional. Un "validador de entradas" interno sería un candidato natural para gRPC. Tenemos que decidir qué protocolo usa la API pública y si alguna comunicación interna justifica gRPC.

Quienes consumen la API son clientes M2M heterogéneos, Postman, Swagger UI y una pasarela de pago que llama por webhook. El tráfico de la demo es bajo y la latencia no es crítica. La demo y la prueba de carga se hacen con Postman o JMeter.

## Decisión

- **Toda la API pública es REST sobre HTTP/1.1 con JSON**, descrita en `docs/openapi.json` y protegida con Bearer JWT.
- **No se usa gRPC.** La integración adicional elegida es el webhook de pago ([ADR 0006](adr-0006-webhook-pago-hmac.md)).
- La validación de entradas en la puerta es un endpoint REST (`POST /entradas/{codigo}/validar`) con scope `validate:entradas`.

## Consecuencias

- Un solo estilo, un solo contrato y una sola forma de autenticar a los clientes. Postman, Newman y JMeter funcionan sin plugins.
- Los clientes pueden probar desde el navegador (Swagger UI) o con curl. Eso ayuda a la reproducibilidad, que vale 2 puntos en la rúbrica.
- Se resigna la eficiencia de Protobuf y el streaming de HTTP/2, que no aportan valor con este volumen.
- Si más adelante el control de acceso necesitara latencia muy baja o streaming, se podría agregar un servicio gRPC interno sin cambiar el contrato REST, con un ADR nuevo.

## Alternativas descartadas

- **gRPC para la API pública:** no hay soporte nativo en navegadores (necesita gRPC-Web y un proxy), las herramientas de prueba que usamos (Postman/JMeter) están pensadas para HTTP/JSON y no cumpliría el requisito de OpenAPI 3.1.
- **gRPC como integración adicional (validador de entradas):** agrega un contenedor, un `.proto`, generación de stubs y otro esquema de seguridad. El webhook de pago encaja mejor en el flujo multi-paso y en el error "pago rechazado" que pide el dominio.
- **GraphQL/BFF:** es un optativo con bonus. Queda fuera del alcance de la Entrega 1.
