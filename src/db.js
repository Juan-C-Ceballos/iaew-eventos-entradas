const mongoose = require('mongoose');

// autoIndex desactivado: los índices los crea migrate-mongo (ver ADR 0003).
async function connectDb(uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iaew_eventos') {
  await mongoose.connect(uri, { autoIndex: false });
  console.log('Conexión a MongoDB establecida');
}

async function closeDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, closeDb };
