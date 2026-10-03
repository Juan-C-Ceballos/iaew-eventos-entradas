// Índices iniciales. Deben coincidir con los declarados en src/models (ver docs/modelo-datos.md).
const INDICES = [
  { coleccion: 'eventos', campos: { estado: 1, fecha: 1 }, opciones: { name: 'estado_1_fecha_1' } },
  { coleccion: 'asistentes', campos: { documento: 1 }, opciones: { name: 'documento_1', unique: true } },
  { coleccion: 'compras', campos: { idempotencyKey: 1 }, opciones: { name: 'idempotencyKey_1', unique: true } },
  { coleccion: 'compras', campos: { 'pago.idempotencyKey': 1 }, opciones: { name: 'pago.idempotencyKey_1', unique: true, sparse: true } },
  { coleccion: 'compras', campos: { 'pago.referenciaExterna': 1 }, opciones: { name: 'pago.referenciaExterna_1', unique: true, sparse: true } },
  { coleccion: 'compras', campos: { eventoId: 1, estado: 1 }, opciones: { name: 'eventoId_1_estado_1' } },
  { coleccion: 'compras', campos: { estado: 1, reservaExpiraEn: 1 }, opciones: { name: 'estado_1_reservaExpiraEn_1' } },
  { coleccion: 'entradas', campos: { codigo: 1 }, opciones: { name: 'codigo_1', unique: true } },
  { coleccion: 'entradas', campos: { compraId: 1, numero: 1 }, opciones: { name: 'compraId_1_numero_1', unique: true } },
  { coleccion: 'entradas', campos: { eventoId: 1, estado: 1 }, opciones: { name: 'eventoId_1_estado_1' } },
  { coleccion: 'eventos_procesados', campos: { eventId: 1 }, opciones: { name: 'eventId_1', unique: true } }
];

module.exports = {
  async up(db) {
    for (const { coleccion, campos, opciones } of INDICES) {
      await db.collection(coleccion).createIndex(campos, opciones);
    }
  },

  async down(db) {
    for (const { coleccion, opciones } of [...INDICES].reverse()) {
      await db.collection(coleccion).dropIndex(opciones.name);
    }
  }
};
