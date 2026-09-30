// src/routes/games.js
// Games API — P1 fixes per Necpa Games Audit Report
// Covers: server-side progress persistence, real leaderboard, challenge-a-friend,
//         share score/achievement to chat, basic anti-cheat
const express = require('express');
const router = express.Router();
// ── CRITICAL: Inject global.__socketIO into req.io so all handlers can emit ──
router.use((req, _, next) => { if (!req.io) req.io = global.__socketIO || null; next(); });

// ─── Model references ──────────────────────────────────────────────────────
let db, User, GameProgress, GameChallenge, Message, Notification, Friend, Wallet, WalletTransaction;
try {
  db = require('../models');
  User          = db.models?.Users          || db.models?.User          || db.Users          || db.User;
  GameProgress  = db.models?.GameProgress   || db.GameProgress;
  GameChallenge = db.models?.GameChallenge  || db.GameChallenge;
  Message       = db.models?.Messages       || db.models?.Message       || db.Messages       || db.Message;
  Notification  = db.models?.Notifications  || db.models?.Notification  || db.Notifications  || db.Notification;
  Friend        = db.models?.Friends        || db.models?.Friend        || db.Friends        || db.Friend;
  Wallet        = db.models?.Wallet         || db.Wallet;
  WalletTransaction = db.models?.WalletTransaction || db.WalletTransaction;
} catch (e) {
  console.error('[games] Model load error:', e.message);
}

