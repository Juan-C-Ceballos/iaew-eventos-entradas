const crypto = require('node:crypto');
const CompraModel = require('../models/Compra');
const EventoModel = require('../models/Evento');
const { consultarPago } = require('./pasarela');
const { plazosConfig } = require('./config');
const { comoConsola } = require('./logger');
const metricas = require('./metricas');
const { correr } = require('./contexto');
const { expirarReserva } = require('../services/compras');
const pagos = require('../services/pagos');
const { cancelarEventoCascada } = require('../services/eventos');

// Barrido periódico del worker (ADR 0010 y 0011). Cada paso es independiente, se apoya en
// transiciones condicionales y se puede repetir sin efectos dobles, así que varias réplicas o un
// webhook tardío pueden competir con él sin consecuencias. Todo lo que el barrido corrige es algo
// que el camino normal no pudo resolver solo (una reserva abandonada, un webhook perdido, un
// proceso que murió a mitad).

const ESTADOS_QUE_OCUPAN_CUPO = ['pendiente', 'pago_pendiente', 'pagada'];

// 1. Reservas sin pago cuyo plazo venció: `pendiente → expirada` y se devuelve el cupo.
async function expirarReservasVencidas({ Compra = CompraModel, ahora = new Date(), limite = 100, ...dependencias } = {}) {
  const vencidas = await Compra.find({ estado: 'pendiente', reservaExpiraEn: { $lte: ahora } })
    .sort({ reservaExpiraEn: 1 }).limit(limite).select('_id').lean();
  let expiradas = 0;
  for (const { _id } of vencidas) {
    if (await expirarReserva(_id, { Compra, ahora, ...dependencias })) expiradas += 1;
  }
  return expiradas;
}

// 2. Pagos pendientes cuyo plazo venció: se le pregunta a la pasarela, que es la única fuente de
// verdad, y se resuelve la compra por el mismo camino que el webhook.
//   aprobado → pagada | rechazado → rechazada | no la conoce → expirada | pendiente o sin respuesta → se deja.
async function conciliarPagosVencidos({ Compra = CompraModel, ahora = new Date(), limite = 50, consultar = consultarPago, log = comoConsola(), ...dependencias } = {}) {
  const vencidos = await Compra.find({ estado: 'pago_pendiente', pagoExpiraEn: { $lte: ahora } })
    .sort({ pagoExpiraEn: 1 }).limit(limite).select('_id').lean();
  const resumen = { pagadas: 0, rechazadas: 0, expiradas: 0, pendientes: 0, sinRespuesta: 0 };
  const deps = { Compra, ahora, ...dependencias };

  for (const { _id } of vencidos) {
    let pago;
    try {
      pago = await consultar(_id);
    } catch (error) {
      resumen.sinRespuesta += 1;
      log.error(`Conciliación: sin respuesta de la pasarela para la compra ${_id}, se reintenta en el próximo barrido: ${error.message}`);
      continue;
    }

    if (pago === null) {
      if (await pagos.expirarPagoSinRegistro(_id, deps)) resumen.expiradas += 1;
    } else if (pago.estado === 'aprobado') {
      const { resultado } = await pagos.registrarPagoAprobado(_id, { referenciaExterna: pago.referenciaExterna, correlationId: `barrido-${crypto.randomUUID()}` }, deps);
      if (resultado === 'aplicado') resumen.pagadas += 1;
    } else if (pago.estado === 'rechazado') {
      const { resultado } = await pagos.registrarPagoRechazado(_id, { referenciaExterna: pago.referenciaExterna, motivo: pago.motivo }, deps);
      if (resultado === 'aplicado') resumen.rechazadas += 1;
    } else {
      resumen.pendientes += 1; // la pasarela todavía lo está procesando
    }
  }
  return resumen;
}

