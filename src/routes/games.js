// src/routes/games.js
// Games API — P1 fixes per MoodChat Games Audit Report
// Covers: server-side progress persistence, real leaderboard, challenge-a-friend,
//         share score/achievement to chat, basic anti-cheat
const express = require('express');
const router = express.Router();
// ── CRITICAL: Inject global.__socketIO into req.io so all handlers can emit ──
router.use((req, _, next) => { if (!req.io) req.io = global.__socketIO || null; next(); });

// ─── Model references ──────────────────────────────────────────────────────
let db, User, GameProgress, GameChallenge, Message, Notification, Friend;
try {
  db = require('../models');
  User          = db.models?.Users          || db.models?.User          || db.Users          || db.User;
  GameProgress  = db.models?.GameProgress   || db.GameProgress;
  GameChallenge = db.models?.GameChallenge  || db.GameChallenge;
  Message       = db.models?.Messages       || db.models?.Message       || db.Messages       || db.Message;
  Notification  = db.models?.Notifications  || db.models?.Notification  || db.Notifications  || db.Notification;
  Friend        = db.models?.Friends        || db.models?.Friend        || db.Friends        || db.Friend;
} catch (e) {
  console.error('[games] Model load error:', e.message);
}

// ─── Anti-cheat limits (per session = per hour) ────────────────────────────
const MAX_XP_PER_HOUR    = 5000;
const MAX_COINS_PER_HOUR = 3000;
const CHALLENGE_TTL_MS   = 48 * 60 * 60 * 1000; // 48-hour challenge window

// ─── Helper: get or create progress for a user ────────────────────────────
async function getOrCreate(userId) {
  if (!GameProgress) throw new Error('GameProgress model not loaded');
  const [rec] = await GameProgress.findOrCreate({
    where: { userId },
    defaults: { userId },
  });
  return rec;
}