// Wallet models are registered after this module is first required, so resolve them per request
// (covers both /coins/mpesa/stk and /coins/payment-callback, which credits the coins).
router.use((req, _res, next) => {
  if (db) {
    if (!Wallet) Wallet = db.models?.Wallet || db.Wallet || null;
    if (!WalletTransaction) WalletTransaction = db.models?.WalletTransaction || db.WalletTransaction || null;
  }
  next();
});

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
//
// SECURITY FIX (audit-driven — was: IDOR / unauthorized message injection):
// this route had no membership check at all — any authenticated user could
// POST a fabricated "game share" message into ANY chatId or groupId they
// specified, regardless of whether they were actually a participant.
// Traced this route's frontend caller as part of the same pass: no
// frontend code anywhere in the repo actually calls POST /games/share (no
// matching request found for its exact parameter shape), so — like the
// disconnected poll system flagged separately in the audit — this isn't
// leaking through the app's normal UI today, but it was still a live,
// reachable, unauthenticated-by-membership endpoint. Content here (a
// score/achievement announcement) is server-generated from low-sensitivity
// data, not user-typed free text, so unlike status replies this was left
// as plaintext rather than retrofitted with client-side encryption it has
// no client-side caller to supply — the IDOR is the real, serious part of
// this finding, and that's what's fixed.
router.post('/share', async (req, res) => {
  try {
    if (!Message) return res.status(503).json({ error: 'Message model unavailable' });

    const userId = req.user?.id || req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { chatId, groupId, gameType, score, achievementName, achievementIcon, shareType } = req.body;

    if (!chatId && !groupId) return res.status(400).json({ error: 'chatId or groupId required' });

    const models = req.app.locals.models;
    if (chatId) {
      const ChatParticipant = models?.ChatParticipant;
      const ok = ChatParticipant && typeof ChatParticipant.isUserInChat === 'function'
        ? await ChatParticipant.isUserInChat(userId, chatId).catch(() => false)
        : false;
      if (!ok) return res.status(403).json({ error: 'You are not a participant of this chat' });
    }
    if (groupId) {
      const GroupMembers = models?.GroupMembers;
      const member = GroupMembers
        ? await GroupMembers.findOne({ where: { groupId, userId } }).catch(() => null)
        : null;
      if (!member) return res.status(403).json({ error: 'You are not a member of this group' });
    }

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

const crypto = require('crypto');
const GameRoom = db?.models?.GameRoom || db?.GameRoom || (typeof db?.getModel === 'function' ? db.getModel('GameRoom') : null);
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const ROOM_GAMES = new Set(['water','block','trivia','crossword','chess']);
const MULTI_GAMES = new Set(['trivia','crossword']);
const ROOM_MAX_PLAYERS = 50;
const roomTtlMsFor = gameType => MULTI_GAMES.has(String(gameType)) || String(gameType)==='chess' ? ROOM_TTL_MS : 30*60*1000;
function roomPlayers(room){const raw=room.state&&Array.isArray(room.state.players)?room.state.players:null;if(raw&&raw.length)return raw;const p=[{userId:room.hostId,role:'host',score:room.hostScore,timeMs:null,answered:0,correct:0,progress:0,currentLevel:room.level,completed:false}];if(room.guestId)p.push({userId:room.guestId,role:'guest',score:room.guestScore,timeMs:null,answered:0,correct:0,progress:0,currentLevel:room.level,completed:false});return p;}

// POST /api/games/progress/coins/spend — server-authoritative coin spending for game hints/continues.
router.post('/progress/coins/spend',async(req,res)=>{
  try{
    const userId=req.user?.id||req.userId;if(!userId)return res.status(401).json({error:'Unauthorized'});
    const amount=Math.max(1,Math.min(10000,Math.floor(Number(req.body?.amount)||0)));
    const reason=String(req.body?.reason||'game-item').slice(0,80);
    const rec=await getOrCreate(userId);
    if(Number(rec.coins||0)<amount)return res.status(409).json({error:'Not enough coins',coins:Number(rec.coins||0)});
    await rec.update({coins:Number(rec.coins||0)-amount,lastSessionAt:new Date()});
    return res.json({ok:true,coins:Number(rec.coins||0),reason});
  }catch(err){console.error('[games] POST /progress/coins/spend:',err.message);return res.status(500).json({error:'Server error'});}
});

function mpesaBase(){return String(process.env.MPESA_ENV||'sandbox').toLowerCase()==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke'}
function normalizeMsisdn(v){let s=String(v||'').replace(/\D/g,'');if(s.startsWith('254'))s=s;else if(s.startsWith('0'))s='254'+s.slice(1);else if(/^[71]\d{8}$/.test(s))s='254'+s;return /^254[71]\d{8}$/.test(s)?s:null}
function mpesaTimestamp(){const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())}
async function mpesaToken(){
  const key=process.env.MPESA_CONSUMER_KEY,secret=process.env.MPESA_CONSUMER_SECRET;if(!key||!secret)throw new Error('M-Pesa credentials are not configured');
  const auth=Buffer.from(key+':'+secret).toString('base64');
  const r=await fetch(mpesaBase()+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+auth}});
  const j=await r.json();if(!r.ok||!j.access_token)throw new Error(j.errorMessage||'Could not authenticate with Daraja');return j.access_token;
}
router.post('/coins/mpesa/stk',async(req,res)=>{
  try{
    const userId=req.user?.id||req.userId;if(!userId)return res.status(401).json({error:'Unauthorized'});
    // Resolve lazily: at require() time the Wallet models are not registered yet, so the
    // module-level Wallet/WalletTransaction stay undefined forever and this route 503s.
    const WalletM=Wallet||db?.models?.Wallet||db?.Wallet, WalletTxM=WalletTransaction||db?.models?.WalletTransaction||db?.WalletTransaction;
    if(!WalletM||!WalletTxM)return res.status(503).json({error:'Payment wallet is unavailable'});
    const amount=Math.max(1,Math.min(150000,Math.floor(Number(req.body?.amount)||0))),phone=normalizeMsisdn(req.body?.phone);
    if(!phone)return res.status(400).json({error:'Valid Kenyan M-Pesa number required'});
    const shortCode=process.env.MPESA_SHORTCODE,passkey=process.env.MPESA_PASSKEY,callback=process.env.MPESA_GAME_CALLBACK_URL;
    const missing=[!shortCode&&'MPESA_SHORTCODE',!passkey&&'MPESA_PASSKEY',!callback&&'MPESA_GAME_CALLBACK_URL',!process.env.MPESA_CONSUMER_KEY&&'MPESA_CONSUMER_KEY',!process.env.MPESA_CONSUMER_SECRET&&'MPESA_CONSUMER_SECRET'].filter(Boolean);
    if(missing.length){console.error('[games] M-Pesa not configured, missing env:',missing.join(', '));return res.status(503).json({error:'Coin purchase is temporarily unavailable. Please try again later.'});}
    const [wallet]=await WalletM.findOrCreate({where:{userId},defaults:{userId,currency:'KES',balance:0}});
    const reference='GC'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(5).toString('hex').toUpperCase();
    const coins=amount*2;
    await WalletTxM.create({walletId:wallet.id,userId,type:'credit',amount,currency:'KES',balanceAfter:Number(wallet.balance||0),reference,description:'Pending Necpra game coin purchase',metadata:{status:'pending',gameCoins:coins}});
    const ts=mpesaTimestamp(),password=Buffer.from(String(shortCode)+String(passkey)+ts).toString('base64'),token=await mpesaToken();
    const payload={BusinessShortCode:String(shortCode),Password:password,Timestamp:ts,TransactionType:process.env.MPESA_TRANSACTION_TYPE||'CustomerPayBillOnline',Amount:amount,PartyA:phone,PartyB:String(shortCode),PhoneNumber:phone,CallBackURL:callback,AccountReference:reference.slice(0,20),TransactionDesc:'Necpra game coins'};
    const r=await fetch(mpesaBase()+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({}));if(!r.ok||j.ResponseCode!=='0'&&j.ResponseCode!==0){await WalletTxM.update({metadata:{status:'failed',gameCoins:coins,providerResponse:j}},{where:{reference}});return res.status(502).json({error:j.errorMessage||j.ResponseDescription||'M-Pesa request failed'});}
    await WalletTxM.update({metadata:{status:'pending',gameCoins:coins,checkoutRequestId:j.CheckoutRequestID||null,merchantRequestId:j.MerchantRequestID||null}},{where:{reference}});
    return res.status(202).json({ok:true,reference,checkoutRequestId:j.CheckoutRequestID||null,coins,amount});
  }catch(err){console.error('[games] POST /coins/mpesa/stk:',err.stack||err.message);return res.status(500).json({error:err.message||'Payment request failed'});}
});

// POST /api/games/coins/payment-callback — public Daraja callback; URL intentionally avoids provider keywords.
router.post('/coins/payment-callback',async(req,res)=>{
  try{
    const body=req.body||{},cb=body.Body?.stkCallback||body.Result?.Result||body.Result||{};
    const code=Number(cb.ResultCode??cb.resultCode??-1),items=cb.CallbackMetadata?.Item||cb.ResultParameters?.ResultParameter||[];
    const get=(...keys)=>{const x=items.find(i=>keys.includes(String(i.Name??i.Key)));return x?.Value};
    const reference=String(get('AccountReference','BillRefNumber')||'');
    if(!reference.startsWith('GC'))return res.json({ResultCode:0,ResultDesc:'Accepted'});
    if(!WalletTransaction)return res.json({ResultCode:0,ResultDesc:'Accepted'});
    const tx=await WalletTransaction.findOne({where:{reference}});if(!tx)return res.json({ResultCode:0,ResultDesc:'Accepted'});
    if(String(tx.metadata?.status||'')!=='pending')return res.json({ResultCode:0,ResultDesc:'Already processed'});
    if(code!==0){
      await tx.update({metadata:{...(tx.metadata||{}),status:'failed',resultCode:code,resultDesc:String(cb.ResultDesc||'Payment failed').slice(0,500)}});return res.json({ResultCode:0,ResultDesc:'Accepted'});
    }
    const wallet=Wallet?await Wallet.findByPk(tx.walletId):null;if(!wallet)return res.json({ResultCode:0,ResultDesc:'Accepted'});
    const coins=Math.max(0,Number(tx.metadata?.gameCoins)||Math.floor(Number(tx.amount)*2));
    const nextBalance=Number(wallet.balance||0)+Number(tx.amount||0);
    await wallet.update({balance:nextBalance});
    await tx.update({balanceAfter:nextBalance,metadata:{...(tx.metadata||{}),status:'completed',receipt:get('MpesaReceiptNumber','TransactionReceipt')||null,completedAt:new Date().toISOString()}});
    const rec=await getOrCreate(tx.userId);await rec.update({coins:Number(rec.coins||0)+coins,lastSessionAt:new Date()});
    emitTo(req,tx.userId,'games:coins:credited',{coins,totalCoins:Number(rec.coins||0),reference});
    return res.json({ResultCode:0,ResultDesc:'Accepted'});
  }catch(err){console.error('[games] payment callback:',err.stack||err.message);return res.json({ResultCode:0,ResultDesc:'Accepted'});}
});

function roomCode(){
  return crypto.randomBytes(5).toString('base64').replace(/[^A-Z0-9]/gi,'').toUpperCase().slice(0,8);
}
async function uniqueRoomCode(){
  for(let i=0;i<8;i++){
    const code=roomCode();
    if(GameRoom && !(await GameRoom.findOne({where:{code}}))) return code;
  }
  throw new Error('Could not allocate room code');
}
function freshScoreAlready(room,role){return role==='host'?room.hostScore!=null:room.guestScore!=null}
function sameUser(a,b){return a!=null&&b!=null&&String(a)===String(b)}
function roomPlayer(room,userId){
  const found=roomPlayers(room).find(p=>sameUser(p.userId,userId));
  if(found)return found.role;
  if(sameUser(room.hostId,userId))return 'host';
  if(sameUser(room.guestId,userId))return 'guest';
  return null;
}
function roomPayload(room){
  return {
    id:room.id,code:room.code,gameType:room.gameType,level:room.level,seed:room.seed,
    hostId:room.hostId,guestId:room.guestId,targetUserId:room.targetUserId,
    status:room.status,hostScore:room.hostScore,guestScore:room.guestScore,
    winnerId:room.winnerId,state:room.state,rewardCoins:Number(room.state?.rewardCoins||0),rewardedUserId:room.state?.rewardedUserId||null,rewardedUserIds:room.state?.rewardedUserIds||[],expiresAt:room.expiresAt,maxPlayers:MULTI_GAMES.has(room.gameType)?ROOM_MAX_PLAYERS:2,players:roomPlayers(room).map(p=>({userId:p.userId,role:p.role,score:p.score??null,timeMs:p.timeMs??null,answered:p.answered||0,correct:p.correct||0,progress:p.progress||0,currentLevel:p.currentLevel||room.level,completed:!!p.completed,joinedAt:p.joinedAt||null,snapshot:p.snapshot||null}))
  };
}
function emitRoom(req,room,event='game:room:update'){
  const io=req.io||(req.app&&req.app.get('io'));
  if(!io)return;
  const payload=roomPayload(room);
  roomPlayers(room).map(p=>p.userId).filter(Boolean).forEach(id=>{
    io.to(`user:${id}`).emit(event,payload);
    io.to(`user_${id}`).emit(event,payload);
  });
}

// POST /api/games/rooms — create a private two-player game room.
// targetUserId is optional; when supplied, only that exact account can join.
router.post('/rooms',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const {gameType,level=1,targetUserId=null,subject=null}=req.body||{};
    if(!ROOM_GAMES.has(String(gameType)))return res.status(400).json({error:'Unsupported game'});
    if(targetUserId&&Number(targetUserId)===Number(userId))return res.status(400).json({error:'You cannot invite yourself'});
    if(targetUserId&&Friend){
      const {Op}=db.Sequelize||require('sequelize');
      const friend=await Friend.findOne({where:{
        status:'accepted',
        [Op.or]:[
          {requesterId:userId,receiverId:Number(targetUserId)},
          {requesterId:Number(targetUserId),receiverId:userId}
        ]
      }});
      if(!friend)return res.status(403).json({error:'You can only invite an accepted friend'});
    }
    const code=await uniqueRoomCode();
    const seed=crypto.randomBytes(12).toString('hex');
    const room=await GameRoom.create({
      code,gameType:String(gameType),level:Math.max(1,Math.min(100000,Number(level)||1)),
      hostId:userId,targetUserId:targetUserId?Number(targetUserId):null,seed,
      expiresAt:new Date(Date.now()+roomTtlMsFor(String(gameType))),state:{subject:subject?String(subject).slice(0,30):null,players:[{userId,role:'host',score:null,timeMs:null,answered:0,correct:0,progress:0,currentLevel:Number(level)||1,completed:false,joinedAt:new Date().toISOString()}]}
    });
    return res.status(201).json({ok:true,room:roomPayload(room),role:'host'});
  }catch(err){
    console.error('[games] POST /rooms:',err.stack || err.message);
    return res.status(500).json({error:'Server error'});
  }
});

