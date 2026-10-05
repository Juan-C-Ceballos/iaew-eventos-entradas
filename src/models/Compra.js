const mongoose = require('mongoose');

const ESTADOS_COMPRA = ['pendiente', 'pago_pendiente', 'pagada', 'rechazada', 'cancelada', 'expirada'];
const ESTADOS_PAGO = ['pendiente', 'aprobado', 'rechazado'];

const entero = { validator: Number.isInteger, message: '{PATH} debe ser un entero' };

const pagoSchema = new mongoose.Schema({
  estado: { type: String, enum: ESTADOS_PAGO, required: true },
  referenciaExterna: { type: String },
  idempotencyKey: { type: String },
  motivoRechazo: { type: String },
  solicitadoEn: { type: Date },
  procesadoEn: { type: Date }
}, { _id: false });

// Sobre de entrada.comprada persistido junto a la compra: un reintento republica el mismo eventId.
const emisionEventoSchema = new mongoose.Schema({
  eventId: { type: String, required: true },
  type: { type: String, required: true },
  version: { type: Number, required: true },
  occurredAt: { type: String, required: true },
  correlationId: { type: String, required: true },
  data: { compraId: { type: String, required: true } }
}, { _id: false });

// Copia de los datos del asistente al momento de comprar: el historial no cambia si el mismo DNI
// vuelve a comprar con otro nombre o email (ADR 0012).
const asistenteSnapshotSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  documento: { type: String, required: true, trim: true, match: /^[0-9]{7,8}$/ }
}, { _id: false });

const compraSchema = new mongoose.Schema({
  eventoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Evento', required: true },
  asistenteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Asistente', required: true },
  asistente: { type: asistenteSnapshotSchema, required: true },
  creadaPor: { type: String, required: true },
  cantidad: { type: Number, required: true, min: 1, max: 10, validate: entero },
  precioUnitario: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  estado: { type: String, enum: ESTADOS_COMPRA, default: 'pendiente' },
  reservaExpiraEn: { type: Date, required: true },
  pagoExpiraEn: { type: Date },
  idempotencyKey: { type: String, required: true },
  idempotencyFingerprint: { type: String, required: true },
  pago: pagoSchema,
  emisionEvento: emisionEventoSchema,
  emisionPublicadaEn: { type: Date },
  emisionEstado: { type: String, enum: ['pendiente', 'emitida'] },
  reembolsoPendiente: { type: Boolean, default: false },
  emitidaEn: { type: Date }
}, { timestamps: true, collection: 'compras' });

// Las claves de idempotencia son únicas por cliente, no globales (ADR 0012).
compraSchema.index({ creadaPor: 1, idempotencyKey: 1 }, { unique: true });
compraSchema.index({ creadaPor: 1, 'pago.idempotencyKey': 1 }, { unique: true, partialFilterExpression: { 'pago.idempotencyKey': { $exists: true } } });
compraSchema.index({ creadaPor: 1, createdAt: -1 });
compraSchema.index({ 'pago.referenciaExterna': 1 }, { unique: true, sparse: true });
compraSchema.index({ eventoId: 1, estado: 1 });
compraSchema.index({ estado: 1, reservaExpiraEn: 1 });
compraSchema.index({ estado: 1, pagoExpiraEn: 1 });
compraSchema.index({ estado: 1, emisionPublicadaEn: 1 });

module.exports = mongoose.model('Compra', compraSchema);
module.exports.ESTADOS_COMPRA = ESTADOS_COMPRA;
module.exports.ESTADOS_PAGO = ESTADOS_PAGO;
