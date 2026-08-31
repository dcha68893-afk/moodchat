'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { apiRateLimiter, chatLimiter } = require('../middleware/rateLimiter');

// All routes are protected by parent auth middleware in routes/index.js

function safeInt(val) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function isParticipant(sequelize, chatId, userId) {
  const rows = await sequelize.query(
    `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
    { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
  );
  return rows && rows.length > 0;
}

function stripHtmlTags(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').replace(/\bon\w+\s*=/gi, 'data-blocked=');
}

/**
 * Build the full poll payload (question, options with vote counts, and the
 * requesting user's own selections) for API responses and socket broadcasts.
 * Respects isAnonymous by omitting voter identities from option breakdowns
 * unless the poll was created by the requesting user.
 */
async function buildPollPayload(sequelize, pollId, requestingUserId) {
  const [poll] = await sequelize.query(
    `SELECT id, "chatId", "messageId", "createdBy", question, "allowMultipleAnswers",
            "isAnonymous", "closesAt", "isClosed", "closedAt", "createdAt"
     FROM "ChatPolls" WHERE id = :pollId LIMIT 1`,
    { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!poll) return null;

  const options = await sequelize.query(
    `SELECT id, text, position FROM "ChatPollOptions" WHERE "pollId" = :pollId ORDER BY position ASC, id ASC`,
    { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
  );

  const voteCounts = await sequelize.query(
    `SELECT "optionId", COUNT(*)::int AS count FROM "ChatPollVotes" WHERE "pollId" = :pollId GROUP BY "optionId"`,
    { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
  );
  const countMap = {};
  voteCounts.forEach(v => { countMap[v.optionId] = v.count; });

  const myVotes = await sequelize.query(
    `SELECT "optionId" FROM "ChatPollVotes" WHERE "pollId" = :pollId AND "userId" = :userId`,
    { replacements: { pollId, userId: requestingUserId }, type: sequelize.QueryTypes.SELECT }
  );
  const myOptionIds = myVotes.map(v => v.optionId);

  const totalVotes = voteCounts.reduce((sum, v) => sum + v.count, 0);

  // Anonymous polls: only the creator can see who voted; voters list omitted
  // from the API response entirely for everyone else (not just hidden client-side).
  const includeVoters = !poll.isAnonymous || requestingUserId === poll.createdBy;
  let votersByOption = {};
  if (includeVoters) {
    const voterRows = await sequelize.query(
      `SELECT pv."optionId", u.id AS "userId", u.username, u.avatar
       FROM "ChatPollVotes" pv
       JOIN "Users" u ON u.id = pv."userId"
       WHERE pv."pollId" = :pollId`,
      { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
    );
    voterRows.forEach(row => {
      if (!votersByOption[row.optionId]) votersByOption[row.optionId] = [];
      votersByOption[row.optionId].push({ userId: row.userId, username: row.username, avatar: row.avatar });
    });
  }

  return {
    id: poll.id,
    chatId: poll.chatId,
    messageId: poll.messageId,
    createdBy: poll.createdBy,
    question: poll.question,
    allowMultipleAnswers: poll.allowMultipleAnswers,
    isAnonymous: poll.isAnonymous,
    closesAt: poll.closesAt,
    isClosed: poll.isClosed,
    closedAt: poll.closedAt,
    createdAt: poll.createdAt,
    totalVotes,
    myOptionIds,
    options: options.map(o => ({
      id: o.id,
      text: o.text,
      position: o.position,
      voteCount: countMap[o.id] || 0,
      percentage: totalVotes > 0 ? Math.round(((countMap[o.id] || 0) / totalVotes) * 100) : 0,
      voters: includeVoters ? (votersByOption[o.id] || []) : undefined,
    })),
  };
}

function broadcastPollUpdate(chatId, payload) {
  try {
    const wsService = require('../services/webSocketService');
    wsService.broadcastToChat(chatId, 'poll:updated', payload, []);
  } catch (_) { /* non-fatal — clients will see the update on next fetch */ }
}

// ============================================================================
// POST /api/polls — Create a new poll in a chat
// Body: { chatId, question, options: string[], allowMultipleAnswers?, isAnonymous?, closesAt? }
// ============================================================================
router.post('/', apiRateLimiter, chatLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const { chatId: rawChatId, question, options, allowMultipleAnswers, isAnonymous, closesAt } = req.body;

  const chatId = safeInt(rawChatId);
  if (!chatId) {
    return res.status(400).json({ success: false, message: 'Valid chatId is required' });
  }
  const safeQuestion = stripHtmlTags(String(question || '').trim()).slice(0, 500);
  if (!safeQuestion) {
    return res.status(400).json({ success: false, message: 'Poll question is required' });
  }
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ success: false, message: 'At least 2 poll options are required' });
  }
  if (options.length > 12) {
    return res.status(400).json({ success: false, message: 'Polls support a maximum of 12 options' });
  }
  const safeOptions = options
    .map(o => stripHtmlTags(String(o || '').trim()).slice(0, 255))
    .filter(Boolean);
  if (safeOptions.length < 2) {
    return res.status(400).json({ success: false, message: 'At least 2 non-empty poll options are required' });
  }
  // Reject duplicate options (case-insensitive) — ambiguous voting target otherwise
  const dedupCheck = new Set(safeOptions.map(o => o.toLowerCase()));
  if (dedupCheck.size !== safeOptions.length) {
    return res.status(400).json({ success: false, message: 'Poll options must be unique' });
  }

  let safeClosesAt = null;
  if (closesAt) {
    const d = new Date(closesAt);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now()) safeClosesAt = d;
  }

  if (!(await isParticipant(sequelize, chatId, userId))) {
    return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
  }

  const t = await sequelize.transaction();
  try {
    const [pollResult] = await sequelize.query(
      `INSERT INTO "ChatPolls" ("chatId","createdBy",question,"allowMultipleAnswers","isAnonymous","closesAt","createdAt","updatedAt")
       VALUES (:chatId,:userId,:question,:allowMultiple,:isAnonymous,:closesAt,NOW(),NOW())
       RETURNING id`,
      {
        replacements: {
          chatId, userId, question: safeQuestion,
          allowMultiple: !!allowMultipleAnswers, isAnonymous: !!isAnonymous,
          closesAt: safeClosesAt,
        },
        type: sequelize.QueryTypes.INSERT, transaction: t,
      }
    );
    const pollId = pollResult[0].id;

    for (let i = 0; i < safeOptions.length; i++) {
      await sequelize.query(
        `INSERT INTO "ChatPollOptions" ("pollId", text, position, "createdAt") VALUES (:pollId, :text, :position, NOW())`,
        { replacements: { pollId, text: safeOptions[i], position: i }, transaction: t, type: sequelize.QueryTypes.INSERT }
      );
    }

    // Deliver the poll as a message bubble in the chat timeline, exactly like
    // any other message type — this is what makes it sort/paginate correctly
    // alongside text/image/etc. messages instead of living in a separate UI.
    const [msgResult] = await sequelize.query(
      `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,metadata,"sentAt","deliveredAt","createdAt","updatedAt")
       VALUES (:chatId,:senderId,:content,'poll','{}',:metadata,NOW(),NOW(),NOW(),NOW())
       RETURNING id,"chatId","senderId",content,type,"createdAt"`,
      {
        replacements: {
          chatId, senderId: userId, content: safeQuestion,
          metadata: JSON.stringify({ pollId }),
        },
        type: sequelize.QueryTypes.INSERT, transaction: t,
      }
    );
    const messageId = msgResult[0].id;

    await sequelize.query(
      `UPDATE "ChatPolls" SET "messageId" = :messageId WHERE id = :pollId`,
      { replacements: { messageId, pollId }, transaction: t }
    );

    await sequelize.query(
      `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
      { replacements: { messageId, chatId }, transaction: t }
    );

    await t.commit();

    const payload = await buildPollPayload(sequelize, pollId, userId);

    // Broadcast the new poll message to chat participants the same way a
    // normal text message is delivered, so it appears live for everyone.
    try {
      const wsService = require('../services/webSocketService');
      const participants = await sequelize.query(
        `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
        { replacements: { chatId, senderId: userId }, type: sequelize.QueryTypes.SELECT }
      );
      const recipientIds = participants.map(p => p.userId);
      const populatedMessage = {
        id: messageId, chatId, senderId: userId, content: safeQuestion, type: 'poll',
        reactions: {}, metadata: { pollId }, poll: payload,
        sentAt: new Date().toISOString(), deliveredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      // FIX-ROOT-CAUSE-DUPLICATE: see matching fix in src/routes/messages.js —
      // sendToUser() already covers every participant socket; broadcastToChat()
      // on top of it double-delivers to sockets that are members of both the
      // user room and the chat room (every participant, in practice).
      await Promise.allSettled(recipientIds.map(uid => wsService.sendToUser(uid, 'message:new', populatedMessage)));
    } catch (_) { /* non-fatal — clients will see the poll on next fetch */ }

    res.status(201).json({ success: true, message: 'Poll created', data: { poll: payload, messageId } });
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[polls.js] Create poll error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create poll' });
  }
}));

// ============================================================================
// GET /api/polls/:pollId — Get current poll results
// ============================================================================
router.get('/:pollId', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const pollId = safeInt(req.params.pollId);
  if (!pollId) return res.status(400).json({ success: false, message: 'Invalid pollId' });

  const payload = await buildPollPayload(sequelize, pollId, userId);
  if (!payload) return res.status(404).json({ success: false, message: 'Poll not found' });

  if (!(await isParticipant(sequelize, payload.chatId, userId))) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  res.json({ success: true, data: { poll: payload } });
}));

// ============================================================================
// POST /api/polls/:pollId/vote — Cast or change a vote
// Body: { optionIds: number[] }  (single-element array for single-answer polls)
// ============================================================================
router.post('/:pollId/vote', apiRateLimiter, chatLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const pollId = safeInt(req.params.pollId);
  if (!pollId) return res.status(400).json({ success: false, message: 'Invalid pollId' });

  const rawOptionIds = Array.isArray(req.body.optionIds) ? req.body.optionIds : [req.body.optionId];
  const optionIds = [...new Set(rawOptionIds.map(safeInt).filter(Boolean))];
  if (optionIds.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one optionId is required' });
  }

  const [poll] = await sequelize.query(
    `SELECT id, "chatId", "allowMultipleAnswers", "isClosed", "closesAt" FROM "ChatPolls" WHERE id = :pollId LIMIT 1`,
    { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!poll) return res.status(404).json({ success: false, message: 'Poll not found' });

  if (!(await isParticipant(sequelize, poll.chatId, userId))) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const isExpired = poll.closesAt && new Date(poll.closesAt).getTime() < Date.now();
  if (poll.isClosed || isExpired) {
    return res.status(400).json({ success: false, message: 'This poll is closed and no longer accepting votes' });
  }

  if (!poll.allowMultipleAnswers && optionIds.length > 1) {
    return res.status(400).json({ success: false, message: 'This poll only allows a single answer' });
  }

  // Verify the submitted option IDs actually belong to this poll, to prevent
  // a vote being recorded against an unrelated poll's option.
  const validOptions = await sequelize.query(
    `SELECT id FROM "ChatPollOptions" WHERE "pollId" = :pollId AND id = ANY(:optionIds)`,
    { replacements: { pollId, optionIds }, type: sequelize.QueryTypes.SELECT }
  );
  if (validOptions.length !== optionIds.length) {
    return res.status(400).json({ success: false, message: 'One or more options do not belong to this poll' });
  }

  const t = await sequelize.transaction();
  try {
    // Changing a vote: clear the user's prior selections for this poll first,
    // so re-voting (including switching options or toggling multi-select)
    // always reflects only their latest submission.
    await sequelize.query(
      `DELETE FROM "ChatPollVotes" WHERE "pollId" = :pollId AND "userId" = :userId`,
      { replacements: { pollId, userId }, transaction: t }
    );
    for (const optionId of optionIds) {
      await sequelize.query(
        `INSERT INTO "ChatPollVotes" ("pollId","optionId","userId","createdAt") VALUES (:pollId,:optionId,:userId,NOW())`,
        { replacements: { pollId, optionId, userId }, transaction: t, type: sequelize.QueryTypes.INSERT }
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[polls.js] Vote error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to record vote' });
  }

  const payload = await buildPollPayload(sequelize, pollId, userId);
  broadcastPollUpdate(poll.chatId, { pollId, poll: payload });
  res.json({ success: true, message: 'Vote recorded', data: { poll: payload } });
}));

// ============================================================================
// DELETE /api/polls/:pollId/vote — Retract your vote entirely
// ============================================================================
router.delete('/:pollId/vote', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const pollId = safeInt(req.params.pollId);
  if (!pollId) return res.status(400).json({ success: false, message: 'Invalid pollId' });

  const [poll] = await sequelize.query(
    `SELECT id, "chatId", "isClosed" FROM "ChatPolls" WHERE id = :pollId LIMIT 1`,
    { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!poll) return res.status(404).json({ success: false, message: 'Poll not found' });
  if (!(await isParticipant(sequelize, poll.chatId, userId))) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  await sequelize.query(
    `DELETE FROM "ChatPollVotes" WHERE "pollId" = :pollId AND "userId" = :userId`,
    { replacements: { pollId, userId } }
  );

  const payload = await buildPollPayload(sequelize, pollId, userId);
  broadcastPollUpdate(poll.chatId, { pollId, poll: payload });
  res.json({ success: true, message: 'Vote retracted', data: { poll: payload } });
}));

// ============================================================================
// POST /api/polls/:pollId/close — Close a poll (creator only)
// ============================================================================
router.post('/:pollId/close', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const pollId = safeInt(req.params.pollId);
  if (!pollId) return res.status(400).json({ success: false, message: 'Invalid pollId' });

  const [poll] = await sequelize.query(
    `SELECT id, "chatId", "createdBy", "isClosed" FROM "ChatPolls" WHERE id = :pollId LIMIT 1`,
    { replacements: { pollId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!poll) return res.status(404).json({ success: false, message: 'Poll not found' });
  if (poll.createdBy !== userId) {
    return res.status(403).json({ success: false, message: 'Only the poll creator can close this poll' });
  }
  if (poll.isClosed) {
    return res.status(400).json({ success: false, message: 'Poll is already closed' });
  }

  await sequelize.query(
    `UPDATE "ChatPolls" SET "isClosed" = true, "closedAt" = NOW(), "closedBy" = :userId WHERE id = :pollId`,
    { replacements: { pollId, userId } }
  );

  const payload = await buildPollPayload(sequelize, pollId, userId);
  broadcastPollUpdate(poll.chatId, { pollId, poll: payload, closed: true });
  res.json({ success: true, message: 'Poll closed', data: { poll: payload } });
}));

module.exports = router;