// GET /api/games/rooms/:code — requires the secret code and authentication.
// It never exposes room data through a public listing.
router.get('/rooms/:code',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const room=await GameRoom.findOne({where:{code:String(req.params.code).toUpperCase()}});
    if(!room)return res.status(404).json({error:'Room not found'});
    if(new Date()>room.expiresAt&&room.status!=='finished'){
      await room.update({status:'closed'});
      return res.status(410).json({error:'Room expired'});
    }
    const role=roomPlayer(room,userId);
    if(!role&&room.targetUserId&&room.targetUserId!==userId)return res.status(403).json({error:'This invitation is for another player'});
    if(!role)return res.status(403).json({error:'Join this room with its invitation code'});
    return res.json({ok:true,room:roomPayload(room),role});
  }catch(err){
    console.error('[games] GET /rooms/:code:',err.stack || err.message);
    return res.status(500).json({error:'Server error'});
  }
});

// POST /api/games/rooms/:code/join — exact-code join, with optional target-account lock.
router.post('/rooms/:code/join',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const room=await GameRoom.findOne({where:{code:String(req.params.code).toUpperCase()}});
    if(!room)return res.status(404).json({error:'Invalid game code'});
    if(new Date()>room.expiresAt||room.status==='closed')return res.status(410).json({error:'This game invitation has expired'});
    if(room.status==='finished')return res.status(409).json({error:'This match is already finished'});
    if(room.hostId===userId)return res.json({ok:true,room:roomPayload(room),role:'host'});
    if(room.targetUserId&&room.targetUserId!==userId)return res.status(403).json({error:'This invitation was not sent to your account'});
    const players=roomPlayers(room),existing=players.find(p=>Number(p.userId)===Number(userId));
    if(existing)return res.json({ok:true,room:roomPayload(room),role:existing.role});
    const multi=MULTI_GAMES.has(room.gameType);
    if(!multi&&room.guestId&&room.guestId!==userId)return res.status(409).json({error:'This game already has another guest'});
    if(multi&&players.length>=ROOM_MAX_PLAYERS)return res.status(409).json({error:'This match is full'});
    const role=multi?'player-'+(players.length+1):'guest';
    players.push({userId,role,score:null,timeMs:null,answered:0,correct:0,progress:0,currentLevel:room.level,completed:false,joinedAt:new Date().toISOString()});
    await room.update({guestId:room.guestId||(!multi?userId:null),status:'playing',state:{...(room.state||{}),players,matchStartedAt:room.state?.matchStartedAt||new Date().toISOString()}});
    emitRoom(req,room);
    return res.json({ok:true,room:roomPayload(room),role});
  }catch(err){
    console.error('[games] POST /rooms/:code/join:',err.stack || err.message);
    return res.status(500).json({error:'Server error'});
  }
});

