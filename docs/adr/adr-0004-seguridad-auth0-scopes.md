# ADR 0004 — Seguridad: Auth0 con client_credentials, scopes por operación y x-api-key como comparación

- Estado: aceptada
- Fecha: 2026-10-03

## Contexto

La consigna exige OAuth 2.0 con JWT:

- Authorization Server con API, audience, issuer, scopes y un cliente Machine to Machine.
- Flujo `client_credentials`.
- Un Resource Server que valide firma, issuer, audience, expiración y scopes.
- Un endpoint con `x-api-key` como comparación, no como reemplazo.
- Ningún secreto en el repositorio.

Además, el webhook de la pasarela necesita su propia autenticación, porque la pasarela no es un cliente OAuth.

## Decisión

1. **Authorization Server: Auth0.** API con identifier y audience `https://iaew-eventos-api`, firma RS256. Cada rol de cliente es una aplicación Machine to Machine autorizada con sus scopes.
2. **Resource Server: `express-oauth2-jwt-bearer`** (`auth()` + `requiredScopes()`), la librería oficial de Auth0 para Express. La librería valida firma contra el JWKS de `https://AUTH0_DOMAIN/`, `iss`, `aud`, `exp` y `nbf`.
3. **Scopes:**

   | Scope | Operaciones |
   |---|---|
   | `read:eventos` | `GET /eventos`, `GET /eventos/{id}` |
   | `write:eventos` | `POST /eventos`, `PATCH /eventos/{id}`, `POST /eventos/{id}/cancelar` |
   | `admin:eventos` | `DELETE /eventos/{id}` |
   | `buy:entradas` | `POST/GET /compras`, `GET /compras/{id}`, `/pagar`, `/cancelar`, `GET /compras/{id}/entradas` |
   | `validate:entradas` | `GET /entradas/{codigo}`, `POST /entradas/{codigo}/validar` |

   Clientes M2M de la demo: **organizador** (`read`, `write`, `admin:eventos`), **canal de venta** (`read:eventos`, `buy:entradas`) y **control de acceso** (`validate:entradas`).
4. **401 vs 403:** 401 `TOKEN_INVALID` cuando falta el token o es inválido o expiró. 403 `SCOPE_REQUIRED` cuando el token es válido pero le falta el scope. Una cabecera `Authorization` mal formada (esquema distinto de Bearer, o dos credenciales) también es 401: la librería la reporta como 400 `invalid_request`, pero la acción del cliente es la misma. Los 401 incluyen `WWW-Authenticate: Bearer realm="api"`.
5. **x-api-key** solo en `GET /internal/reportes/ventas`. Se compara con `INTERNAL_API_KEY` y responde 401 `API_KEY_INVALID`. No se combina con OAuth ni se documenta como alternativa al Bearer: sirve para comparar los dos modelos (la clave es estática, no expira, no tiene scopes y no identifica al cliente).
6. **Webhook:** firma HMAC-SHA256 con secreto compartido y timestamp ([ADR 0006](adr-0006-webhook-pago-hmac.md)).
7. **Secretos:** solo en `.env` (ignorado por git). `.env.example` tiene nombres y valores ficticios. `AUTH0_CLIENT_SECRET` lo usan solo los clientes para pedir tokens; la API nunca lo necesita.
8. **`GET /token-info`** (sin scope) para diagnosticar `iss`, `aud`, `sub` y `scope` del token durante la configuración. También muestra `issuedAt`, `expiresAt` y `expiresInSeconds`, para comprobar la vigencia.
9. **Expiración de los tokens.** El TTL del access token lo fija Auth0 (*APIs → IAEW Eventos API → Settings → Token Expiration*, 3600 s en este proyecto; por defecto son 86400 s). La API valida `exp` y responde `401 TOKEN_INVALID` con un token vencido, sin periodo de gracia. Los clientes M2M deben reutilizar el token hasta que se acerque a `exp` y recién ahí pedir uno nuevo: Auth0 puede limitar la emisión de tokens M2M según el plan, y pedir uno por request es lento y desperdicia cuota.

## Consecuencias

- Permisos mínimos por rol: el control de acceso no puede comprar y el canal de venta no puede modificar eventos.
- La API no guarda credenciales de clientes. Revocar un cliente se hace en Auth0.
- Un token revocado en Auth0 sigue siendo válido hasta su `exp` (la API valida la firma y no consulta a Auth0 en cada request). Por eso conviene un TTL corto, y eso queda como limitación.
- En `client_credentials` no hay usuario final. Cada compra guarda `creadaPor` (el `sub` del token) y un cliente solo ve y opera las suyas; no hay "mis compras" por persona, y eso queda como limitación ([ADR 0012](adr-0012-titularidad-trazabilidad-validacion.md)).
- Hace falta una cuenta de Auth0 para probar los endpoints protegidos. Los pasos están en el README.

## Alternativas descartadas

- **JWT firmados por la propia API (HS256):** mezcla el Authorization Server con el Resource Server y no cumple el requisito de un servidor de autorización.
- **Roles en lugar de scopes:** Auth0 M2M otorga scopes de forma nativa. Los roles requieren reglas o acciones adicionales.
- **Proteger el webhook con OAuth:** la pasarela es un tercero que firma sus notificaciones. Es el modelo habitual de Stripe, GitHub y otros.
