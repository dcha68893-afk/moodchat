const config = require('./index');

// FIXED: Validate environment variables
if (!config.jwt || !config.jwt.secret) {
  throw new Error('JWT_SECRET is not configured in environment variables');
}

if (!config.jwt.issuer) {
  throw new Error('JWT_ISSUER is not configured in environment variables');
}

if (!config.jwt.audience) {
  throw new Error('JWT_AUDIENCE is not configured in environment variables');
}

// Validate expiration times
if (!config.jwt.accessExpiration) {
  console.warn('JWT_ACCESS_EXPIRATION not set, using default: 15m');
  config.jwt.accessExpiration = '15m';
}

if (!config.jwt.refreshExpiration) {
  console.warn('JWT_REFRESH_EXPIRATION not set, using default: 7d');
  config.jwt.refreshExpiration = '7d';
}

// Validate algorithms
if (!config.jwt.accessToken || !config.jwt.accessToken.algorithm) {
  config.jwt.accessToken = config.jwt.accessToken || {};
  config.jwt.accessToken.algorithm = 'HS256';
}

if (!config.jwt.refreshToken || !config.jwt.refreshToken.algorithm) {
  config.jwt.refreshToken = config.jwt.refreshToken || {};
  config.jwt.refreshToken.algorithm = 'HS256';
}

module.exports = {
  secret: config.jwt.secret,
  audience: config.jwt.audience,
  issuer: config.jwt.issuer,

  accessToken: {
    expiresIn: config.jwt.accessExpiration,
    algorithm: config.jwt.accessToken.algorithm,
  },

  refreshToken: {
    expiresIn: config.jwt.refreshExpiration,
    algorithm: config.jwt.refreshToken.algorithm,
  },

  verificationToken: {
    expiresIn: '24h',
  },

  passwordResetToken: {
    expiresIn: '1h',
  },
};