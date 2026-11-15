const { test } = require('node:test');
const assert = require('node:assert/strict');
const { erroresDe, validarCuerpo } = require('../src/lib/validar');
const { asyncHandler, validarId } = require('../src/lib/http');

const eventoValido = { nombre: 'Recital', fecha: '2030-01-01T21:00:00.000Z', lugar: 'Córdoba', capacidad: 10, precio: 100 };
const compraValida = { eventoId: '66f000000000000000000001', cantidad: 2, asistente: { nombre: 'Ana', email: 'ana@example.com', documento: '40123456' } };

function respuestaFalsa() {
  const res = { status(codigo) { res.codigo = codigo; return res; }, json(cuerpo) { res.cuerpo = cuerpo; return res; } };
  return res;
}

test('un evento válido no tiene errores', () => {
  assert.equal(erroresDe('EventoCrear', eventoValido), null);
});

test('los errores se informan por campo, en el formato details del contrato', () => {
  const { nombre, ...sinNombre } = eventoValido;
  assert.deepEqual(erroresDe('EventoCrear', { ...sinNombre, capacidad: 0, extra: 1 }), {
    nombre: 'Campo requerido',
    capacidad: 'Debe ser >= 1',
    extra: 'Campo no permitido'
  });
});

test('los campos anidados usan la ruta con puntos y se resuelven los $ref del contrato', () => {
  const detalles = erroresDe('CompraCrear', { ...compraValida, asistente: { ...compraValida.asistente, documento: '12' } });
  assert.deepEqual(detalles, { 'asistente.documento': 'Formato inválido' });
  assert.deepEqual(erroresDe('CompraCrear', { ...compraValida, eventoId: 'xyz', cantidad: 11 }), {
    eventoId: 'Formato inválido',
    cantidad: 'Debe ser <= 10'
  });
});

test('los formatos del contrato se validan (date-time, email, uuid)', () => {
  assert.deepEqual(erroresDe('EventoCrear', { ...eventoValido, fecha: 'mañana' }), { fecha: 'Formato inválido (date-time)' });
  assert.deepEqual(erroresDe('CompraCrear', { ...compraValida, asistente: { ...compraValida.asistente, email: 'no-es-email' } }), { 'asistente.email': 'Formato inválido (email)' });
});

test('un PATCH vacío y un cuerpo que no es objeto se rechazan', () => {
  assert.deepEqual(erroresDe('EventoActualizar', {}), { cuerpo: 'Debe incluir al menos un campo' });
  assert.deepEqual(erroresDe('EventoActualizar', { estado: 'cancelado' }), { estado: 'Debe ser uno de: borrador, publicado, finalizado' });
  assert.deepEqual(erroresDe('CompraCrear', 'texto'), { cuerpo: 'Debe ser de tipo object' });
});

test('validarCuerpo responde 400 VALIDATION_ERROR con el formato de error de la API', () => {
  const res = respuestaFalsa();
  let siguio = false;
  validarCuerpo('CompraCrear', { mensaje: 'Datos de compra inválidos' })({ body: { ...compraValida, cantidad: 0 } }, res, () => { siguio = true; });
  assert.equal(siguio, false);
  assert.equal(res.codigo, 400);
  assert.deepEqual(res.cuerpo, {
    error: 'Datos de compra inválidos', code: 'VALIDATION_ERROR', retryable: false,
    action: 'Corregir los campos indicados', details: { cantidad: 'Debe ser >= 1' }
  });
});

test('validarCuerpo deja pasar un cuerpo válido y falla al montar con un schema inexistente', () => {
  let siguio = false;
  validarCuerpo('CompraCrear')({ body: compraValida }, respuestaFalsa(), () => { siguio = true; });
  assert.equal(siguio, true);
  assert.throws(() => validarCuerpo('NoExiste'), /no define el schema NoExiste/);
});

test('validarId rechaza un ObjectId mal formado con 400 INVALID_ID', () => {
  const res = respuestaFalsa();
  validarId()({ params: { id: '123' } }, res, () => assert.fail('no debe continuar'));
  assert.equal(res.codigo, 400);
  assert.equal(res.cuerpo.code, 'INVALID_ID');
  let siguio = false;
  validarId('id')({ params: { id: '66f000000000000000000001' } }, respuestaFalsa(), () => { siguio = true; });
  assert.equal(siguio, true);
});

test('asyncHandler deriva el rechazo de un handler async al manejador de errores', async () => {
  const error = new Error('falla');
  const recibido = await new Promise((resolve) => {
    asyncHandler(async () => { throw error; })({}, {}, resolve);
  });
  assert.equal(recibido, error);
});
