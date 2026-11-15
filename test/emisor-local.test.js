const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarEmisorLocal, CLIENTES_POR_DEFECTO } = require('../scripts/emisor-local');

// El emisor local reemplaza a Auth0 en las pruebas y en CI: tiene que hablar como Auth0 y la API
// tiene que aceptar sus tokens por la misma ruta de validación (firma, issuer, audience, scopes).
let emisor;
let server;
let base;

before(async () => {
  emisor = await iniciarEmisorLocal({ port: 0 });
  process.env.AUTH0_ISSUER_URL = emisor.issuer;
  process.env.AUTH0_AUDIENCE = emisor.audience;
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await emisor.close();
});

const pedirToken = (cuerpo) => fetch(`${emisor.issuer}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
const credenciales = (cliente) => ({ client_id: cliente, client_secret: CLIENTES_POR_DEFECTO[cliente].secret, audience: emisor.audience, grant_type: 'client_credentials' });

test('publica el discovery y el JWKS que usa la API para validar la firma', async () => {
  const discovery = await (await fetch(`${emisor.issuer}/.well-known/openid-configuration`)).json();
  assert.deepEqual([discovery.issuer, discovery.jwks_uri], [emisor.issuer, `${emisor.issuer}/jwks.json`]);
  const { keys } = await (await fetch(discovery.jwks_uri)).json();
  assert.equal(keys.length, 1);
  assert.deepEqual([keys[0].kty, keys[0].alg, keys[0].use], ['RSA', 'RS256', 'sig']);
  assert.equal('d' in keys[0], false, 'la clave privada no se publica');
});

test('client_credentials entrega un token con el formato de Auth0 y los scopes del rol', async () => {
  for (const [cliente, { scope }] of Object.entries(CLIENTES_POR_DEFECTO)) {
    const res = await pedirToken(credenciales(cliente));
    assert.equal(res.status, 200, cliente);
    const cuerpo = await res.json();
    assert.deepEqual([cuerpo.token_type, cuerpo.expires_in, cuerpo.scope], ['Bearer', 3600, scope]);
    const carga = JSON.parse(Buffer.from(cuerpo.access_token.split('.')[1], 'base64url').toString());
    assert.deepEqual([carga.iss, carga.aud, carga.sub, carga.scope], [emisor.issuer, emisor.audience, `${cliente}@clients`, scope]);
    assert.equal(carga.exp - carga.iat, 3600);
  }
});

test('rechaza como Auth0: secreto incorrecto o cliente inexistente 401, audience sin grant 403, grant no soportado 400', async () => {
  const malSecreto = await pedirToken({ ...credenciales('organizador-local'), client_secret: 'otro' });
  assert.equal(malSecreto.status, 401);
  assert.equal((await malSecreto.json()).error, 'access_denied');
  assert.equal((await pedirToken({ ...credenciales('organizador-local'), client_id: 'no-existe' })).status, 401);
  assert.equal((await pedirToken({ ...credenciales('organizador-local'), client_id: 'constructor' })).status, 401, 'no se confunde con propiedades heredadas');
  assert.equal((await pedirToken({ ...credenciales('organizador-local'), client_secret: undefined })).status, 401);

  const otraAudience = await pedirToken({ ...credenciales('organizador-local'), audience: 'https://otra-api' });
  assert.equal(otraAudience.status, 403);
  assert.match((await otraAudience.json()).error_description, /not authorized to access "https:\/\/otra-api"/);

  const otroGrant = await pedirToken({ ...credenciales('organizador-local'), grant_type: 'password' });
  assert.equal(otroGrant.status, 400);
  const jsonRoto = await fetch(`${emisor.issuer}/oauth/token`, { method: 'POST', body: '{roto' });
  assert.equal(jsonRoto.status, 400);
});

test('la API acepta el token del emisor local y respeta los scopes de cada rol', async () => {
  const token = async (cliente) => (await (await pedirToken(credenciales(cliente))).json()).access_token;
  const con = (t, ruta) => fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${t}` } });

  const info = await (await con(await token('canal-venta-local'), '/token-info')).json();
  assert.deepEqual([info.issuer, info.subject, info.scopes], [emisor.issuer, 'canal-venta-local@clients', 'read:eventos buy:entradas']);

  assert.equal((await con(await token('control-acceso-local'), '/eventos')).status, 403, 'control de acceso no lee eventos');
  assert.equal((await con(await token('canal-venta-local'), '/entradas/ENT-7K2M9Q4XA1B3')).status, 403, 'el canal de venta no valida entradas');
});

test('docker-compose.pruebas.yml reemplaza a Auth0 solo para pruebas y habilita el issuer http en la api', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.pruebas.yml'), 'utf8');
  assert.match(compose, /^ {2}emisor-local:/m);
  assert.match(compose, /EMISOR_ISSUER: http:\/\/emisor-local:4010/);
  assert.match(compose, /AUTH0_ISSUER_URL: http:\/\/emisor-local:4010/);
  assert.match(compose, /NODE_ENV: development/);
  const principal = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.equal(principal.includes('emisor-local'), false, 'el compose principal no incluye el emisor de pruebas');
});
