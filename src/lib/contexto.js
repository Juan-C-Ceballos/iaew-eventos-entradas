const { AsyncLocalStorage } = require('node:async_hooks');

// Contexto de la operación en curso (ADR 0008): el correlation id viaja con la ejecución, así que
// cada línea de log lo lleva sin tener que pasarlo por parámetro a cada función. La api lo abre
// por request (middleware de correlación) y el worker por mensaje o por pasada del barrido.
const almacen = new AsyncLocalStorage();

const correr = (contexto, funcion) => almacen.run(contexto, funcion);
const actual = () => almacen.getStore() ?? {};

module.exports = { correr, actual };
