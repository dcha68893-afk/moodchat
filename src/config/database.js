const config = require('./index');

module.exports = {
  development: {
    host: process.env.DB_HOST || config.database.host || '127.0.0.1',
    port: process.env.DB_PORT || config.database.port || 5432,
    username: process.env.DB_USER || config.database.user || config.database.username || 'postgres',
    password: process.env.DB_PASSWORD || config.database.password || '24845c1b4df84c17a0526806f7aa0482',
    database: process.env.DB_NAME || config.database.name || config.database.database || 'chat_app_dev',
    dialect: process.env.DB_DIALECT || config.database.dialect || 'postgres',
    logging: console.log,
    pool: config.database.pool || {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    dialectOptions: config.database.dialectOptions || {},
  },
  test: {
    host: process.env.DB_HOST || config.database.host || '127.0.0.1',
    port: process.env.DB_PORT || config.database.port || 5432,
    username: process.env.DB_USER || config.database.user || config.database.username || 'postgres',
    password: process.env.DB_PASSWORD || config.database.password || '24845c1b4df84c17a0526806f7aa0482',
    database: process.env.DB_NAME || config.database.name || config.database.database || 'chat_app_test',
    dialect: process.env.DB_DIALECT || config.database.dialect || 'postgres',
    logging: false,
    pool: config.database.pool || {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    dialectOptions: config.database.dialectOptions || {},
  },
  production: {
    host: process.env.DB_HOST || config.database.host,
    port: process.env.DB_PORT || config.database.port || 5432,
    username: process.env.DB_USER || config.database.user || config.database.username || process.env.DB_USER,
    password: process.env.DB_PASSWORD || config.database.password || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || config.database.name || config.database.database || process.env.DB_NAME,
    dialect: process.env.DB_DIALECT || config.database.dialect || 'postgres',
    logging: false,
    pool: config.database.pool || {
      max: 20,
      min: 5,
      acquire: 60000,
      idle: 30000,
    },
    dialectOptions: {
      ...(config.database.dialectOptions || {}),
      ssl: config.database.ssl || process.env.DB_SSL === 'true' ? {
        require: true,
        rejectUnauthorized: false,
      } : false,
    },
  },
};