// POST /api/games/rooms/:code/change-game — same two players can reuse their private code for a different game.
router.post('/rooms/:code/change-game',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;if(!userId)return res.status(401).json({error:'Unauthorized'});
    const room=await GameRoom.findOne({where:{code:String(req.params.code).toUpperCase()}});
    if(!room)return res.status(404).json({error:'Room not found'});
    const role=roomPlayer(room,userId);if(!role)return res.status(403).json({error:'Only the existing players can reuse this code'});
    if(room.status==='closed')return res.status(409).json({error:'This game code is closed'});
    if(new Date()>room.expiresAt)return res.status(410).json({error:'This game code has expired'});
    const gameType=String(req.body?.gameType||'');
    if(!ROOM_GAMES.has(gameType))return res.status(400).json({error:'Unsupported game'});
    const players=roomPlayers(room);
    if(players.length<2)return res.status(409).json({error:'Wait for the other player before changing games'});
    const nextLevel=Math.max(1,Math.min(100000,Number(req.body?.level)||1));
    const nextSeed=crypto.randomBytes(12).toString('hex');
    const nextPlayers=players.map((p,i)=>({...p,score:null,timeMs:null,answered:0,correct:0,progress:0,currentLevel:nextLevel,completed:false,joinedAt:p.joinedAt||new Date().toISOString(),rank:null,rewardCoins:0}));
    await room.update({
      gameType,level:nextLevel,seed:nextSeed,status:'playing',hostScore:null,guestScore:null,winnerId:null,
      expiresAt:new Date(Date.now()+roomTtlMsFor(gameType)),
      state:{subject:req.body?.subject?String(req.body.subject).slice(0,30):null,players:nextPlayers,matchStartedAt:new Date().toISOString(),results:[]}
    });
    emitRoom(req,room);return res.json({ok:true,room:roomPayload(room),role});
  }catch(err){console.error('[games] POST /rooms/:code/change-game:',err.stack||err.message);return res.status(500).json({error:'Server error'});}
});

