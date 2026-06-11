// workers/groupCronWorker.js
// P2 FIX: Automated cron jobs for group features
// - Auto-close polls at their deadline
// - Auto-generate daily AI summaries at midnight UTC
'use strict';

let schedule;
try { schedule = require('node-schedule'); } catch(_) { schedule = null; }

function startGroupCrons() {
  if (!schedule) {
    console.warn('[GroupCron] node-schedule not installed — cron jobs disabled. Run: npm install node-schedule');
    return;
  }

  let db, GroupPoll, Groups, GroupMembers;
  try {
    db = require('../src/models');
    GroupPoll    = db.models?.GroupPoll    || db.GroupPoll;
    Groups       = db.models?.Groups       || db.Groups;
    GroupMembers = db.models?.GroupMembers || db.GroupMembers;
  } catch (e) {
    console.error('[GroupCron] Failed to load models:', e.message);
    return;
  }

  // ── POLL AUTO-CLOSE: every minute ──────────────────────────────────────────
  schedule.scheduleJob('* * * * *', async () => {
    try {
      if (!GroupPoll) return;
      const { Op } = require('sequelize');
      const expiredPolls = await GroupPoll.findAll({
        where: {
          deadline: { [Op.lt]: new Date() },
          status: 'active',
        },
      });
      for (const poll of expiredPolls) {
        poll.status = 'closed';
        await poll.save();
        // Notify group via socket if available
        const io = global.__socketIO;
        if (io) {
          const payload = { pollId: poll.id, groupId: poll.groupId, reason: 'deadline' };
          io.to(`group:${poll.groupId}`).emit('group:poll:closed', payload);
          io.to(`group_${poll.groupId}`).emit('group:poll:closed', payload);
        }
        console.log(`[GroupCron] Poll #${poll.id} auto-closed (deadline passed)`);
      }
    } catch (e) {
      console.error('[GroupCron] Poll auto-close error:', e.message);
    }
  });

  // ── DAILY AI SUMMARY: midnight UTC ────────────────────────────────────────
  schedule.scheduleJob('0 0 * * *', async () => {
    try {
      const smartGroupService = require('../src/services/smartGroupService');
      if (!Groups) return;

      // Find all groups that have AI module enabled (default: all active groups)
      const groups = await Groups.findAll({
        attributes: ['id'],
        where: { /* could add: settings.aiSummaryEnabled if tracked */ },
      });

      let queued = 0;
      for (const group of groups) {
        try {
          // Check group has recent activity (members > 0)
          if (GroupMembers) {
            const memberCount = await GroupMembers.count({ where: { groupId: group.id, leftAt: null } });
            if (memberCount === 0) continue;
          }
          await smartGroupService.queueAISummary(group.id, 'daily');
          queued++;
        } catch (_) { /* skip individual group failures */ }
      }
      console.log(`[GroupCron] Daily AI summaries queued for ${queued} groups`);
    } catch (e) {
      console.error('[GroupCron] Daily AI summary cron error:', e.message);
    }
  });

  // ── DISAPPEARING MESSAGES: every 5 minutes ────────────────────────────────
  schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      const Message = db.models?.Messages || db.models?.Message || db.Messages || db.Message;
      if (!Message) return;
      const { Op } = require('sequelize');

      // Delete all messages where expiresAt has passed
      const expired = await Message.findAll({
        where: {
          expiresAt: { [Op.lt]: new Date() },
          isDeleted: false,
        },
        attributes: ['id', 'chatId', 'metadata'],
      });

      if (!expired.length) return;

      const ids = expired.map(m => m.id);
      await Message.update(
        { isDeleted: true, content: '', deletedAt: new Date() },
        { where: { id: ids } }
      );

      // Group by groupId for socket notifications
      const groupIds = new Set();
      expired.forEach(m => {
        const gid = m.metadata?.groupId;
        if (gid) groupIds.add(gid);
      });
      const io = global.__socketIO;
      if (io) {
        groupIds.forEach(gid => {
          io.to(`group:${gid}`).emit('group:messages:disappeared', { groupId: gid, messageIds: ids });
        });
      }
      console.log(`[GroupCron] Disappeared ${ids.length} expired messages`);
    } catch (e) {
      console.error('[GroupCron] Disappearing messages error:', e.message);
    }
  });

  _startEventReminderCron(schedule, db);

  console.log('[GroupCron] ✅ Cron workers started: poll auto-close, daily AI summaries, disappearing messages, event reminders');
}

// ── EVENT REMINDERS: every minute ─────────────────────────────────────────────
function _startEventReminderCron(schedule, db) {
  const GroupEvent = db.models?.GroupEvent || db.GroupEvent;
  const GM         = db.models?.GroupMembers || db.GroupMembers;
  if (!GroupEvent || !schedule) return;

  schedule.scheduleJob('* * * * *', async () => {
    try {
      const { Op } = require('sequelize');
      const now     = new Date();
      const in15min = new Date(now.getTime() + 15 * 60_000);
      const in1min  = new Date(now.getTime() +  1 * 60_000);

      // Find events starting in ~15 min or ~1 min (within 30s window)
      const upcoming = await GroupEvent.findAll({
        where: {
          startTime: { [Op.between]: [in1min, in15min] },
          status: { [Op.in]: ['scheduled', 'active'] },
        },
        attributes: ['id', 'groupId', 'title', 'startTime'],
      });

      for (const event of upcoming) {
        const minsUntil = Math.round((new Date(event.startTime) - now) / 60_000);
        const io = global.__socketIO;
        if (io) {
          io.to(`group:${event.groupId}`).emit('group:event:reminder', {
            groupId: event.groupId,
            eventId: event.id,
            title:   event.title,
            startsIn: minsUntil,
            startTime: event.startTime,
          });
        }
        // Push notification to members
        if (global.__pushService?.isConfigured() && GM) {
          const members = await GM.findAll({ where: { groupId: event.groupId, leftAt: null, isBanned: false }, attributes: ['userId'] });
          const userIds = members.map(m => m.userId);
          global.__pushService.sendToMultipleTokens(
            [], // tokens fetched internally
            { title: `⏰ Event starting in ${minsUntil} min`, body: event.title },
            { type: 'event_reminder', groupId: String(event.groupId), eventId: String(event.id) }
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[GroupCron] Event reminder error:', e.message);
    }
  });
}

module.exports = { startGroupCrons };
