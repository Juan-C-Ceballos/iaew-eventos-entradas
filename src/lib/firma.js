const crypto = require('node:crypto');
const { ApiError } = require('./errors');

// Firma del webhook de pago (ADR 0006): `sha256=` + HMAC-SHA256(secreto, `<timestamp>.<cuerpo crudo>`).
// El timestamp va dentro de lo firmado, así que un atacante no puede reutilizar una firma vieja
// con un timestamp nuevo, y la ventana de tolerancia acota la reutilización de una captura.
const TIMESTAMP = /^[0-9]{10}$/;

function firmar(secreto, timestamp, cuerpo) {
  return `sha256=${crypto.createHmac('sha256', secreto).update(`${timestamp}.`).update(cuerpo).digest('hex')}`;
}

const firmaInvalida = () => new ApiError({
  status: 401, error: 'Firma del webhook inválida', code: 'WEBHOOK_SIGNATURE_INVALID',
  action: 'Firmar con el secreto compartido vigente'
});

// Comprueba la firma y después la ventana de tiempo, en ese orden: a quien no se autenticó no se
// le revela cuál es la tolerancia. `cuerpo` son los bytes originales de la solicitud (Buffer), no
// el JSON vuelto a serializar. Lanza ApiError 401 si algo falla.
function verificarFirma({ secreto, timestamp, firma, cuerpo, toleranciaSegundos, ahora = new Date() }) {
  if (!firma || !timestamp || !TIMESTAMP.test(timestamp) || !cuerpo) throw firmaInvalida();

  // Se comparan en tiempo constante; si difiere la longitud no hay nada que comparar.
  const esperada = Buffer.from(firmar(secreto, timestamp, cuerpo));
  const recibida = Buffer.from(String(firma));
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) throw firmaInvalida();

  if (Math.abs(ahora.getTime() / 1000 - Number(timestamp)) > toleranciaSegundos) {
    throw new ApiError({
      status: 401, error: 'El timestamp del webhook está fuera de la ventana permitida', code: 'WEBHOOK_TIMESTAMP_EXPIRED',
      action: 'Firmar con un timestamp actual (segundos Unix) y sincronizar el reloj'
    });
  }
}

module.exports = { firmar, verificarFirma };
