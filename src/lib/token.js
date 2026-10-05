// Resumen de un access token ya validado, para GET /token-info. Muestra cuándo vence para
// poder comprobar el TTL configurado en Auth0 y el comportamiento al expirar (ADR 0004).
function describirToken(payload, ahoraMs = Date.now()) {
  const aIso = (segundos) => (Number.isFinite(segundos) ? new Date(segundos * 1000).toISOString() : undefined);
  const restante = Number.isFinite(payload.exp) ? Math.max(0, Math.floor(payload.exp - ahoraMs / 1000)) : undefined;
  return {
    issuer: payload.iss,
    audience: payload.aud,
    subject: payload.sub,
    scopes: payload.scope,
    issuedAt: aIso(payload.iat),
    expiresAt: aIso(payload.exp),
    expiresInSeconds: restante
  };
}

module.exports = { describirToken };
