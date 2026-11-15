const http = require('node:http');
const crypto = require('node:crypto');

const base64url = (valor) => Buffer.from(typeof valor === 'string' ? valor : JSON.stringify(valor)).toString('base64url');

// Emisor OAuth falso para las pruebas: publica el discovery y el JWKS por http y firma access
// tokens RS256, de modo que la API los valida con la misma ruta de código que usa con Auth0.
// Se usa con AUTH0_ISSUER_URL (ver src/lib/config.js).
async function crearEmisor({ audience = 'https://iaew-eventos-api' } = {}) {
  const claves = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'clave-de-prueba';
  let url;

  const servidor = http.createServer((req, res) => {
    const responder = (cuerpo) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
    if (req.url === '/.well-known/openid-configuration') return responder({ issuer: url, jwks_uri: `${url}/jwks.json` });
    if (req.url === '/jwks.json') return responder({ keys: [{ ...claves.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    res.writeHead(404); return res.end();
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${servidor.address().port}`;

  // `privateKey` permite firmar con otra clave y comprobar que la firma se rechaza.
  function token({ scope = '', sub = 'cliente-de-prueba@clients', aud = audience, iss = url, expiraEnSegundos = 3600, privateKey = claves.privateKey } = {}) {
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = base64url({ alg: 'RS256', typ: 'JWT', kid });
    const carga = base64url({ iss, sub, aud, scope, iat: ahora, exp: ahora + expiraEnSegundos });
    const firma = crypto.sign('RSA-SHA256', Buffer.from(`${cabecera}.${carga}`), privateKey).toString('base64url');
    return `${cabecera}.${carga}.${firma}`;
  }

  return {
    url,
    audience,
    token,
    close: () => new Promise((resolve) => servidor.close(resolve))
  };
}

module.exports = { crearEmisor };