// ─── Helper: emit socket event if io available ────────────────────────────
function emitTo(req, room, event, data) {
  const io = req.io || (req.app && req.app.get('io'));
  if (io) {
    io.to(`user:${room}`).emit(event, data);
    io.to(`user_${room}`).emit(event, data);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/games/progress  — load this user's saved progress
// ══════════════════════════════════════════════════════════════════════════════
router.get('/progress', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rec = await getOrCreate(userId);
    return res.json({
      ok: true,
      progress: {
        xp:           rec.xp,
        level:        rec.level,
        coins:        rec.coins,
        gems:         rec.gems,
        streak:       rec.streak,
        dayIndex:     rec.dayIndex,
        lastClaim:    rec.lastClaim,
        avatar:       rec.avatar,
        achievements: rec.achievements,
        shopOwned:    rec.shopOwned,
        bestScores:   rec.bestScores,
        totalGames:   rec.totalGames,
        totalPockets: rec.totalPockets,
        totalLevels:  rec.totalLevels,
        updatedAt:    rec.updatedAt,
      },
    });
  } catch (err) {
    console.error('[games] GET /progress:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/games/progress  — save / sync progress with anti-cheat
// ══════════════════════════════════════════════════════════════════════════════
router.post('/progress', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      xp, level, coins, gems, streak, dayIndex, lastClaim,
      avatar, achievements, shopOwned, bestScores,
      totalGames, totalPockets, totalLevels,
    } = req.body;

    const rec = await getOrCreate(userId);

    // ── Anti-cheat: session window check ─────────────────────────────────
    const now = Date.now();
    const sessionStart = rec.lastSessionAt ? new Date(rec.lastSessionAt).getTime() : 0;
    const inSameSession = (now - sessionStart) < 60 * 60 * 1000; // 1 hour

    let isFlagged = rec.isFlagged;

    if (inSameSession) {
      const xpGain    = (xp    ?? rec.xp)    - rec.xp;
      const coinGain  = (coins ?? rec.coins) - rec.coins;
      if (xpGain > MAX_XP_PER_HOUR || coinGain > MAX_COINS_PER_HOUR) {
        isFlagged = true;
        console.warn(`[games] Anti-cheat flag userId=${userId} xpGain=${xpGain} coinGain=${coinGain}`);
        // Cap the gains instead of rejecting entirely
        const cappedXp    = rec.xp    + Math.min(xpGain, MAX_XP_PER_HOUR);
        const cappedCoins = rec.coins + Math.min(coinGain, MAX_COINS_PER_HOUR);
        await rec.update({
          xp: cappedXp, level, coins: cappedCoins, gems,
          streak, dayIndex, lastClaim, avatar,
          achievements: achievements || rec.achievements,
          shopOwned:    shopOwned    || rec.shopOwned,
          bestScores:   bestScores   || rec.bestScores,
          totalGames, totalPockets, totalLevels,
          isFlagged,
          lastSessionXp:    cappedXp,
          lastSessionCoins: cappedCoins,
        });
        return res.json({ ok: true, flagged: true });
      }
    }

    // Normal save
    await rec.update({
      xp:    xp    ?? rec.xp,
      level: level ?? rec.level,
      coins: coins ?? rec.coins,
      gems:  gems  ?? rec.gems,
      streak:   streak   ?? rec.streak,
      dayIndex: dayIndex ?? rec.dayIndex,
      lastClaim: lastClaim ?? rec.lastClaim,
      avatar: avatar ?? rec.avatar,
      achievements: achievements || rec.achievements,
      shopOwned:    shopOwned    || rec.shopOwned,
      bestScores:   bestScores   || rec.bestScores,
      totalGames:   totalGames   ?? rec.totalGames,
      totalPockets: totalPockets ?? rec.totalPockets,
      totalLevels:  totalLevels  ?? rec.totalLevels,
      isFlagged,
      lastSessionXp:    xp    ?? rec.xp,
      lastSessionCoins: coins ?? rec.coins,
      lastSessionAt:    new Date(),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[games] POST /progress:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/games/leaderboard?tab=alltime|weekly|daily  — REAL leaderboard
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leaderboard', async (req, res) => {
  try {
    if (!GameProgress || !User) return res.status(503).json({ error: 'Service unavailable' });

    const { tab = 'alltime', gameType = 'pool', limit = 50 } = req.query;
    const userId = req.user?.id || req.userId;

    // Build where clause for time-based tabs
    let where = {};
    if (tab === 'weekly') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      where.updatedAt = { [db.Sequelize?.Op?.gte || require('sequelize').Op.gte]: weekAgo };
    } else if (tab === 'daily') {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      where.updatedAt = { [db.Sequelize?.Op?.gte || require('sequelize').Op.gte]: dayAgo };
    }

    const records = await GameProgress.findAll({
      where: { ...where, isFlagged: false },
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'username', 'displayName'],
        required: true,
      }],
      order: [['xp', 'DESC']],
      limit: parseInt(limit) || 50,
    });

    const entries = records.map((r, i) => ({
      rank:       i + 1,
      userId:     r.userId,
      name:       r.user?.displayName || r.user?.username || 'Player',
      avatar:     r.avatar,
      xp:         r.xp,
      level:      r.level,
      bestScore:  r.bestScores?.[gameType] || 0,
      isMe:       r.userId === userId,
    }));

    // Always ensure current user is in the list even if outside top 50
    if (userId && !entries.find(e => e.isMe)) {
      try {
        const myRec = await getOrCreate(userId);
        const myUser = await User.findByPk(userId, { attributes: ['username', 'displayName'] });
        const totalAbove = await GameProgress.count({ where: { ...where, isFlagged: false, xp: { [db.Sequelize?.Op?.gt || require('sequelize').Op.gt]: myRec.xp } } });
        entries.push({
          rank:      totalAbove + 1,
          userId,
          name:      myUser?.displayName || myUser?.username || 'You',
          avatar:    myRec.avatar,
          xp:        myRec.xp,
          level:     myRec.level,
          bestScore: myRec.bestScores?.[gameType] || 0,
          isMe:      true,
        });
      } catch (_) { /* non-critical */ }
    }

    return res.json({ ok: true, tab, entries });
  } catch (err) {
    console.error('[games] GET /leaderboard:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/games/leaderboard/friends  — friends-only leaderboard
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leaderboard/friends', async (req, res) => {
  try {
    if (!GameProgress || !User || !Friend) return res.status(503).json({ error: 'Service unavailable' });

    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Get friend IDs
    const { Op } = db.Sequelize || require('sequelize');
    const friendships = await Friend.findAll({
      where: {
        [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
        status: 'accepted',
      },
      attributes: ['requesterId', 'receiverId'],
    });
    const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);
    friendIds.push(userId); // include self

    const records = await GameProgress.findAll({
      where: { userId: { [Op.in]: friendIds }, isFlagged: false },
      include: [{ model: User, as: 'user', attributes: ['id', 'username', 'displayName'], required: true }],
      order: [['xp', 'DESC']],
    });

    const entries = records.map((r, i) => ({
      rank:  i + 1,
      userId: r.userId,
      name:   r.user?.displayName || r.user?.username || 'Player',
      avatar: r.avatar,
      xp:     r.xp,
      level:  r.level,
      isMe:   r.userId === userId,
    }));

    return res.json({ ok: true, entries });
  } catch (err) {
    console.error('[games] GET /leaderboard/friends:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/games/challenges  — send a challenge to a friend
// ══════════════════════════════════════════════════════════════════════════════
router.post('/challenges', async (req, res) => {
  try {
    if (!GameChallenge) return res.status(503).json({ error: 'Service unavailable' });

    const challengerId = req.user?.id || req.userId;
    if (!challengerId) return res.status(401).json({ error: 'Unauthorized' });

    const { gameType, score, targetFriendId } = req.body;
    if (!gameType || !targetFriendId || score == null) {
      return res.status(400).json({ error: 'gameType, score, and targetFriendId are required' });
    }

    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const challenge = await GameChallenge.create({
      challengerId,
      targetId: targetFriendId,
      gameType,
      challengerScore: score,
      status: 'pending',
      expiresAt,
    });

    // Fetch challenger name for notification
    let challengerName = 'Someone';
    if (User) {
      const u = await User.findByPk(challengerId, { attributes: ['username', 'displayName'] });
      challengerName = u?.displayName || u?.username || 'Someone';
    }

    // Notify target via socket
    const payload = {
      challengeId:      challenge.id,
      challengerId,
      challengerName,
      gameType,
      challengerScore:  score,
      expiresAt,
    };
    emitTo(req, targetFriendId, 'game:challenge', payload);

    // Persist notification if model available
    if (Notification) {
      await Notification.create({
        userId: targetFriendId,
        type:   'info',
        title:  `${challengerName} challenged you!`,
        body:   `Beat their score of ${score.toLocaleString()} in ${gameType}!`,
        data:   payload,
      }).catch(() => {});
    }

    return res.status(201).json({ ok: true, challengeId: challenge.id });
  } catch (err) {
    console.error('[games] POST /challenges:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/games/challenges/:id/result  — submit result of a challenge
// ══════════════════════════════════════════════════════════════════════════════
router.post('/challenges/:id/result', async (req, res) => {
  try {
    if (!GameChallenge) return res.status(503).json({ error: 'Service unavailable' });

    const targetId = req.user?.id || req.userId;
    if (!targetId) return res.status(401).json({ error: 'Unauthorized' });

    const challenge = await GameChallenge.findByPk(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (challenge.targetId !== targetId) return res.status(403).json({ error: 'Forbidden' });
    if (challenge.status !== 'pending') return res.status(409).json({ error: 'Challenge already resolved' });
    if (new Date() > challenge.expiresAt) {
      await challenge.update({ status: 'expired' });
      return res.status(410).json({ error: 'Challenge expired' });
    }

    const { score } = req.body;
    if (score == null) return res.status(400).json({ error: 'score is required' });

    let result = 'draw';
    if (score > challenge.challengerScore)  result = 'target_wins';
    else if (score < challenge.challengerScore) result = 'challenger_wins';

    await challenge.update({ targetScore: score, status: 'completed', result });

    // Notify challenger of result
    let targetName = 'Your friend';
    if (User) {
      const u = await User.findByPk(targetId, { attributes: ['username', 'displayName'] });
      targetName = u?.displayName || u?.username || 'Your friend';
    }

    const resultPayload = {
      challengeId:     challenge.id,
      gameType:        challenge.gameType,
      challengerScore: challenge.challengerScore,
      targetScore:     score,
      result,
      targetName,
    };

    emitTo(req, challenge.challengerId, 'game:challenge:result', resultPayload);

    if (Notification) {
      const msg = result === 'target_wins'
        ? `${targetName} beat your score! 🎉`
        : result === 'challenger_wins'
        ? `${targetName} tried but couldn't beat you! 💪`
        : `${targetName} matched your score exactly! 🤝`;
      await Notification.create({
        userId: challenge.challengerId,
        type:   'info',
        title:  `Challenge result in ${challenge.gameType}`,
        body:   msg,
        data:   resultPayload,
      }).catch(() => {});
    }

    return res.json({ ok: true, result });
  } catch (err) {
    console.error('[games] POST /challenges/:id/result:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/games/challenges  — get pending challenges for current user
// ══════════════════════════════════════════════════════════════════════════════
router.get('/challenges', async (req, res) => {
  try {
    if (!GameChallenge) return res.status(503).json({ error: 'Service unavailable' });

    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { Op } = db.Sequelize || require('sequelize');
    const challenges = await GameChallenge.findAll({
      where: {
        [Op.or]: [{ challengerId: userId }, { targetId: userId }],
        status: { [Op.in]: ['pending', 'completed'] },
        expiresAt: { [Op.gt]: new Date() },
      },
      include: User ? [
        { model: User, as: 'challenger', attributes: ['id', 'username', 'displayName'] },
        { model: User, as: 'target',     attributes: ['id', 'username', 'displayName'] },
      ] : [],
      order: [['createdAt', 'DESC']],
      limit: 20,
    });

    return res.json({ ok: true, challenges });
  } catch (err) {
    console.error('[games] GET /challenges:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/games/share  — share score or achievement to a chat/group
// ══════════════════════════════════════════════════════════════════════════════
router.post('/share', async (req, res) => {
  try {
    if (!Message) return res.status(503).json({ error: 'Message model unavailable' });

    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { chatId, groupId, gameType, score, achievementName, achievementIcon, shareType } = req.body;

    if (!chatId && !groupId) return res.status(400).json({ error: 'chatId or groupId required' });

    let text;
    if (shareType === 'achievement') {
      text = `🏆 Achievement Unlocked: ${achievementIcon || ''} ${achievementName || 'Achievement'}!`;
    } else {
      const gameName = { pool: 'Pool 🎱', water: 'Water Sort 💧', block: 'Block Puzzle 🧩', crossword: 'Crossword Jam 📖', trivia: 'Trivia Master 🧠' }[gameType] || gameType;
      text = `🎮 I scored ${Number(score).toLocaleString()} in ${gameName}! Can you beat it?`;
    }

    // Build message payload matching existing messages schema
    const msgData = {
      senderId:    userId,
      content:     text,
      messageType: 'text',
      metadata:    { gameShare: true, gameType, score, achievementName },
    };
    if (chatId)  msgData.chatId  = chatId;
    if (groupId) msgData.groupId = groupId;

    const msg = await Message.create(msgData);

    // Emit to recipients via socket
    const io = req.io || (req.app && req.app.get('io'));
    if (io) {
      const room = chatId ? `chat:${chatId}` : `group:${groupId}`;
      io.to(room).emit('message:new', { message: msg });
    }

    return res.status(201).json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error('[games] POST /share:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/games/push/subscribe — register a push subscription for reminders
// ══════════════════════════════════════════════════════════════════════════════
router.post('/push/subscribe', async (req, res) => {
  try {
    const PushSubscription = db.models?.PushSubscription || db.PushSubscription;
    if (!PushSubscription) return res.status(503).json({ error: 'Service unavailable' });

    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }

    await PushSubscription.upsert({
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      gameRemindersEnabled: true,
    });

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[games] POST /push/subscribe:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/games/push/unsubscribe — disable game reminders for this device
// ══════════════════════════════════════════════════════════════════════════════
router.post('/push/unsubscribe', async (req, res) => {
  try {
    const PushSubscription = db.models?.PushSubscription || db.PushSubscription;
    if (!PushSubscription) return res.status(503).json({ error: 'Service unavailable' });

    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    await PushSubscription.update(
      { gameRemindersEnabled: false },
      { where: { userId, endpoint } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[games] POST /push/unsubscribe:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/games/push/vapid-public-key — expose VAPID public key for subscription
// (Also mountable at /api/push/vapid-public-key if a global push router exists)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  return res.json({ key });
});

module.exports = router;