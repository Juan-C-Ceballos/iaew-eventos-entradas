const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { openapi } = require('./contrato');
const { sendError } = require('./errors');

// Los cuerpos se validan contra los schemas de docs/openapi.json: el contrato es la única fuente
// de las reglas de entrada. `strict: false` tolera las palabras clave propias de OpenAPI (`example`).
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: 'urn:iaew:contrato', components: { schemas: openapi.components.schemas } });

const validadores = new Map();

function validadorDe(nombre) {
  if (!validadores.has(nombre)) {
    if (!openapi.components.schemas[nombre]) throw new Error(`El contrato no define el schema ${nombre}`);
    validadores.set(nombre, ajv.compile({ $ref: `urn:iaew:contrato#/components/schemas/${nombre}` }));
  }
  return validadores.get(nombre);
}

const rutaDelCampo = (instancePath) => instancePath.split('/').filter(Boolean).join('.');

function mensajeDe(error) {
  const { keyword, params } = error;
  switch (keyword) {
    case 'required': return 'Campo requerido';
    case 'additionalProperties': return 'Campo no permitido';
    case 'type': return `Debe ser de tipo ${params.type}`;
    case 'minimum': case 'maximum': return `Debe ser ${params.comparison} ${params.limit}`;
    case 'minLength': return `Debe tener al menos ${params.limit} carácter(es)`;
    case 'maxLength': return `Debe tener como máximo ${params.limit} caracteres`;
    case 'minProperties': return 'Debe incluir al menos un campo';
    case 'enum': return `Debe ser uno de: ${params.allowedValues.join(', ')}`;
    case 'pattern': return 'Formato inválido';
    case 'format': return `Formato inválido (${params.format})`;
    default: return error.message;
  }
}

// Devuelve `null` si el dato es válido, o `{ "campo.anidado": "mensaje" }`, el formato de
// `details` del contrato. Un campo con varios errores conserva el primero.
function erroresDe(nombre, datos) {
  const validar = validadorDe(nombre);
  if (validar(datos)) return null;
  const detalles = {};
  for (const error of validar.errors) {
    let campo = rutaDelCampo(error.instancePath);
    if (error.keyword === 'required') campo = [campo, error.params.missingProperty].filter(Boolean).join('.');
    if (error.keyword === 'additionalProperties') campo = [campo, error.params.additionalProperty].filter(Boolean).join('.');
    campo ||= 'cuerpo';
    detalles[campo] ??= mensajeDe(error);
  }
  return detalles;
}

// Middleware: responde 400 VALIDATION_ERROR si `req.body` no cumple el schema del contrato.
function validarCuerpo(nombre, { mensaje = 'Datos inválidos' } = {}) {
  validadorDe(nombre); // falla al montar la ruta, no en la primera solicitud, si el schema no existe
  return (req, res, next) => {
    const detalles = erroresDe(nombre, req.body);
    if (detalles) return sendError(res, 400, mensaje, 'VALIDATION_ERROR', false, 'Corregir los campos indicados', detalles);
    return next();
  };
}

module.exports = { erroresDe, validarCuerpo };
