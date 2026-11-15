// Emisor OAuth 2.0 local, solo para pruebas y CI. Reemplaza a Auth0 donde no hay un tenant: publica el
// discovery y el JWKS, y entrega access tokens RS256 por `client_credentials` en POST /oauth/token, con
// el mismo formato de pedido y de respuesta que Auth0. La API los valida con la misma ruta de código
// que usa con Auth0 (firma, issuer, audience, expiración y scopes); lo único que cambia es de dónde
// salen las claves públicas (AUTH0_ISSUER_URL).
//
// NO es un sistema de autenticación: las credenciales de abajo son valores de prueba y la clave de
// firma se genera en memoria en cada arranque. Nunca usarlo fuera de pruebas.
//
//   node scripts/emisor-local.js        (PORT, EMISOR_ISSUER, AUTH0_AUDIENCE y EMISOR_CLIENTES opcionales)
const http = require('node:http');
const crypto = require('node:crypto');

// Un cliente por rol, con los scopes que le da el README (sección de Auth0).
const CLIENTES_POR_DEFECTO = {
  'organizador-local': { secret: 'secreto-organizador-local', scope: 'read:eventos write:eventos admin:eventos' },
  'canal-venta-local': { secret: 'secreto-canal-venta-local', scope: 'read:eventos buy:entradas' },
  'control-acceso-local': { secret: 'secreto-control-acceso-local', scope: 'validate:entradas' }
};

const base64url = (valor) => Buffer.from(typeof valor === 'string' ? valor : JSON.stringify(valor)).toString('base64url');

function leerJson(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      try { resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

// Compara en tiempo constante, como cualquier verificación de secretos.
function secretosIguales(recibido, esperado) {
  const hash = (valor) => crypto.createHash('sha256').update(String(valor)).digest();
  return crypto.timingSafeEqual(hash(recibido), hash(esperado));
}

async function iniciarEmisorLocal({
  port = 4010, issuer, audience = 'https://iaew-eventos-api', clientes = CLIENTES_POR_DEFECTO, ttlSegundos = 3600, log = () => {}
} = {}) {
  const claves = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'emisor-local';
  let issuerEfectivo = issuer;

  const responder = (res, status, cuerpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(cuerpo));
  };

  function firmarToken({ sub, scope }) {
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = base64url({ alg: 'RS256', typ: 'JWT', kid });
    const carga = base64url({ iss: issuerEfectivo, sub, aud: audience, scope, iat: ahora, exp: ahora + ttlSegundos, gty: 'client-credentials' });
    const firma = crypto.sign('RSA-SHA256', Buffer.from(`${cabecera}.${carga}`), claves.privateKey).toString('base64url');
    return `${cabecera}.${carga}.${firma}`;
  }

  // Los errores de /oauth/token imitan los de Auth0 para que un cliente no note la diferencia.
  async function emitirToken(req, res) {
    let cuerpo;
    try { cuerpo = await leerJson(req); } catch { return responder(res, 400, { error: 'invalid_request', error_description: 'Cuerpo JSON inválido' }); }
    if (cuerpo.grant_type !== 'client_credentials') {
      return responder(res, 400, { error: 'unsupported_grant_type', error_description: 'Solo se admite client_credentials' });
    }
    const cliente = Object.hasOwn(clientes, cuerpo.client_id) ? clientes[cuerpo.client_id] : undefined;
    if (!cliente || typeof cuerpo.client_secret !== 'string' || !secretosIguales(cuerpo.client_secret, cliente.secret)) {
      return responder(res, 401, { error: 'access_denied', error_description: 'Unauthorized' });
    }
    if (cuerpo.audience !== audience) {
      return responder(res, 403, { error: 'access_denied', error_description: `Client is not authorized to access "${cuerpo.audience}". You might probably want to create a "client-grant" associated to this API.` });
    }
    log(`token emitido para ${cuerpo.client_id}`);
    return responder(res, 200, {
      access_token: firmarToken({ sub: `${cuerpo.client_id}@clients`, scope: cliente.scope }),
      scope: cliente.scope, expires_in: ttlSegundos, token_type: 'Bearer'
    });
  }

  const servidor = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://emisor-local');
    if (req.method === 'GET' && pathname === '/.well-known/openid-configuration') {
      return responder(res, 200, { issuer: issuerEfectivo, jwks_uri: `${issuerEfectivo}/jwks.json`, token_endpoint: `${issuerEfectivo}/oauth/token` });
    }
    if (req.method === 'GET' && pathname === '/jwks.json') {
      return responder(res, 200, { keys: [{ ...claves.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    }
    if (req.method === 'POST' && pathname === '/oauth/token') {
      return emitirToken(req, res).catch(() => responder(res, 500, { error: 'server_error' }));
    }
    return responder(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve, reject) => { servidor.once('error', reject); servidor.listen(port, resolve); });
  const puerto = servidor.address().port;
  issuerEfectivo ??= `http://127.0.0.1:${puerto}`;
  return {
    port: puerto,
    issuer: issuerEfectivo,
    audience,
    // Cierra también las conexiones keep-alive que dejan los clientes (la librería de JWT reutiliza la suya).
    close: () => new Promise((resolve) => { servidor.close(resolve); servidor.closeAllConnections(); })
  };
}

module.exports = { iniciarEmisorLocal, CLIENTES_POR_DEFECTO };

if (require.main === module) {
  const port = Number(process.env.PORT || 4010);
  iniciarEmisorLocal({
    port,
    issuer: process.env.EMISOR_ISSUER || `http://localhost:${port}`,
    audience: process.env.AUTH0_AUDIENCE || 'https://iaew-eventos-api',
    clientes: process.env.EMISOR_CLIENTES ? JSON.parse(process.env.EMISOR_CLIENTES) : CLIENTES_POR_DEFECTO,
    log: (mensaje) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'emisor-local', msg: mensaje }))
  }).then((emisor) => {
    console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'emisor-local', msg: 'Emisor OAuth local (solo pruebas)', port: emisor.port, issuer: emisor.issuer, audience: emisor.audience }));
  }).catch((error) => { console.error('No se pudo iniciar el emisor local:', error.message); process.exit(1); });
}
