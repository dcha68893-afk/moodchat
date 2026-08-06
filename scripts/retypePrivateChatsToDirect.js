/**
 * retypePrivateChatsToDirect.js
 *
 * ONE-TIME BACKFILL — run this BEFORE mergeDuplicateDirectChats.js.
 *
 * Root cause fixed in src/controllers/callController.js: the "message
 * this person" flow after a call used to create chats with
 * type: 'private' instead of 'direct'. Every other part of the app
 * (Chat History, POST /messages, notifications) only ever looks for
 * type: 'direct', so those call-originated chats were permanently
 * invisible — the receiver's app could never find them, no matter how
 * many messages were sent into them.
 *
 * That bug is fixed going forward (callController.js now shares the
 * same locked resolver everyone else uses), but any chats it already
 * created in production are still sitting there as type: 'private'
 * with exactly 2 participants. This script retypes those rows to
 * 'direct' so mergeDuplicateDirectChats.js can then find and merge them
 * with whatever real 'direct' thread already existed for the same pair
 * (or simply promote them to be the real thread, if none existed).
 *
 * Usage:
 *   node scripts/retypePrivateChatsToDirect.js           # dry run (default)
 *   node scripts/retypePrivateChatsToDirect.js --apply   # actually update
 *
 * Then run:
 *   node scripts/mergeDuplicateDirectChats.js
 */

'use strict';

const db = require('../src/models');

async function main() {
  const apply = process.argv.includes('--apply');
  const sequelize = db.sequelize;

  // Only touch 'private' chats that look like genuine 1:1s (exactly 2
  // participants). Leave anything else alone — this script is
  // intentionally conservative.
  const rows = await sequelize.query(
    `SELECT c.id, c."createdAt", array_agg(cp."userId" ORDER BY cp."userId") AS participants
     FROM chats c
     JOIN chat_participants cp ON cp."chatId" = c.id
     WHERE c.type = 'private'
     GROUP BY c.id
     HAVING COUNT(cp."userId") = 2`,
    { type: sequelize.QueryTypes.SELECT }
  );

  console.log(`Found ${rows.length} 'private' chat(s) with exactly 2 participants.`);
  rows.forEach(r => {
    console.log(`  chatId=${r.id} createdAt=${r.createdAt} participants=[${r.participants.join(', ')}]`);
  });

  if (!apply) {
    console.log('\nDry run only — no changes made. Re-run with --apply to update these rows.');
    await sequelize.close();
    return;
  }

  if (rows.length === 0) {
    console.log('Nothing to update.');
    await sequelize.close();
    return;
  }

  const ids = rows.map(r => r.id);
  await sequelize.query(
    `UPDATE chats SET type = 'direct', "updatedAt" = NOW() WHERE id IN (:ids)`,
    { replacements: { ids }, type: sequelize.QueryTypes.UPDATE }
  );
  console.log(`\nRetyped ${ids.length} chat(s) from 'private' to 'direct'.`);
  console.log('Now run: node scripts/mergeDuplicateDirectChats.js');
  await sequelize.close();
}

main().catch(err => {
  console.error('retypePrivateChatsToDirect failed:', err);
  process.exit(1);
});
