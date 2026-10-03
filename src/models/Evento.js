const mongoose = require('mongoose');

const ESTADOS_EVENTO = ['borrador', 'publicado', 'cancelado', 'finalizado'];

const entero = { validator: Number.isInteger, message: '{PATH} debe ser un entero' };

const eventoSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true, maxlength: 120 },
  descripcion: { type: String, trim: true, maxlength: 2000 },
  fecha: { type: Date, required: true },
  lugar: { type: String, required: true, trim: true, maxlength: 200 },
  capacidad: { type: Number, required: true, min: 1, validate: entero },
  cupoDisponible: { type: Number, required: true, min: 0, validate: entero },
  precio: { type: Number, required: true, min: 0 },
  estado: { type: String, enum: ESTADOS_EVENTO, default: 'borrador' }
}, { timestamps: true, collection: 'eventos' });

eventoSchema.index({ estado: 1, fecha: 1 });

module.exports = mongoose.model('Evento', eventoSchema);
module.exports.ESTADOS_EVENTO = ESTADOS_EVENTO;