// POST /api/games/rooms/:code/state — only room members can publish game state.
router.post('/rooms/:code/state',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const room=await GameRoom.findOne({where:{code:String(req.params.code).toUpperCase()}});
    if(!room)return res.status(404).json({error:'Room not found'});
    const role=roomPlayer(room,userId);
    if(!role)return res.status(403).json({error:'You are not a player in this room'});
    if(new Date()>room.expiresAt)return res.status(410).json({error:'Room expired'});
    const incoming=req.body&&req.body.state&&typeof req.body.state==='object'?req.body.state:{};
    const players=roomPlayers(room);
    const me=players.find(p=>Number(p.userId)===Number(userId));
    if(!me)return res.status(403).json({error:'You are not a player in this room'});
    const numeric=['answered','correct','score','timeMs','progress','currentLevel'];
    numeric.forEach(f=>{if(incoming[f]!==undefined){const n=Number(incoming[f]);if(Number.isFinite(n))me[f]=Math.max(0,Math.floor(n));}});
    ['position','turn','lastMove','result'].forEach(f=>{if(typeof incoming[f]==='string')me[f]=incoming[f].slice(0,f==='position'?20000:500);});
    me.progress=Math.min(100,Number(me.progress)||0);
    if(incoming.snapshot&&typeof incoming.snapshot==='object'){try{const raw=JSON.stringify(incoming.snapshot);if(raw.length<=20000)me.snapshot=JSON.parse(raw)}catch(_){}}
    const mergedState={...(room.state||{}),players};
    if(role==='host'&&incoming.subject)mergedState.subject=String(incoming.subject).slice(0,30);
    if(room.gameType==='chess'){
      // position = board|turn|ep|rights|ply. Host plays white (odd plies), guest plays black (even plies).
      const isWhite=role==='host';
      if(typeof incoming.position==='string'){
        const inPly=Number(incoming.position.split('|')[4])||0;
        const curPly=Number(String(mergedState.position||'').split('|')[4])||0;
        const noPos=!mergedState.position;
        const validMove=inPly===curPly+1&&((inPly%2===1)===isWhite);
        if(validMove||(noPos&&inPly===0)){
          mergedState.position=incoming.position.slice(0,20000);
          if(typeof incoming.turn==='string')mergedState.turn=incoming.turn.slice(0,1);
          if(typeof incoming.lastMove==='string')mergedState.lastMove=incoming.lastMove.slice(0,500);
        }
      }
      if(typeof incoming.result==='string'&&incoming.result.startsWith('resign:')&&incoming.result.slice(7)===(isWhite?'w':'b'))mergedState.result=incoming.result.slice(0,30);
    }
    const patch={state:mergedState,status:(room.guestId||MULTI_GAMES.has(room.gameType))?'playing':'waiting'};
    if(req.body&&req.body.score!=null)patch[role==='host'?'hostScore':'guestScore']=Math.max(0,Math.floor(Number(req.body.score)||0));
    await room.update(patch);
    emitRoom(req,room);
    return res.json({ok:true,room:roomPayload(room)});
  }catch(err){
    console.error('[games] POST /rooms/:code/state:',err.message);
    return res.status(500).json({error:'Server error'});
  }
});

