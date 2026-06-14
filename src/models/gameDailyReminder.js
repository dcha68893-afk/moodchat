/**
 * gameDailyReminder.js — NOT a Sequelize model
 *
 * This is a cron job that was accidentally placed in src/models/.
 * The actual implementation is in src/jobs/gameDailyReminder.js.
 *
 * The model loader skips this file because it is in NON_MODEL_PATTERNS,
 * but this shim is kept so any old require('./models/gameDailyReminder')
 * calls resolve correctly without crashing.
 */
module.exports = require('../jobs/gameDailyReminder');