// 3. Eventos publicados que ya terminaron: pasan a `finalizado` (estado persistido, no calculado
// al leer, así los filtros por estado dicen la verdad). Durante las horas de gracia siguen
// `publicado`: la validación en la puerta funciona después del inicio.
async function finalizarEventosTerminados({ Evento = EventoModel, ahora = new Date(), eventoFinalizaTrasHoras = plazosConfig().eventoFinalizaTrasHoras } = {}) {
  const limite = new Date(ahora.getTime() - eventoFinalizaTrasHoras * 60 * 60 * 1000);
  const { modifiedCount } = await Evento.updateMany({ estado: 'publicado', fecha: { $lte: limite } }, { $set: { estado: 'finalizado' } });
  return modifiedCount;
}

// 4. Cancelaciones cuya cascada no terminó (la API falló a mitad, o quedaba un pago por
// resolverse o una emisión en curso): se retoma hasta que `cancelacionProcesadaEn` se completa.
async function retomarCascadasDeCancelacion({ Evento = EventoModel, limite = 50, ...dependencias } = {}) {
  const pendientes = await Evento.find({ estado: 'cancelado', cancelacionProcesadaEn: null }).limit(limite).select('_id').lean();
  let completadas = 0;
  for (const { _id } of pendientes) {
    if (await cancelarEventoCascada(_id, { Evento, ...dependencias })) completadas += 1;
  }
  return completadas;
}

// 5. Reconciliación del cupo. `cupoDisponible` es un contador desnormalizado; el invariante es
// `capacidad − Σ cantidad de compras pendiente, pago_pendiente y pagada`. Una reserva en curso
// produce una diferencia de milisegundos, no de minutos: por eso solo se corrige una diferencia
// que se repite idéntica en dos barridos consecutivos (`observadas` guarda la del anterior), con un
// update condicionado al valor observado para no pisar a una reserva que llegue justo en ese momento.
async function reconciliarCupo({ Evento = EventoModel, Compra = CompraModel, observadas = new Map(), log = comoConsola() } = {}) {
  const publicados = await Evento.find({ estado: 'publicado' }).select('capacidad cupoDisponible').lean();
  const ocupados = new Map((await Compra.aggregate([
    { $match: { eventoId: { $in: publicados.map((e) => e._id) }, estado: { $in: ESTADOS_QUE_OCUPAN_CUPO } } },
    { $group: { _id: '$eventoId', total: { $sum: '$cantidad' } } }
  ])).map((fila) => [String(fila._id), fila.total]));

  const resumen = { corregidos: 0, observados: 0 };
  const vigentes = new Set();
  for (const evento of publicados) {
    const id = String(evento._id);
    const esperado = evento.capacidad - (ocupados.get(id) ?? 0);
    if (evento.cupoDisponible === esperado) continue;

    if (esperado < 0) { // más compras que lugares: no hay un cupo "correcto" al que volver
      log.error(`cupo_inconsistente: el evento ${id} tiene más entradas reservadas o vendidas (${evento.capacidad - esperado}) que capacidad (${evento.capacidad})`);
      continue;
    }
    vigentes.add(id);
    const previa = observadas.get(id);
    if (previa && previa.observado === evento.cupoDisponible && previa.esperado === esperado) {
      const { modifiedCount } = await Evento.updateOne({ _id: evento._id, cupoDisponible: evento.cupoDisponible }, { $set: { cupoDisponible: esperado } });
      if (modifiedCount === 1) {
        resumen.corregidos += 1;
        log.error(`cupo_reconciliado: evento ${id}, cupoDisponible ${evento.cupoDisponible} → ${esperado}`);
      }
      observadas.delete(id);
      vigentes.delete(id);
    } else {
      observadas.set(id, { observado: evento.cupoDisponible, esperado });
      resumen.observados += 1;
    }
  }
  // Una diferencia que desapareció sola era una reserva en curso: se olvida.
  for (const id of [...observadas.keys()]) if (!vigentes.has(id)) observadas.delete(id);
  return resumen;
}

