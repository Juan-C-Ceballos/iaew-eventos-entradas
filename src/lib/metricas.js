const client = require('prom-client');

// Métricas de Prometheus (ADR 0008). Un registro por proceso: la api lo expone en GET /metrics y
// el worker en su propio puerto; Prometheus suma lo de los dos con `sum(...)`. Los contadores de
// dominio se incrementan donde ocurre el hecho (el webhook en la api, la conciliación en el
// worker), por eso viven acá y no en cada servicio.
const registro = new client.Registry();
client.collectDefaultMetrics({ register: registro });

const crearContador = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [registro] });

const httpDuracion = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de las solicitudes HTTP. De acá salen la latencia p95, el throughput y el error rate.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registro]
});

const entradasVendidas = crearContador('entradas_vendidas_total', 'Entradas vendidas: unidades de las compras que quedaron pagadas');
const entradasEmitidas = crearContador('entradas_emitidas_total', 'Entradas emitidas por el worker');
const validaciones = crearContador('validaciones_total', 'Validaciones de entradas en la puerta, por resultado', ['resultado']);
const pagosFallidos = crearContador('pagos_fallidos_total', 'Pagos que no terminaron bien, por motivo', ['motivo']);
const mensajes = crearContador('mensajes_procesados_total', 'Mensajes entrada.comprada procesados por el worker, por resultado', ['resultado']);
const mensajesDlq = crearContador('mensajes_dlq_total', 'Mensajes derivados a la DLQ, por razón', ['razon']);
const barrido = crearContador('barrido_acciones_total', 'Correcciones hechas por el barrido del worker, por acción', ['accion']);
const barridoErrores = crearContador('barrido_errores_total', 'Pasos del barrido que fallaron, por paso', ['paso']);

// Resultados posibles de cada etiqueta: se publican en cero desde el arranque, así el dashboard
// muestra la serie antes del primer evento y `increase()` no devuelve vacío.
const RESULTADOS_VALIDACION = ['acceso_permitido', 'ya_usada', 'anulada', 'otro_evento', 'evento_inactivo', 'inexistente'];
const MOTIVOS_PAGO_FALLIDO = ['rechazado', 'expirado', 'pasarela_no_disponible'];
const RESULTADOS_MENSAJE = ['ok', 'duplicado', 'reintento', 'dlq'];
const RAZONES_DLQ = ['invalid_json', 'contract_invalid', 'compra_not_found', 'compra_not_paid', 'max_retries_exceeded'];
const ACCIONES_BARRIDO = [
  'reservas_expiradas', 'pagos_conciliados_pagados', 'pagos_conciliados_rechazados', 'pagos_conciliados_expirados',
  'eventos_finalizados', 'cancelaciones_completadas', 'cupo_corregido'
];
const PASOS_BARRIDO = ['reservasExpiradas', 'pagos', 'eventosFinalizados', 'cancelacionesCompletadas', 'cupo'];
for (const resultado of RESULTADOS_VALIDACION) validaciones.inc({ resultado }, 0);
for (const motivo of MOTIVOS_PAGO_FALLIDO) pagosFallidos.inc({ motivo }, 0);
for (const resultado of RESULTADOS_MENSAJE) mensajes.inc({ resultado }, 0);
for (const razon of RAZONES_DLQ) mensajesDlq.inc({ razon }, 0);
for (const accion of ACCIONES_BARRIDO) barrido.inc({ accion }, 0);
for (const paso of PASOS_BARRIDO) barridoErrores.inc({ paso }, 0);

module.exports = {
  registro, httpDuracion, entradasVendidas, entradasEmitidas, validaciones, pagosFallidos, mensajes, mensajesDlq, barrido, barridoErrores,
  RESULTADOS_VALIDACION, MOTIVOS_PAGO_FALLIDO, RAZONES_DLQ, ACCIONES_BARRIDO, PASOS_BARRIDO
};
