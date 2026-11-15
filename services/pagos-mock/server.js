const http = require('node:http');
const crypto = require('node:crypto');

// Pasarela de pago simulada (ADR 0006 y 0010). Sin dependencias: solo módulos de Node.
//
// - POST /pagos: pide un cobro. Es idempotente por `compraId` y decide el resultado según el
//   `escenario` (`aprobado` | `rechazado`). Pasados PAGO_DEMORA_MS el pago queda resuelto y se
//   notifica a WEBHOOK_URL con una firma HMAC-SHA256(WEBHOOK_SECRET, `${timestamp}.${cuerpo}`).
// - GET /pagos?compraId=: estado del pago (`pendiente`, `aprobado`, `rechazado`) o 404. Con eso la
//   api concilia un pago cuya notificación nunca llegó.
// - GET /health.
//
// El estado vive en memoria: si el contenedor se reinicia, la pasarela "no conoce" los pagos
// anteriores (404), y la compra termina `expirada` en la conciliación (ADR 0010).

const OBJECT_ID = /^[a-fA-F0-9]{24}$/;
const ESCENARIOS = ['aprobado', 'rechazado'];
const MOTIVO_RECHAZO = 'fondos_insuficientes';

function configuracion(env = process.env) {
  const entero = (nombre, porDefecto) => {
    const valor = env[nombre] === undefined || env[nombre] === '' ? porDefecto : Number(env[nombre]);
    if (!Number.isInteger(valor) || valor < 0) throw new Error(`${nombre} debe ser un entero mayor o igual a 0`);
    return valor;
  };
  return {
    port: entero('PORT', 4000),
    webhookUrl: env.WEBHOOK_URL || 'http://localhost:3000/webhooks/pagos',
    webhookSecret: env.WEBHOOK_SECRET || 'colocar-secreto-compartido-local',
    // Con WEBHOOK_HABILITADO=false el pago se resuelve pero no se notifica: sirve para mostrar la
    // conciliación del barrido (el webhook "perdido").
    webhookHabilitado: env.WEBHOOK_HABILITADO !== 'false',
    pagoDemoraMs: entero('PAGO_DEMORA_MS', 200),
    webhookReintentos: entero('WEBHOOK_REINTENTOS', 5),
    webhookBackoffMs: entero('WEBHOOK_BACKOFF_MS', 1000),
    webhookTimeoutMs: entero('WEBHOOK_TIMEOUT_MS', 5000)
  };
}

function firmar(secreto, timestamp, cuerpo) {
  return `sha256=${crypto.createHmac('sha256', secreto).update(`${timestamp}.${cuerpo}`).digest('hex')}`;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un 5xx, un timeout o un error de red se reintentan con backoff exponencial; un 4xx no (la api
// rechazó la notificación y repetirla no cambia nada). Cada intento se vuelve a firmar con un
// timestamp nuevo para no salirse de la ventana anti-replay, pero conserva el mismo cuerpo.
async function notificar(pago, config, log) {
  const cuerpo = JSON.stringify({
    notificacionId: crypto.randomUUID(),
    type: pago.estado === 'aprobado' ? 'pago.aprobado' : 'pago.rechazado',
    occurredAt: new Date().toISOString(),
    data: {
      compraId: pago.compraId,
      referenciaExterna: pago.referenciaExterna,
      monto: pago.monto,
      ...(pago.estado === 'rechazado' ? { motivo: pago.motivo } : {})
    }
  });

  for (let intento = 0; intento <= config.webhookReintentos; intento += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pago-Timestamp': timestamp,
          'X-Pago-Firma': firmar(config.webhookSecret, timestamp, cuerpo),
          ...(pago.correlationId ? { 'X-Correlation-Id': pago.correlationId } : {})
        },
        body: cuerpo,
        signal: AbortSignal.timeout(config.webhookTimeoutMs)
      });
      if (res.status < 500) {
        log(`Webhook ${pago.estado}: la api respondió ${res.status}`, { compraId: pago.compraId, correlationId: pago.correlationId, statusCode: res.status });
        return res.status;
      }
      log(`Webhook: la api respondió ${res.status}, se reintenta`, { level: 'warn', compraId: pago.compraId, correlationId: pago.correlationId, statusCode: res.status, intento: intento + 1 });
    } catch (error) {
      log(`Webhook: ${error.message}, se reintenta`, { level: 'warn', compraId: pago.compraId, correlationId: pago.correlationId, intento: intento + 1 });
    }
    if (intento < config.webhookReintentos) await dormir(config.webhookBackoffMs * 2 ** intento);
  }
  log('Webhook: se agotaron los reintentos; la api lo resolverá por conciliación', { level: 'error', compraId: pago.compraId, correlationId: pago.correlationId });
  return null;
}

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

