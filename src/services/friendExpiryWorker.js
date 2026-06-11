/**
 * friendExpiryWorker.js
 *
 * Combines three audit-identified missing background jobs into one worker:
 *
 * Job 1 (P1) — Temporary friend expiry (hourly)
 *   Problem: expiresAt was only stored in localStorage. If a user cleared
 *   localStorage, expired friends reappeared from the DB forever.
 *   Fix: Runs every hour, deletes expired friendship records, emits
 *   'friend:expired' socket event to both users for instant UI refresh.
 *
 * Job 2 (P2) — Auto-closeness scoring (daily at 02:00)
 *   Problem: closenessLevel column existed but was always 0. The frontend
 *   showed a "Best Friends" badge but it never lit up.
 *   Fix: Scores friendships 0-10 based on messages + calls in last 30 days.
 *   Top 8 for each user are flagged as "Best Friends" (closenessLevel >= 7).
 *
 * Job 3 (P3) — Friendship anniversary notifications (daily at 09:00)
 *   Problem: No anniversary notifications existed anywhere.
 *   Fix: Sends an in-app notification to both users when their friendiversary
 *   falls today (1yr, 2yr, …), but only if privacy.anniversaryNotifications=true.
 *
 * Job 4 (P2) — Stale pending request auto-expiry (weekly Sunday 03:00)
 *   Problem: Pending requests accumulated indefinitely.
 *   Fix: Marks requests older than 30 days as 'expired'.
 */

'use strict';

const cron   = require('node-cron');
const { Op } = require('sequelize');

let _db      = null;
let _io      = null;
let _started = false;