// Un paso "hizo algo" si cambió el estado de alguna compra o evento. Lo que solo se observó o
// quedó para el próximo barrido no cuenta: así una pasada sin novedades no llena los logs.
const NO_SON_CAMBIOS = ['pendientes', 'sinRespuesta', 'observados'];
function huboCambios(resultado) {
  if (typeof resultado === 'number') return resultado > 0;
  return Object.entries(resultado).some(([clave, valor]) => typeof valor === 'number' && valor > 0 && !NO_SON_CAMBIOS.includes(clave));
}

// Suma al contador de acciones lo que cambió cada paso (`barrido_acciones_total{accion}`).
function contarAcciones({ reservasExpiradas, pagos, eventosFinalizados, cancelacionesCompletadas, cupo }) {
  const sumar = (accion, cantidad) => { if (typeof cantidad === 'number' && cantidad > 0) metricas.barrido.inc({ accion }, cantidad); };
  sumar('reservas_expiradas', reservasExpiradas);
  sumar('pagos_conciliados_pagados', pagos?.pagadas);
  sumar('pagos_conciliados_rechazados', pagos?.rechazadas);
  sumar('pagos_conciliados_expirados', pagos?.expiradas);
  sumar('eventos_finalizados', eventosFinalizados);
  sumar('cancelaciones_completadas', cancelacionesCompletadas);
  sumar('cupo_corregido', cupo?.corregidos);
}

// Arma una pasada del barrido. Ejecuta los pasos en orden; un paso que falla se registra y no
// impide a los demás (por ejemplo, la pasarela caída no debe frenar el vencimiento de reservas).
// No es re-entrante: si una pasada tarda más que el intervalo, la siguiente se omite.
function crearBarrido({ log = comoConsola(), ...dependencias } = {}) {
  const observadas = new Map();
  let enCurso = null;

  async function pasada() {
    if (enCurso) return enCurso;
    // Cada pasada tiene su propio correlation id para seguir lo que hizo en los logs.
    enCurso = correr({ correlationId: `barrido-${crypto.randomUUID()}` }, async () => {
      const ahora = dependencias.ahora ?? new Date();
      const base = { ...dependencias, ahora, log };
      const resultados = {};
      const pasos = [
        ['reservasExpiradas', () => expirarReservasVencidas(base)],
        ['pagos', () => conciliarPagosVencidos(base)],
        ['eventosFinalizados', () => finalizarEventosTerminados(base)],
        ['cancelacionesCompletadas', () => retomarCascadasDeCancelacion(base)],
        ['cupo', () => reconciliarCupo({ ...base, observadas })]
      ];
      for (const [nombre, paso] of pasos) {
        try {
          resultados[nombre] = await paso();
        } catch (error) {
          resultados[nombre] = { error: error.message };
          metricas.barridoErrores.inc({ paso: nombre });
          log.error(`Barrido: falló el paso ${nombre}: ${error.message}`, { paso: nombre });
        }
      }
      contarAcciones(resultados);
      if (Object.values(resultados).some(huboCambios)) log.log('Barrido: hubo correcciones', { resultados });
      return resultados;
    }).finally(() => { enCurso = null; });
    return enCurso;
  }

  // Para apagar: espera la pasada en curso sin disparar otra.
  const esperarEnCurso = () => enCurso ?? Promise.resolve();
  return { pasada, esperarEnCurso, observadas };
}

// Corre el barrido cada `intervaloMs`, con una primera pasada inmediata (recupera lo pendiente
// después de una caída). Devuelve una función que lo detiene y espera la pasada en curso.
function iniciarBarrido({ intervaloMs, ...opciones }) {
  const { pasada, esperarEnCurso } = crearBarrido(opciones);
  let detenido = false;
  const ejecutar = () => { if (!detenido) pasada().catch(() => {}); };
  ejecutar();
  const timer = setInterval(ejecutar, intervaloMs);
  return async () => {
    detenido = true;
    clearInterval(timer);
    await esperarEnCurso().catch(() => {});
  };
}

module.exports = {
  expirarReservasVencidas, conciliarPagosVencidos, finalizarEventosTerminados, retomarCascadasDeCancelacion,
  reconciliarCupo, crearBarrido, iniciarBarrido
};
