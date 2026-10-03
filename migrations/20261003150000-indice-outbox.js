// Índice para que el relay del outbox encuentre rápido las compras pagadas sin publicar (ADR 0009).
const NOMBRE = 'estado_1_emisionPublicadaEn_1';

module.exports = {
  async up(db) {
    await db.collection('compras').createIndex({ estado: 1, emisionPublicadaEn: 1 }, { name: NOMBRE });
  },

  async down(db) {
    await db.collection('compras').dropIndex(NOMBRE);
  }
};
