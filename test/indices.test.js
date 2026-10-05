const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODELOS = {
  eventos: require('../src/models/Evento'),
  asistentes: require('../src/models/Asistente'),
  compras: require('../src/models/Compra'),
  entradas: require('../src/models/Entrada'),
  eventos_procesados: require('../src/models/EventoProcesado')
};

const directorioMigraciones = path.join(__dirname, '..', 'migrations');
const migraciones = fs.readdirSync(directorioMigraciones).filter((nombre) => nombre.endsWith('.js')).sort();

const firma = (campos, opciones = {}) => JSON.stringify({
  campos,
  unique: Boolean(opciones.unique),
  sparse: Boolean(opciones.sparse),
  partial: opciones.partialFilterExpression || null
});

// Base simulada que registra los índices vivos de cada colección. dropIndex de un índice
// inexistente falla, igual que en MongoDB, para que `down` tenga que ser el inverso de `up`.
function baseSimulada() {
  const colecciones = {};
  return {
    colecciones,
    collection: (nombre) => {
      const indices = (colecciones[nombre] ||= new Map());
      return {
        async createIndex(campos, opciones = {}) {
          assert.ok(opciones.name, `índice sin name en ${nombre}: ${JSON.stringify(campos)}`);
          indices.set(opciones.name, firma(campos, opciones));
        },
        async dropIndex(nombreIndice) {
          assert.ok(indices.has(nombreIndice), `dropIndex de un índice inexistente: ${nombre}.${nombreIndice}`);
          indices.delete(nombreIndice);
        }
      };
    }
  };
}

test('los índices de las migraciones coinciden con los declarados en los modelos', async () => {
  const db = baseSimulada();
  for (const archivo of migraciones) await require(path.join(directorioMigraciones, archivo)).up(db);

  for (const [coleccion, modelo] of Object.entries(MODELOS)) {
    const enModelo = modelo.schema.indexes().map(([campos, opciones]) => firma(campos, opciones)).sort();
    const enMigraciones = [...(db.colecciones[coleccion] || new Map()).values()].sort();
    assert.deepEqual(enMigraciones, enModelo, `los índices de "${coleccion}" difieren entre migraciones y modelo`);
  }
});

test('revertir todas las migraciones deja la base sin índices', async () => {
  const db = baseSimulada();
  for (const archivo of migraciones) await require(path.join(directorioMigraciones, archivo)).up(db);
  for (const archivo of [...migraciones].reverse()) await require(path.join(directorioMigraciones, archivo)).down(db);
  for (const [coleccion, indices] of Object.entries(db.colecciones)) assert.equal(indices.size, 0, `${coleccion} conserva índices`);
});
