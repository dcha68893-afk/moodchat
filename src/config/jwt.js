const config = require('./index');

module.exports = {
  secret: config.jwt.secret,
  audience: config.jwt.audience,
  issuer: config.jwt.issuer,

  accessToken: {
    expiresIn: config.jwt.accessExpiration,
    algorithm: 'HS256',
  },

  refreshToken: {
    expiresIn: config.jwt.refreshExpiration,
    algorithm: 'HS256',
  },

  verificationToken: {
    expiresIn: '24h',
  },

  passwordResetToken: {
    expiresIn: '1h',
  },
};