function responder(res, status, cuerpo) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(cuerpo));
}

const error = (res, status, code, mensaje) => responder(res, status, { error: mensaje, code, retryable: false, action: 'Corregir la solicitud' });

const publico = ({ compraId, referenciaExterna, estado, monto, motivo }) => ({
  compraId, referenciaExterna, estado, monto, ...(motivo ? { motivo } : {})
});

// Log en JSON, una línea por evento, igual que la api (ADR 0008): `campos` suma el correlation id
// que viaja en X-Correlation-Id desde /pagar, así el pago se sigue de punta a punta.
function registrar(mensaje, { level = 'info', ...campos } = {}) {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'pagos-mock', msg: mensaje, ...campos }));
}

function crearServidor(config = configuracion(), { log = registrar } = {}) {
  const pagos = new Map(); // compraId → pago

  function resolver(pago) {
    pago.estado = pago.escenario === 'rechazado' ? 'rechazado' : 'aprobado';
    if (pago.estado === 'rechazado') pago.motivo = MOTIVO_RECHAZO;
    if (config.webhookHabilitado) {
      pago.notificacion = notificar(pago, config, log);
    } else {
      log(`Pago ${pago.estado}: webhook deshabilitado (WEBHOOK_HABILITADO=false)`, { compraId: pago.compraId, correlationId: pago.correlationId });
    }
  }

  async function crearPago(req, res) {
    let cuerpo;
    try { cuerpo = await leerJson(req); } catch { return error(res, 400, 'INVALID_JSON', 'JSON inválido'); }
    const { compraId, monto, escenario = 'aprobado' } = cuerpo;
    if (typeof compraId !== 'string' || !OBJECT_ID.test(compraId)) return error(res, 400, 'VALIDATION_ERROR', 'compraId debe ser un ObjectId');
    if (typeof monto !== 'number' || !Number.isFinite(monto) || monto < 0) return error(res, 400, 'VALIDATION_ERROR', 'monto debe ser un número mayor o igual a 0');
    if (!ESCENARIOS.includes(escenario)) return error(res, 400, 'VALIDATION_ERROR', `escenario debe ser uno de: ${ESCENARIOS.join(', ')}`);

    // Idempotente por compra: repetir el pedido (por ejemplo, la api reintenta tras un timeout)
    // devuelve el mismo pago y no genera otro cobro ni otra notificación.
    const existente = pagos.get(compraId);
    if (existente) return responder(res, 200, publico(existente));

    const pago = {
      compraId, monto, escenario, estado: 'pendiente',
      referenciaExterna: `PAY-${crypto.randomBytes(4).toString('hex')}`,
      correlationId: req.headers['x-correlation-id']
    };
    pagos.set(compraId, pago);
    setTimeout(() => resolver(pago), config.pagoDemoraMs).unref();
    log(`Pago solicitado (escenario ${escenario})`, { compraId, referenciaExterna: pago.referenciaExterna, correlationId: pago.correlationId });
    return responder(res, 201, publico(pago));
  }

  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://pagos-mock');
    if (req.method === 'GET' && url.pathname === '/health') return responder(res, 200, { status: 'ok', servicio: 'pagos-mock' });
    if (req.method === 'POST' && url.pathname === '/pagos') {
      return crearPago(req, res).catch((falla) => { log(`Error: ${falla.message}`, { level: 'error' }); error(res, 500, 'INTERNAL_ERROR', 'Error interno'); });
    }
    if (req.method === 'GET' && url.pathname === '/pagos') {
      const compraId = url.searchParams.get('compraId');
      if (!compraId || !OBJECT_ID.test(compraId)) return error(res, 400, 'VALIDATION_ERROR', 'compraId debe ser un ObjectId');
      const pago = pagos.get(compraId);
      if (!pago) return error(res, 404, 'PAYMENT_NOT_FOUND', 'La pasarela no conoce ese pago');
      return responder(res, 200, publico(pago));
    }
    return error(res, 404, 'ROUTE_NOT_FOUND', 'Ruta inexistente');
  });

  // Para las pruebas: espera a que terminen las notificaciones en curso.
  servidor.esperarNotificaciones = () => Promise.all([...pagos.values()].map((pago) => pago.notificacion));
  return servidor;
}

module.exports = { crearServidor, configuracion, firmar, registrar };

if (require.main === module) {
  const config = configuracion();
  const servidor = crearServidor(config);
  servidor.listen(config.port, () => registrar('pagos-mock escuchando', { port: config.port }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => servidor.close(() => process.exit(0)));
  }
}
