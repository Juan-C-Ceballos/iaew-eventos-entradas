// Conexión a MongoDB para las pruebas de integración. Se activa con MONGODB_URI_TEST, por ejemplo:
//   docker compose up -d mongodb
//   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/iaew_eventos_test npm test
//
// `node --test` corre cada archivo en su propio proceso y en paralelo, y cada prueba vacía sus
// colecciones: por eso cada archivo usa su propia base (`<nombre>_<sufijo>`). El nombre debe
// contener "test" para no vaciar nunca una base de datos real.
function configuracionMongo(sufijo) {
  const uri = process.env.MONGODB_URI_TEST;
  if (!uri) return null;
  const base = new URL(uri).pathname.replace(/^\//, '');
  if (!/test/i.test(base)) {
    throw new Error('MONGODB_URI_TEST debe apuntar a una base cuyo nombre contenga "test": las pruebas la vacían');
  }
  return { uri, dbName: `${base}_${sufijo}` };
}

module.exports = { configuracionMongo };