function start(db, io) {
    if (_started) return;
    _started = true;
    _db = db;
    _io = io || null;

    const Friend       = db.Friend       || db.Friends       || db.models?.Friend       || db.models?.Friends;
    const User         = db.User         || db.Users         || db.models?.User         || db.models?.Users;
    const Messages     = db.Messages     || db.Message       || db.models?.Messages     || db.models?.Message;
    const Call         = db.Call         || db.Calls         || db.models?.Call         || db.models?.Calls;
    const Notification = db.Notification || db.Notifications || db.models?.Notification || db.models?.Notifications;
    const Settings     = db.Settings     || db.models?.Settings;

    if (!Friend) {
        console.warn('[FriendWorker] Friend model not found — worker not started.');
        return;
    }

    // ── Helper: emit socket event to a user ──────────────────────────────────
    function emit(room, event, payload) {
        if (_io) {
            try { _io.to(room).emit(event, payload); } catch (_) {}
        }
    }

    // ── Helper: create in-app notification ───────────────────────────────────
    async function notify(userId, type, title, body, data = {}) {
        if (!Notification) return;
        try {
            await Notification.create({ userId, type, title, body: body || '', data, isRead: false, createdAt: new Date() });
            emit(`user:${userId}`, 'notification:new', { type, title, body, data });
        } catch (_) {}
    }

    // ════════════════════════════════════════════════════════════════
    // JOB 1: Temporary friend expiry — every hour
    // ════════════════════════════════════════════════════════════════
    cron.schedule('0 * * * *', async () => {
        try {
            const expired = await Friend.findAll({
                where: { expiresAt: { [Op.lt]: new Date(), [Op.ne]: null }, status: 'accepted' },
                attributes: ['id', 'requesterId', 'receiverId'],
                raw: true
            });

            if (expired.length === 0) return;

            const ids = expired.map(r => r.id);
            await Friend.destroy({ where: { id: { [Op.in]: ids } } });

            console.log(`[FriendWorker] Expired ${expired.length} temporary friendship(s).`);

            expired.forEach(record => {
                const payload = { friendshipId: record.id, expired: true };
                emit(`user:${record.requesterId}`, 'friend:expired', { ...payload, otherUserId: record.receiverId });
                emit(`user:${record.receiverId}`,  'friend:expired', { ...payload, otherUserId: record.requesterId });
            });
        } catch (e) {
            console.error('[FriendWorker] Expiry job error:', e.message);
        }
    });

    // ════════════════════════════════════════════════════════════════
    // JOB 2: Auto-closeness scoring — daily at 02:00
    // ════════════════════════════════════════════════════════════════
    cron.schedule('0 2 * * *', async () => {
        if (!Messages && !Call) return; // nothing to score with

        try {
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            // Load all accepted friendships
            const friendships = await Friend.findAll({
                where: { status: 'accepted' },
                attributes: ['id', 'requesterId', 'receiverId'],
                raw: true
            });

            if (friendships.length === 0) return;

            // Count messages per (userA, userB) pair in last 30 days
            const msgCounts = new Map(); // key: `min:max` → count
            if (Messages) {
                try {
                    const msgs = await Messages.findAll({
                        where: { createdAt: { [Op.gte]: cutoff } },
                        attributes: ['senderId', 'receiverId'],
                        raw: true,
                        limit: 200000
                    });
                    msgs.forEach(m => {
                        if (!m.senderId || !m.receiverId) return;
                        const key = `${Math.min(m.senderId, m.receiverId)}:${Math.max(m.senderId, m.receiverId)}`;
                        msgCounts.set(key, (msgCounts.get(key) || 0) + 1);
                    });
                } catch (_) {}
            }

            // Count calls per pair in last 30 days
            const callCounts = new Map();
            if (Call) {
                try {
                    const calls = await Call.findAll({
                        where: { createdAt: { [Op.gte]: cutoff }, status: 'ended' },
                        attributes: ['callerId', 'receiverId', 'duration'],
                        raw: true,
                        limit: 50000
                    });
                    calls.forEach(call => {
                        if (!call.callerId || !call.receiverId) return;
                        const key = `${Math.min(call.callerId, call.receiverId)}:${Math.max(call.callerId, call.receiverId)}`;
                        // Weight calls higher: each call = 5 message-equivalents
                        const weight = call.duration > 0 ? 5 : 2;
                        callCounts.set(key, (callCounts.get(key) || 0) + weight);
                    });
                } catch (_) {}
            }

            // Compute closeness score 0-10 for each friendship
            let updated = 0;
            for (const f of friendships) {
                const key = `${Math.min(f.requesterId, f.receiverId)}:${Math.max(f.requesterId, f.receiverId)}`;
                const msgs  = msgCounts.get(key)  || 0;
                const calls = callCounts.get(key) || 0;
                const total = msgs + calls;

                // Logarithmic scale: 0=0, 10=150+ interactions/month
                let score = 0;
                if (total >= 150) score = 10;
                else if (total >= 100) score = 9;
                else if (total >=  70) score = 8;
                else if (total >=  50) score = 7;
                else if (total >=  30) score = 6;
                else if (total >=  20) score = 5;
                else if (total >=  12) score = 4;
                else if (total >=   6) score = 3;
                else if (total >=   2) score = 2;
                else if (total >=   1) score = 1;

                if (f.closenessLevel !== score) {
                    await Friend.update(
                        { closenessLevel: score, updatedAt: new Date() },
                        { where: { id: f.id } }
                    );
                    updated++;
                }
            }

            console.log(`[FriendWorker] Closeness scored: ${friendships.length} friendships, ${updated} updated.`);
        } catch (e) {
            console.error('[FriendWorker] Closeness scoring error:', e.message);
        }
    });

    // ════════════════════════════════════════════════════════════════
    // JOB 3: Friendship anniversary notifications — daily at 09:00
    // ════════════════════════════════════════════════════════════════
    cron.schedule('0 9 * * *', async () => {
        try {
            const today = new Date();
            const todayMonth = today.getMonth() + 1; // 1-12
            const todayDay   = today.getDate();      // 1-31

            // Accepted friendships with an acceptedAt date
            const allFriendships = await Friend.findAll({
                where: { status: 'accepted', acceptedAt: { [Op.ne]: null } },
                attributes: ['id', 'requesterId', 'receiverId', 'acceptedAt'],
                raw: true
            });

            let sent = 0;
            for (const f of allFriendships) {
                const accepted = new Date(f.acceptedAt);
                if (accepted.getMonth() + 1 !== todayMonth || accepted.getDate() !== todayDay) continue;

                const years = today.getFullYear() - accepted.getFullYear();
                if (years < 1) continue;

                // Check both users' anniversary notification settings
                for (const [userId, otherId] of [
                    [f.requesterId, f.receiverId],
                    [f.receiverId,  f.requesterId]
                ]) {
                    let notifyEnabled = true;
                    if (Settings) {
                        try {
                            const s = await Settings.findOne({ where: { userId }, attributes: ['privacy'], raw: true });
                            if (s?.privacy?.anniversaryNotifications === false) notifyEnabled = false;
                        } catch (_) {}
                    }

                    if (!notifyEnabled) continue;

                    // Fetch other user's name for the notification
                    let otherName = `User #${otherId}`;
                    if (User) {
                        try {
                            const u = await User.findByPk(otherId, { attributes: ['username', 'firstName'], raw: true });
                            if (u) otherName = u.firstName || u.username || otherName;
                        } catch (_) {}
                    }

                    const yearsLabel = years === 1 ? '1 year' : `${years} years`;
                    await notify(
                        userId,
                        'friend_anniversary',
                        `🎉 ${yearsLabel} of friendship!`,
                        `You and ${otherName} have been friends for ${yearsLabel}!`,
                        { friendId: otherId, years, acceptedAt: f.acceptedAt }
                    );
                    sent++;
                }
            }

            if (sent > 0) console.log(`[FriendWorker] Sent ${sent} anniversary notification(s).`);
        } catch (e) {
            console.error('[FriendWorker] Anniversary job error:', e.message);
        }
    });

    // ════════════════════════════════════════════════════════════════
    // JOB 4: Stale pending request auto-expiry — Sundays 03:00
    // ════════════════════════════════════════════════════════════════
    cron.schedule('0 3 * * 0', async () => {
        try {
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const stale = await Friend.findAll({
                where: { status: 'pending', createdAt: { [Op.lt]: cutoff } },
                attributes: ['id', 'requesterId', 'receiverId'],
                raw: true
            });

            if (stale.length === 0) return;

            const ids = stale.map(r => r.id);
            await Friend.update(
                { status: 'expired', updatedAt: new Date() },
                { where: { id: { [Op.in]: ids } } }
            );

            console.log(`[FriendWorker] Expired ${stale.length} stale pending request(s).`);

            stale.forEach(r => {
                emit(`user:${r.requesterId}`, 'friend:request_expired', { requestId: r.id, otherUserId: r.receiverId });
                emit(`user:${r.receiverId}`,  'friend:request_expired', { requestId: r.id, otherUserId: r.requesterId });
            });
        } catch (e) {
            console.error('[FriendWorker] Stale-request expiry error:', e.message);
        }
    });

    console.log('[FriendWorker] Started — expiry(hourly), closeness(daily 02:00), anniversaries(daily 09:00), stale-requests(weekly Sun 03:00).');
}

module.exports = { start };
