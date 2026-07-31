/**
 * mergeDuplicateDirectChats.js
 *
 * WHY THIS EXISTS:
 * The advisory-lock fix in src/routes/chats.js's POST /start stops NEW
 * duplicate direct-chat rows from being created, but it does nothing for
 * pairs of users who already got split across two (or more) separate direct
 * chats BEFORE that fix was deployed — e.g. any two accounts used to test
 * the "open chat from Friends/Calls/Status" flow, where the old race had a
 * real chance to fire. Those accounts are now PERMANENTLY stuck: user A's
 * client is bound to chat row #1, user B's client is bound to chat row #2,
 * and every future /start lookup for that pair keeps resolving each of them
 * back to their own row — so messages keep only ever going one direction
 * (or neither), consistently and repeatably, not intermittently. That
 * consistency is exactly what makes it look like a fresh bug rather than
 * leftover damage from the old race.
 *
 * WHAT THIS SCRIPT DOES:
 * 1. Finds every direct chat and groups them by their (sorted) pair of
 *    participant user IDs.
 * 2. For any pair with more than one direct chat, picks the OLDEST chat
 *    (lowest id) as the canonical one to keep.
 * 3. Moves every message from the duplicate chat(s) onto the canonical chat
 *    (re-pointing Message.chatId), then deletes the now-empty duplicate
 *    chat's participant rows and the chat row itself.
 * 4. Each pair is processed in its own transaction — a failure on one pair
 *    never touches any other pair.
 *
 * USAGE:
 *   node scripts/mergeDuplicateDirectChats.js --dry-run   # preview only, no writes
 *   node scripts/mergeDuplicateDirectChats.js             # actually merge
 *
 * Safe to re-run: once a pair has been merged down to one chat, it's simply
 * skipped on the next run (nothing left to merge).
 */

const db = require('../src/models');
const { sequelize, Chat, ChatParticipant, Message } = db;

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    if (!sequelize || !Chat || !ChatParticipant || !Message) {
        console.error('[Merge] Missing one or more required models — check src/models/index.js exports.');
        process.exitCode = 1;
        return;
    }

    console.log(`[Merge] Starting duplicate direct-chat scan${DRY_RUN ? ' (DRY RUN — no writes will be made)' : ''}...`);

    // Pull every direct chat with its participant user IDs in one pass.
    const directChats = await Chat.findAll({
        where: { type: 'direct' },
        order: [['id', 'ASC']],
    });

    if (directChats.length === 0) {
        console.log('[Merge] No direct chats found — nothing to do.');
        return;
    }

    const participantsByChat = new Map(); // chatId -> [userId, userId]
    const allParticipants = await ChatParticipant.findAll({
        where: { chatId: directChats.map(c => c.id) },
        attributes: ['chatId', 'userId'],
    });
    for (const p of allParticipants) {
        if (!participantsByChat.has(p.chatId)) participantsByChat.set(p.chatId, []);
        participantsByChat.get(p.chatId).push(p.userId);
    }

    // Group chat IDs by sorted participant-pair key. Anything that isn't
    // exactly a 2-person chat is left alone — this script only targets 1:1
    // direct chats, never groups.
    const chatsByPairKey = new Map(); // "u1:u2" -> [chatId, chatId, ...]
    for (const chat of directChats) {
        const participants = (participantsByChat.get(chat.id) || []).slice().sort((a, b) => a - b);
        if (participants.length !== 2) continue;
        const key = participants.join(':');
        if (!chatsByPairKey.has(key)) chatsByPairKey.set(key, []);
        chatsByPairKey.get(key).push(chat.id);
    }

    const duplicatePairs = [...chatsByPairKey.entries()].filter(([, chatIds]) => chatIds.length > 1);

    if (duplicatePairs.length === 0) {
        console.log('[Merge] No duplicate direct chats found. Nothing to merge.');
        return;
    }

    console.log(`[Merge] Found ${duplicatePairs.length} user pair(s) with duplicate direct chats:`);
    for (const [pairKey, chatIds] of duplicatePairs) {
        console.log(`  - users ${pairKey}: chats [${chatIds.sort((a, b) => a - b).join(', ')}]`);
    }

    if (DRY_RUN) {
        console.log('\n[Merge] Dry run only — re-run without --dry-run to actually merge these.');
        return;
    }

    let mergedPairs = 0;
    let movedMessages = 0;
    let removedChats = 0;

    for (const [pairKey, chatIdsRaw] of duplicatePairs) {
        const chatIds = chatIdsRaw.slice().sort((a, b) => a - b);
        const canonicalId = chatIds[0];
        const duplicateIds = chatIds.slice(1);

        const t = await sequelize.transaction();
        try {
            for (const dupId of duplicateIds) {
                const [moved] = await Message.update(
                    { chatId: canonicalId },
                    { where: { chatId: dupId }, transaction: t }
                );
                movedMessages += moved;

                await ChatParticipant.destroy({ where: { chatId: dupId }, transaction: t });
                await Chat.destroy({ where: { id: dupId }, transaction: t });
                removedChats += 1;

                console.log(`[Merge] users ${pairKey}: moved ${moved} message(s) from chat ${dupId} -> ${canonicalId}, removed chat ${dupId}`);
            }

            await t.commit();
            mergedPairs += 1;
        } catch (err) {
            await t.rollback().catch(() => {});
            console.error(`[Merge] FAILED for users ${pairKey} (canonical=${canonicalId}):`, err.message);
        }
    }

    console.log(`\n[Merge] Done. Merged ${mergedPairs}/${duplicatePairs.length} pair(s), moved ${movedMessages} message(s), removed ${removedChats} duplicate chat(s).`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[Merge] Fatal error:', err);
        process.exit(1);
    });
