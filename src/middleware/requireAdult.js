'use strict';
/**
 * requireAdult - wallet / money features are for users aged 18+ (Google Play financial-features + UGC age rules).
 * The confirmation is stored on the user (Users.settings.adultConfirmedAt, an existing JSONB column - no migration)
 * and is checked here on the server, so a modified client cannot skip it. It is a self-declaration, not ID verification.
 */
const userModel = () => {
  const m = require('../models');
  return m.User || m.Users || (m.sequelize && m.sequelize.models && (m.sequelize.models.Users || m.sequelize.models.User)) || null;
};
const idOf = (req) => Number(req.user?.id || req.user?.userId || req.user?.sub || req.userId);

async function isAdultConfirmed(userId) {
  const U = userModel();
  if (!U || !userId) return false;
  const u = await U.findByPk(userId, { attributes: ['id', 'settings'] });
  return !!(u && u.settings && typeof u.settings === 'object' && u.settings.adultConfirmedAt);
}

async function confirmAdult(userId) {
  const U = userModel();
  if (!U || !userId) throw Object.assign(new Error('Account not found'), { status: 404 });
  const u = await U.findByPk(userId);
  if (!u) throw Object.assign(new Error('Account not found'), { status: 404 });
  const cur = u.settings && typeof u.settings === 'object' ? u.settings : {};
  if (cur.adultConfirmedAt) return cur.adultConfirmedAt;
  const at = new Date().toISOString();
  u.settings = { ...cur, adultConfirmedAt: at };
  u.changed('settings', true);
  await u.save();
  return at;
}

async function requireAdult(req, res, next) {
  try {
    if (await isAdultConfirmed(idOf(req))) return next();
    return res.status(403).json({
      success: false,
      message: 'Please confirm you are 18 or older to use wallet features.',
      errorCode: 'ADULT_CONFIRMATION_REQUIRED',
      code: 'ADULT_CONFIRMATION_REQUIRED'   // some clients read `code`, others `errorCode`
    });
  } catch (e) {
    return next(e);
  }
}

module.exports = { requireAdult, isAdultConfirmed, confirmAdult };
