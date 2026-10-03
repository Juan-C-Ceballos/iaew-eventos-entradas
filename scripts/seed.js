require('dotenv').config();
const { connectDb, closeDb } = require('../src/db');
const Evento = require('../src/models/Evento');

// Ids fijos + $setOnInsert: correr el seed N veces no duplica ni pisa datos (no repone cupo vendido).
const EVENTOS = [
  {
    _id: '66f000000000000000000001',
    nombre: 'Recital de Rock Sinfónico',
    descripcion: 'Orquesta y banda en vivo. Evento de demostración con cupo amplio.',
    fecha: new Date('2026-11-20T21:00:00-03:00'),
    lugar: 'Estadio Ciudad — Córdoba',
    capacidad: 500,
    cupoDisponible: 500,
    precio: 25000,
    estado: 'publicado'
  },
  {
    _id: '66f000000000000000000002',
    nombre: 'Charla íntima de Jazz',
    descripcion: 'Cupo de 2 entradas para demostrar el error de evento agotado.',
    fecha: new Date('2026-11-27T20:00:00-03:00'),
    lugar: 'Sala Pequeña — Córdoba',
    capacidad: 2,
    cupoDisponible: 2,
    precio: 12000,
    estado: 'publicado'
  },
  {
    _id: '66f000000000000000000003',
    nombre: 'Obra de teatro (en preparación)',
    descripcion: 'Evento en borrador: no admite compras.',
    fecha: new Date('2026-12-10T20:30:00-03:00'),
    lugar: 'Teatro Central — Córdoba',
    capacidad: 300,
    cupoDisponible: 300,
    precio: 18000,
    estado: 'borrador'
  }
];

async function seed() {
  await connectDb();
  for (const { _id, ...evento } of EVENTOS) {
    const resultado = await Evento.updateOne({ _id }, { $setOnInsert: evento }, { upsert: true });
    console.log(`${resultado.upsertedCount ? 'Creado' : 'Ya existía'}: ${evento.nombre} (${_id})`);
  }
}

seed()
  .then(closeDb)
  .catch(async (error) => {
    console.error('Seed fallido:', error.message);
    await closeDb();
    process.exit(1);
  });
