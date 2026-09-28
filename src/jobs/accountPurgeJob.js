'use strict';
/**
 * src/jobs/accountPurgeJob.js
 *
 * FIX (Play Store compliance audit, item #1): the deletion confirmation
 * email already told users "remaining data will be permanently purged
 * within 30 days," but no job anywhere in the repository actually did
 * that — deletionRequestedAt was recorded and then never checked again.
 * Google's account-deletion requirement is that deletion actually deletes
 * data, not just deactivates the account indefinitely. This runs daily and
 * hard-deletes anything requestDeletion() left behind once the retention
 * window has passed. See accountDeletionService.js for exactly what gets
 * purged and what's deliberately out of scope.
 */

const cron = require('node-cron');

let _started = false;

function start() {
  if (_started) return;
  _started = true;

  // Once a day at 03:00 — matches this codebase's existing convention for
  // low-urgency cleanup jobs (see friendExpiryWorker.js's daily jobs).
  cron.schedule('0 3 * * *', async () => {
    try {
      const { purgeExpiredAccounts } = require('../services/accountDeletionService');
      const result = await purgeExpiredAccounts();
      if (result.attempted > 0) {
        console.log(`[AccountPurgeJob] Purge run: ${result.purged}/${result.attempted} accounts purged, ${result.failed} failed`);
      }
    } catch (e) {
      console.error('[AccountPurgeJob] Run failed (non-fatal):', e.message);
    }
  });

  console.log('[AccountPurgeJob] ✅ Scheduled (daily 03:00) — see accountDeletionService.purgeExpiredAccounts');
}

module.exports = { start };