// POST /api/games/rooms/:code/result — members submit their completion; server decides winner.
router.post('/rooms/:code/result',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const room=await GameRoom.findOne({where:{code:String(req.params.code).toUpperCase()}});
    if(!room)return res.status(404).json({error:'Room not found'});
    const role=roomPlayer(room,userId);if(!role)return res.status(403).json({error:'You are not a player in this room'});
    const score=Math.max(0,Math.floor(Number(req.body?.score)||0)),timeMs=req.body?.timeMs==null?null:Math.max(0,Math.floor(Number(req.body.timeMs)||0));
    const players=roomPlayers(room),me=players.find(p=>Number(p.userId)===Number(userId));
    if(!me)return res.status(403).json({error:'You are not a player in this room'});
    if(me.completed)return res.status(409).json({error:'Your match attempt is already submitted'});
    me.score=score;me.timeMs=timeMs;me.completed=true;me.progress=100;me.answered=Math.max(me.answered||0,Number(req.body?.answered)||0);me.correct=Math.max(me.correct||0,Number(req.body?.correct)||0);
    const multi=MULTI_GAMES.has(room.gameType),allDone=(multi?players.length>=2:players.length===2)&&players.every(p=>p.completed);
    const ranked=[...players].filter(p=>p.completed).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)||((Number(a.timeMs)||Number.MAX_SAFE_INTEGER)-(Number(b.timeMs)||Number.MAX_SAFE_INTEGER)));
    if(allDone){
      const top=Number(ranked[0]?.score||0),winners=ranked.filter(p=>Number(p.score||0)===top),draw=winners.length>1;
      const rewardByUser={};
      ranked.forEach((p,i)=>{let reward=room.gameType==='trivia'||room.gameType==='crossword'?(i===0?(draw?50:100):i===1?75:i===2?50:25):(i===0?(draw?25:100):0);rewardByUser[p.userId]=reward;});
      const rewardedUserIds=ranked.filter(p=>rewardByUser[p.userId]>0).map(p=>p.userId);
      const results=ranked.map((p,i)=>({...p,rank:i+1,rewardCoins:rewardByUser[p.userId]||0}));
      const nextState={...(room.state||{}),players,rewardCoins:draw?50:(rewardByUser[ranked[0]?.userId]||0),rewardedUserIds,rewardByUser,rewardedAt:new Date().toISOString(),results};
      await room.update({winnerId:draw?null:ranked[0]?.userId||null,status:'finished',state:nextState,[role==='host'?'hostScore':'guestScore']:score});
      if(GameProgress)for(const p of ranked){const reward=rewardByUser[p.userId]||0;const player=await getOrCreate(p.userId);await player.update({coins:(Number(player.coins)||0)+reward,totalGames:(Number(player.totalGames)||0)+1,lastSessionAt:new Date()});}
      emitRoom(req,room,'game:room:finished');return res.json({ok:true,room:roomPayload(room),result:draw?'draw':'completed',ranking:results});
    }
    await room.update({state:{...(room.state||{}),players},status:'playing',[role==='host'?'hostScore':'guestScore']:score});
    emitRoom(req,room);return res.json({ok:true,room:roomPayload(room),result:'waiting_for_players',ranking:ranked.map((p,i)=>({...p,rank:i+1}))});
  }catch(err){console.error('[games] POST /rooms/:code/result:',err.message);return res.status(500).json({error:'Server error'});}
});

// POST /api/games/rooms/:code/close — only host can close the invitation.
router.post('/rooms/:code/close',async(req,res)=>{
  try{
    if(!GameRoom)return res.status(503).json({error:'Game rooms unavailable'});
    const userId=req.user?.id||req.userId;
    const room=await GameRoom.findOne({where:{code:String(req.params.code).toUpperCase()}});
    if(!room)return res.status(404).json({error:'Room not found'});
    if(room.hostId!==userId)return res.status(403).json({error:'Only the host can close this room'});
    await room.update({status:'closed'});
    emitRoom(req,room);
    return res.json({ok:true});
  }catch(err){
    console.error('[games] POST /rooms/:code/close:',err.message);
    return res.status(500).json({error:'Server error'});
  }
});

module.exports = router;