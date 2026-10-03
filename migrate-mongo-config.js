require('dotenv').config();

module.exports = {
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iaew_eventos',
    options: {}
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'migraciones',
  lockCollectionName: 'migraciones_lock',
  lockTtl: 60,
  migrationFileExtension: '.js',
  useFileHash: false,
  moduleSystem: 'commonjs'
};
