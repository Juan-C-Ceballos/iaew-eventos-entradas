const EventoModel = require('../models/Evento');
const CompraModel = require('../models/Compra');

const redondear = (valor) => Math.round(valor * 100) / 100;

// Reporte de ventas por evento para el endpoint interno (x-api-key). `entradasVendidas` es la suma
// de `cantidad` de las compras pagadas y `recaudado` la de sus `total`; una compra pagada de un
// evento cancelado sigue contando (el dinero se cobró, queda con reembolsoPendiente). Sirve también
// para auditar el invariante del cupo: capacidad − cupoDisponible = reservadas + vendidas.
async function ventasPorEvento({ Evento = EventoModel, Compra = CompraModel, ahora = new Date() } = {}) {
  const [eventos, ventas] = await Promise.all([
    Evento.find({}).sort({ fecha: 1, nombre: 1 }).select('nombre capacidad cupoDisponible').lean(),
    Compra.aggregate([
      { $match: { estado: 'pagada' } },
      { $group: { _id: '$eventoId', entradasVendidas: { $sum: '$cantidad' }, recaudado: { $sum: '$total' } } }
    ])
  ]);
  const porEvento = new Map(ventas.map((fila) => [String(fila._id), fila]));

  return {
    generadoEn: ahora.toISOString(),
    eventos: eventos.map((evento) => {
      const venta = porEvento.get(String(evento._id));
      return {
        eventoId: String(evento._id),
        nombre: evento.nombre,
        capacidad: evento.capacidad,
        cupoDisponible: evento.cupoDisponible,
        entradasVendidas: venta?.entradasVendidas ?? 0,
        recaudado: redondear(venta?.recaudado ?? 0)
      };
    })
  };
}

module.exports = { ventasPorEvento };
