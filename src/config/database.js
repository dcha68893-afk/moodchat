const config = require('./index');

module.exports = {
  development: {
    ...config.database,
    logging: console.log,
  },
  test: {
    ...config.database,
    logging: false,
  },
  production: {
    ...config.database,
    logging: false,
    pool: {
      max: 20,
      min: 5,
      acquire: 60000,
      idle: 30000,
    },
  },
};
