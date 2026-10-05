// Titularidad de la compra (ADR 0012): cada compra guarda `creadaPor` (el `sub` del token) y las
// claves de idempotencia dejan de ser únicas globalmente para serlo por cliente. Antes, un
// cliente que reusara la clave de otro recibía como "replay" una compra ajena.
const CREADA_POR = { name: 'creadaPor_1_createdAt_-1' };
const CLAVE_COMPRA = { name: 'creadaPor_1_idempotencyKey_1', unique: true };
const CLAVE_PAGO = {
  name: 'creadaPor_1_pago.idempotencyKey_1',
  unique: true,
  partialFilterExpression: { 'pago.idempotencyKey': { $exists: true } }
};
const CLAVE_COMPRA_ANTERIOR = { name: 'idempotencyKey_1', unique: true };
const CLAVE_PAGO_ANTERIOR = { name: 'pago.idempotencyKey_1', unique: true, sparse: true };

module.exports = {
  async up(db) {
    const compras = db.collection('compras');
    await compras.createIndex({ creadaPor: 1, createdAt: -1 }, CREADA_POR);
    await compras.createIndex({ creadaPor: 1, idempotencyKey: 1 }, CLAVE_COMPRA);
    await compras.createIndex({ creadaPor: 1, 'pago.idempotencyKey': 1 }, CLAVE_PAGO);
    await compras.dropIndex(CLAVE_COMPRA_ANTERIOR.name);
    await compras.dropIndex(CLAVE_PAGO_ANTERIOR.name);
  },

  async down(db) {
    const compras = db.collection('compras');
    await compras.createIndex({ idempotencyKey: 1 }, CLAVE_COMPRA_ANTERIOR);
    await compras.createIndex({ 'pago.idempotencyKey': 1 }, CLAVE_PAGO_ANTERIOR);
    await compras.dropIndex(CLAVE_PAGO.name);
    await compras.dropIndex(CLAVE_COMPRA.name);
    await compras.dropIndex(CREADA_POR.name);
  }
};
