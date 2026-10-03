const mongoose = require('mongoose');

const asistenteSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  documento: { type: String, required: true, trim: true, match: /^[0-9]{7,8}$/, unique: true }
}, { timestamps: true, collection: 'asistentes' });

module.exports = mongoose.model('Asistente', asistenteSchema);
