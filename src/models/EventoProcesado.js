const mongoose = require('mongoose');

const eventoProcesadoSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  compraId: { type: mongoose.Schema.Types.ObjectId, ref: 'Compra', required: true },
  procesadoEn: { type: Date, default: Date.now }
}, { timestamps: true, collection: 'eventos_procesados' });

module.exports = mongoose.model('EventoProcesado', eventoProcesadoSchema);
