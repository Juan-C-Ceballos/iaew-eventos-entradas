require('dotenv').config();
const { connectDb, closeDb } = require('../src/db');
const Evento = require('../src/models/Evento');

// Ids fijos + $setOnInsert: correr el seed N veces no duplica ni pisa datos (no repone cupo vendido).
// Las fechas son relativas al primer seed, así los eventos publicados siguen vendiendo en la demo (ADR 0011).
const enDias = (dias, hora) => {
  const fecha = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  fecha.setHours(hora, 0, 0, 0);
  return fecha;
};

const EVENTOS = [
  {
    _id: '66f000000000000000000001',
    nombre: 'Recital de Rock Sinfónico',
    descripcion: 'Orquesta y banda en vivo. Evento de demostración con cupo amplio.',
    fecha: enDias(45, 21),
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
    fecha: enDias(52, 20),
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
    fecha: enDias(65, 20),
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
