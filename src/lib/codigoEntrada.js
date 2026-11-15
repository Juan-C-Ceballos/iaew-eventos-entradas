const crypto = require('node:crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Código de la entrada, el contenido del QR: `ENT-` + 12 caracteres [A-Z0-9] generados con
// `crypto.randomInt` (36^12 combinaciones, no se pueden adivinar). La unicidad la garantiza el
// índice único de `entradas.codigo`; una colisión se resuelve generando otro código.
function generarCodigoEntrada() {
  let sufijo = '';
  for (let i = 0; i < 12; i += 1) sufijo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return `ENT-${sufijo}`;
}

module.exports = { generarCodigoEntrada };
