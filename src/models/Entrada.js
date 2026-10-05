const mongoose = require('mongoose');

const ESTADOS_ENTRADA = ['emitida', 'usada', 'anulada'];

// Copia del titular al emitir (viene del snapshot de la compra): en la puerta alcanza con el
// nombre y el DNI, sin join y sin exponer el email (ADR 0012).
const titularSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  documento: { type: String, required: true }
}, { _id: false });

const entradaSchema = new mongoose.Schema({
  codigo: { type: String, required: true, match: /^ENT-[A-Z0-9]{12}$/, unique: true },
  compraId: { type: mongoose.Schema.Types.ObjectId, ref: 'Compra', required: true },
  eventoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Evento', required: true },
  asistenteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Asistente', required: true },
  titular: { type: titularSchema, required: true },
  numero: { type: Number, required: true, min: 1 },
  estado: { type: String, enum: ESTADOS_ENTRADA, default: 'emitida' },
  emitidaEn: { type: Date, default: Date.now },
  usadaEn: { type: Date },
  validadaPor: { type: String }
}, { timestamps: true, collection: 'entradas' });

// (compraId, numero) único: reemitir la misma compra no duplica entradas.
entradaSchema.index({ compraId: 1, numero: 1 }, { unique: true });
entradaSchema.index({ eventoId: 1, estado: 1 });

module.exports = mongoose.model('Entrada', entradaSchema);
module.exports.ESTADOS_ENTRADA = ESTADOS_ENTRADA;
