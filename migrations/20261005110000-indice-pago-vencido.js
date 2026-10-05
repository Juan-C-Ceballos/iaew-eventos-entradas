// Índice para que el barrido encuentre rápido las compras con el pago vencido (ADR 0010).
const NOMBRE = 'estado_1_pagoExpiraEn_1';

module.exports = {
  async up(db) {
    await db.collection('compras').createIndex({ estado: 1, pagoExpiraEn: 1 }, { name: NOMBRE });
  },

  async down(db) {
    await db.collection('compras').dropIndex(NOMBRE);
  }
};
