'use strict';

const express = require('express');
const asyncHandler = require('express-async-handler');
const { Op, fn, col } = require('sequelize');
const { authenticateToken, optionalAuthenticateToken } = require('../middleware/auth');
const { ensureStatusSchema } = require('../services/statusSchema');
const { apiRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const db = () => require('../models');
// FIX-STATUS-MODELS: models/index.js only exposes getters for some models (User, Status,
// StatusView, ...) — there is NO `Users` or `StatusReport` property, so db().Users was
// undefined and every ownerPayload() threw "Cannot read properties of undefined (reading
// 'findByPk')" (the /api/status/my and POST /api/status 500s). Resolve models from the
// registry by name instead, tolerating singular/plural naming.
const M = (...names) => {
  const d = db();
  for (const n of names) {
    const m = (d.models && d.models[n]) || d[n];
    if (m) return m;
  }
  return null;
};
const Status = () => M('Status');
const Users = () => M('Users', 'User');
const Friend = () => M('Friend', 'Friends');
const Follow = () => M('Follow');
const UserBlock = () => M('UserBlock');

const VALID_TYPES = new Set(['text', 'image', 'video', 'poll', 'link']);
const VALID_PUBLICATION_TARGETS = new Set(['status','vibe','both']);
const VIBE_EXPIRY_HOURS = new Set([1,6,12,24,48,72,168]);
const VALID_PRIVACY = new Set(['all_contacts', 'contacts_except', 'only_share_with', 'close_friends', 'public', 'private']);
const MAX_TEXT = 4000;
const MAX_TOPICS = 10;
const requireUser=(req,res,next)=>{const id=Number(req.user?.userId||req.user?.id);if(!Number.isFinite(id)||id<=0)return res.status(401).json({success:false,message:'Authorization required'});next();};

const uid = req => Number(req.user?.userId || req.user?.id);
const cleanList = (value, max = 100) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, max) : [];
const safeUrl = value => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value) ? value.slice(0, 2000) : null;

async function ownerPayload(status) {
  const UserModel = Users();
  const user = UserModel ? await UserModel.findByPk(status.userId, { attributes: ['id', 'username', 'displayName', 'avatar'] }).catch(() => null) : null;
  return {
    ...status.toJSON(),
    owner: user ? user.toJSON() : { id: status.userId, username: 'User', displayName: 'User', avatar: null },
  };
}

async function canView(status, viewerId) {
  if (!status || !status.isActive || new Date(status.expiresAt).getTime() <= Date.now()) return false;
  if ((status.publicationTarget === 'vibe' || status.publicationTarget === 'both') && status.vibeExpiresAt && new Date(status.vibeExpiresAt).getTime() <= Date.now()) return false;
  if (status.userId === viewerId) return true;
  // FIX (BLOCKING DID NOTHING): blockUser() used to be a no-op stub — nothing ever actually
  // stopped a blocked user from seeing your posts. Now that blocks persist (UserBlock model),
  // enforce it here so it's a single check every status/vibe view already goes through, in
  // both directions (you blocked them, or they blocked you).
  const BlockModel = UserBlock();
  if (BlockModel && await BlockModel.isBlockedEitherWay(viewerId, status.userId).catch(() => false)) return false;
  if (status.isPublic || status.privacy === 'public') return true;
  if (status.privacy === 'private') return false;
  const list = Array.isArray(status.privacyList) ? status.privacyList.map(Number) : [];
  if (status.privacy === 'only_share_with') return list.includes(viewerId);
  if (status.privacy === 'contacts_except') return !list.includes(viewerId);
  if (status.privacy === 'close_friends') {
    const FriendModel = Friend();
    if (!FriendModel) return false;
    const rows = await FriendModel.getUserFriends(viewerId, 'accepted').catch(() => []);
    const ids = rows.map(f => Number(f.friend?.requesterId) === viewerId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId));
    return ids.includes(Number(status.userId));
  }
  const FriendModel = Friend();
  if (!FriendModel) return false;
  const rows = await FriendModel.getUserFriends(viewerId, 'accepted').catch(() => []);
  const ids = rows.map(f => Number(f.friend?.requesterId) === viewerId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId));
  return ids.includes(Number(status.userId));
}

function normalizeBody(body, userId) {
  // Canonical media contract: accept the flat fields used by ProfessionalStatus
  // and the nested Media-shaped object used by other clients, then persist one
  // stable set of mediaUrl/mediaPublicId/mediaMime fields. This prevents a
  // successful upload from becoming a status with an empty media URL.
  const media = body.media && typeof body.media === 'object' ? body.media : {};
  const suppliedMime = body.mediaMime || media.mimeType || media.mime || '';
  const inferredType = String(suppliedMime).startsWith('video/') ? 'video'
    : String(suppliedMime).startsWith('image/') ? 'image' : 'text';
  const type = VALID_TYPES.has(body.type) ? body.type : inferredType;
  const privacy = VALID_PRIVACY.has(body.privacy) ? body.privacy : 'all_contacts';
  const content = typeof body.content === 'string' ? body.content.trim().slice(0, MAX_TEXT) : null;
  const topics = cleanList(body.topics, MAX_TOPICS);
  const durationSeconds = Math.min(Math.max(Number(body.durationSeconds) || 7, 3), 20);
  const publicationTarget = type === 'video' && VALID_PUBLICATION_TARGETS.has(body.publicationTarget) ? body.publicationTarget : 'status';
  const vibeDurationHours = VIBE_EXPIRY_HOURS.has(Number(body.vibeDurationHours)) ? Number(body.vibeDurationHours) : 24;
  const vibeExpiresAt = publicationTarget === 'vibe' || publicationTarget === 'both' ? new Date(Date.now()+vibeDurationHours*60*60*1000) : null;
  const pollOptions=Array.isArray(body.pollOptions)?body.pollOptions.map(v=>String(v).trim()).filter(Boolean).slice(0,8):[];
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    userId,
    content,
    type,
    mediaUrl: safeUrl(body.mediaUrl || media.url || media.secure_url),
    mediaPublicId: typeof (body.mediaPublicId || media.publicId || media.public_id) === 'string' ? String(body.mediaPublicId || media.publicId || media.public_id).slice(0, 500) : null,
    mediaMime: typeof suppliedMime === 'string' ? suppliedMime.slice(0, 120) : null,
    thumbnailUrl: safeUrl(body.thumbnailUrl),
    caption: typeof body.caption === 'string' ? body.caption.trim().slice(0, 2000) : null,
    background: typeof body.background === 'string' ? body.background.slice(0, 120) : null,
    font: typeof body.font === 'string' ? body.font.slice(0, 80) : null,
    musicUrl: safeUrl(body.musicUrl),
    linkUrl: safeUrl(body.linkUrl),
    mentions: cleanList(body.mentions, 50),
    stickers: Array.isArray(body.stickers) ? body.stickers.slice(0, 30) : [],
    topics,
    pollOptions,
    moodType: typeof body.moodType === 'string' ? body.moodType.slice(0, 60) : null,
    category: typeof body.category === 'string' ? body.category.slice(0, 60) : null,
    intent: typeof body.intent === 'string' ? body.intent.slice(0, 60) : null,
    privacy,
    privacyList: cleanList(body.privacyList, 200),
    durationSeconds,
    publicationTarget,
    vibeExpiresAt,
    allowReplies: body.allowReplies !== false,
    allowReactions: body.allowReactions !== false,
    allowSharing: body.allowSharing !== false,
    isPublic: privacy === 'public',
    isActive: true,
    expiresAt,
  };
}

// Schema repair runs once per process (see services/statusSchema.js). If it fails, log the
// real database error and carry on: the tables normally already exist, and the actual query
// will surface the true failure. A failed run is not cached, so the next request retries.
router.use(async (req, res, next) => {
  try { await ensureStatusSchema(db()); }
  catch (err) { console.error('[status] ensureStatusSchema failed:', err && (err.parent?.message || err.message), err?.parent?.code || ''); }
  next();
});

// Health is public.
router.get('/health', asyncHandler(async (req, res) => {
  const S = Status();
  return res.json({ success: !!S, feature: 'professional-status', version: '5.0.0' });
}));

// Create status.
router.post('/', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  const data = normalizeBody(req.body || {}, userId);
  if (!data.content && !data.mediaUrl && data.type !== 'poll') {
    return res.status(400).json({ success: false, message: 'Status needs text, media, or a poll.' });
  }
  if (data.type === 'video' && data.mediaMime && !data.mediaMime.startsWith('video/')) {
    return res.status(400).json({ success: false, message: 'Invalid video media type.' });
  }
  if (data.type === 'image' && data.mediaMime && !data.mediaMime.startsWith('image/')) {
    return res.status(400).json({ success: false, message: 'Invalid image media type.' });
  }
  const status = await Status().create(data);
  const result = await ownerPayload(status);
  const io = global.__socketIO;
  if (io) {
    io.to('user:' + userId).emit('status:new', { story: result });
    io.to('user_' + userId).emit('status:new', { story: result });
    const friendRows = await Friend().getUserFriends(userId, 'accepted').catch(() => []);
    const friendIds = friendRows.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
    for (const friendId of friendIds) {
      io.to('user:' + friendId).emit('status:new', { story: result });
      io.to('user_' + friendId).emit('status:new', { story: result });
    }
  }
  return res.status(201).json({ success: true, status: result });
}));

// Compatibility/default status feed. Older shells request GET /api/status directly.
router.get('/', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!Number.isFinite(userId)||userId<=0) return res.json({success:true,featureVersion:'status-5.2',data:[]});
  const friends = await Friend().getUserFriends(userId, 'accepted');
  const ids = friends.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
  const statuses = await Status().getFriendsStatuses(userId, ids);
  const visible = [];
  for (const s of statuses) if (s.publicationTarget !== 'vibe' && await canView(s, userId)) visible.push(await ownerPayload(s));
  const mine = (await Status().getUserStatuses(userId, { activeOnly: true })).filter(s => s.publicationTarget !== 'vibe');
  res.set('Cache-Control','no-store');
  return res.json({ success: true, featureVersion: 'status-5.1', data: [...(await Promise.all(mine.map(ownerPayload))), ...visible] });
}));

// Current user's active statuses.
router.get('/my', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().getUserStatuses(uid(req), { activeOnly: true });
  return res.json({ success: true, data: await Promise.all(statuses.map(async s => ({ ...(await ownerPayload(s)), viewedByMe: true }))) });
}));

// Friend statuses.
router.get('/friends', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  const friends = await Friend().getUserFriends(userId, 'accepted');
  const ids = friends.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
  const statuses = await Status().getFriendsStatuses(userId, ids);
  const visible = [];
  for (const s of statuses) if (s.publicationTarget !== 'vibe' && await canView(s, userId)) visible.push(await ownerPayload(s));
  const View = M('StatusView');
  const viewedIds = new Set();
  if (View && visible.length) {
    const rows = await View.findAll({ where: { statusId: visible.map(s => s.id), viewerId: userId }, attributes: ['statusId'] }).catch(() => []);
    rows.forEach(v => viewedIds.add(Number(v.statusId)));
  }
  const data = visible.map(s => ({ ...s, viewedByMe: viewedIds.has(Number(s.id)) }));
  return res.json({ success: true, data });
}));

// Public feed / trending.
router.get('/public', apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().findAll({ where: { isActive: true, publicationTarget: { [Op.ne]: 'vibe' }, isPublic: true, expiresAt: { [Op.gt]: new Date() } }, order: [['createdAt', 'DESC']], limit: 100 });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/trending', apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().findAll({ where: { isActive: true, isPublic: true, expiresAt: { [Op.gt]: new Date() } }, order: [['viewCount', 'DESC'], ['createdAt', 'DESC']], limit: 50 });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.json({ success: true, data: [] });
  const statuses = await Status().findAll({
    where: { isActive: true, publicationTarget: { [Op.ne]: 'vibe' }, expiresAt: { [Op.gt]: new Date() }, isPublic: true, [Op.or]: [{ content: { [Op.iLike]: '%' + q + '%' } }, { caption: { [Op.iLike]: '%' + q + '%' } }] },
    order: [['createdAt', 'DESC']], limit: 50,
  });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/mood/:moodType', apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().findAll({ where: { moodType: req.params.moodType, isActive: true, publicationTarget: { [Op.ne]: 'vibe' }, expiresAt: { [Op.gt]: new Date() }, isPublic: true }, order: [['createdAt', 'DESC']], limit: 50 });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/user/:userId', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const target = Number(req.params.userId);
  const statuses = await Status().findAll({ where: { userId: target, isActive: true, publicationTarget: { [Op.ne]: 'vibe' }, expiresAt: { [Op.gt]: new Date() } }, order: [['createdAt', 'ASC']] });
  const visible = [];
  for (const s of statuses) if (s.publicationTarget !== 'vibe' && await canView(s, uid(req))) visible.push(await ownerPayload(s));
  return res.json({ success: true, data: visible });
}));

router.get('/stats', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  return res.json({ success: true, data: await Status().getStatusStats(uid(req)) });
}));

router.get('/vibes', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req,res)=>{
  const userId=uid(req);
  const mode=['forYou','friends','public','following'].includes(String(req.query.mode))?String(req.query.mode):'forYou';
  // FIX (SEARCH ONLY SEARCHED WHAT WAS ALREADY LOADED): the client used to filter only the
  // in-memory items already fetched for the current tab (window.prompt-based, no network call),
  // so a vibe you hadn't scrolled to yet was simply unfindable. q now filters at the DB level,
  // within whichever tab's normal visibility rules already apply — searching within For You
  // still respects For You's own audience, same for Friends/Following/Public.
  const q=String(req.query.q||'').trim().slice(0,80);
  const textFilter=q?{[Op.or]:[{content:{[Op.iLike]:'%'+q+'%'}},{caption:{[Op.iLike]:'%'+q+'%'}}]}:null;
  const friends=await Friend().getUserFriends(userId,'accepted');
  const friendIds=friends.map(f=>Number(f.friend?.requesterId)===userId?Number(f.friend?.addresseeId):Number(f.friend?.requesterId)).filter(Number.isFinite);
  // FIX (FOLLOWING WAS IDENTICAL TO FRIENDS): this used to fold "following" into the same
  // friend-connection query as "friends" because no Follow table existed. There is now a
  // real, one-way Follow model (src/models/Follow.js, wired via /api/profiles/:userId/follow) —
  // "Following" is the set of creators this user chose to follow, independent of whether
  // they're also mutual friends.
  const FollowModel=Follow();
  const followingIds=FollowModel?await FollowModel.getFollowingIds(userId).catch(()=>[]):[];
  const base={type:'video',publicationTarget:{[Op.in]:['vibe','both']},isActive:true,expiresAt:{[Op.gt]:new Date()},vibeExpiresAt:{[Op.gt]:new Date()},...(textFilter?{[Op.and]:[textFilter]}:{})};
  const byId=new Map();
  // FIX (FOR-YOU HAD NO REAL RANKING): this used to just DESC-sort each of the three source
  // queries independently, then dump them into byId in whatever order the three `if` blocks
  // happened to run — friends' vibes always landed before following's, which always landed
  // before public's, regardless of actual recency or engagement. That's worse than "newest
  // first": a week-old friend's vibe could sit ahead of a public vibe posted a minute ago.
  // closeness tracks the strongest relationship each vibe reached this viewer through, so a
  // real For You score (closeness + recency decay + engagement) can be computed once every
  // source has been merged, instead of concatenating three separately-sorted blocks.
  const closeness=new Map();
  const bump=(id,w)=>{if(!closeness.has(id)||closeness.get(id)<w)closeness.set(id,w);};
  if(mode==='forYou'||mode==='friends'){
    const rows=await Status().findAll({where:{...base,userId:{[Op.in]:[...friendIds,userId]}},order:[['createdAt','DESC']],limit:200});
    for(const s of rows) if(await canView(s,userId)){byId.set(String(s.id),await ownerPayload(s));bump(String(s.id),3);}
  }
  if((mode==='forYou'||mode==='following')&&followingIds.length){
    const rows=await Status().findAll({where:{...base,userId:{[Op.in]:followingIds}},order:[['createdAt','DESC']],limit:200});
    for(const s of rows) if(await canView(s,userId)){byId.set(String(s.id),await ownerPayload(s));bump(String(s.id),2);}
  }
  if(mode==='forYou'||mode==='public'){
    const pubs=await Status().findAll({where:{...base,isPublic:true},order:[['createdAt','DESC']],limit:200});
    for(const s of pubs) if(await canView(s,userId)){byId.set(String(s.id),await ownerPayload(s));bump(String(s.id),1);}
  }
  const Reaction=M('StatusReaction'); const likedIds=new Set();
  if(Reaction&&byId.size){
    const mine=await Reaction.findAll({where:{statusId:{[Op.in]:[...byId.values()].map(v=>v.id)},userId},attributes:['statusId']}).catch(()=>[]);
    mine.forEach(r=>likedIds.add(Number(r.statusId)));
  }
  // FIX (NO FOLLOWER COUNT ANYWHERE): the Follow model now exists, but nothing surfaced a
  // follower count anywhere in the UI. Batch one grouped count for every distinct creator in
  // this response instead of a per-item query.
  const followerCounts=new Map();
  if(FollowModel&&byId.size){
    const ownerIds=[...new Set([...byId.values()].map(v=>Number(v.owner?.id??v.userId)).filter(Number.isFinite))];
    if(ownerIds.length){
      const rows=await FollowModel.findAll({where:{followingId:{[Op.in]:ownerIds}},attributes:['followingId',[fn('COUNT',col('id')),'cnt']],group:['followingId']}).catch(()=>[]);
      rows.forEach(r=>followerCounts.set(Number(r.get('followingId')),Number(r.get('cnt'))||0));
    }
  }
  const followingSet=new Set(followingIds.map(String));
  let data=[...byId.values()].map(v=>{
    const ownerId=Number(v.owner?.id??v.userId);
    return {...v,likedByMe:likedIds.has(Number(v.id)),isFollowedByMe:followingSet.has(String(ownerId)),owner:v.owner?{...v.owner,followerCount:followerCounts.get(ownerId)||0}:v.owner};
  });
  if(mode==='forYou'){
    // Real ranking, not just newest-first: relationship closeness (friend > following >
    // public) dominates, recency decays over 3 days so today's public vibe can still beat a
    // week-old friend post, and engagement (reactions + views, log-scaled so one viral vibe
    // can't bury everything else) gives a final nudge. Weights are conservative on purpose —
    // this is a first real ranking pass, not a tuned model.
    const now=Date.now(),HALF_LIFE_MS=3*24*60*60*1000;
    const score=v=>{
      const c=closeness.get(String(v.id))||1;
      const ageMs=Math.max(0,now-new Date(v.createdAt).getTime());
      const recency=Math.pow(0.5,ageMs/HALF_LIFE_MS);
      const engagement=Math.log10(1+Number(v.reactionCount||0)*3+Number(v.viewCount||0));
      return c*(1+recency)+engagement;
    };
    data=data.map(v=>({v,s:score(v)})).sort((a,b)=>b.s-a.s).map(x=>x.v);
  }
  res.set('Cache-Control','no-store');
  return res.json({success:true,mode,data});
}));

// Vibes "love" button: one tap toggles the caller's heart and answers with the real total.
// (The client used to POST here but only /:statusId/like existed, so the count never changed.)
router.post('/vibes/:statusId/love', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req,res)=>{
  const userId=uid(req);
  const status=await Status().findByPk(Number(req.params.statusId));
  if(!status||!(await canView(status,userId))||status.allowReactions===false) return res.status(404).json({success:false,message:'This vibe is unavailable.'});
  const Reaction=M('StatusReaction');
  if(!Reaction) return res.status(503).json({success:false,message:'Reactions are unavailable.'});
  const existing=await Reaction.findOne({where:{statusId:status.id,userId}});
  let liked;
  if(existing){await existing.destroy();liked=false;}
  else{await Reaction.findOrCreate({where:{statusId:status.id,userId},defaults:{emoji:'❤️'}});liked=true;}
  const count=await Reaction.count({where:{statusId:status.id}});
  await status.update({reactionCount:count});
  const io=global.__socketIO;
  if(io&&liked&&Number(status.userId)!==userId) io.to('user:'+status.userId).emit('status:reaction',{storyId:status.id,userId,emoji:'❤️',count});
  return res.json({success:true,liked,count});
}));

router.get('/:statusId', apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
  const viewer = uid(req) || 0;
  if (!(await canView(status, viewer))) return res.status(403).json({ success: false, message: 'This status is private.' });
  return res.json({ success: true, status: await ownerPayload(status) });
}));



// View endpoint is intentionally idempotent per viewer.
async function recordView(req, res) {
  const viewerId = uid(req) || null;
  const status = await Status().findByPk(Number(req.params.statusId || req.body?.statusId));
  if (!status || !(await canView(status, viewerId))) return res.status(404).json({ success: false, message: 'Status not found' });
  // Opening your own status is allowed, but the owner is never a viewer.
  if (viewerId && Number(status.userId) === Number(viewerId)) return res.json({ success: true, created: false, viewCount: Number(status.viewCount || 0), data: { created: false, viewCount: Number(status.viewCount || 0) } });
  const View = M('StatusView');
  let created = false;
  if (View) {
    const [, wasCreated] = await View.findOrCreate({ where: { statusId: status.id, viewerId: viewerId || 0 }, defaults: { viewedAt: new Date() } });
    created = wasCreated;
  }
  if (created) { await status.increment('viewCount'); await status.reload(); }
  const io = global.__socketIO;
  if (created && io) io.to('user:' + status.userId).emit('status:viewed', { storyId: status.id, viewCount: Number(status.viewCount || 0), viewerId });
  return res.json({ success: true, created, viewCount: Number(status.viewCount || 0), data: { created, viewCount: Number(status.viewCount || 0) } });
}
router.post('/view', authenticateToken, requireUser, recordView);
router.post('/:statusId/view', authenticateToken, requireUser, recordView);

router.get('/:statusId/viewers', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
  // Everyone can see the view COUNT (it is part of the status payload); only the creator sees WHO viewed.
  if (status.userId !== uid(req)) return res.status(403).json({ success: false, message: 'Only the creator can see who viewed this status.', viewCount: Number(status.viewCount || 0) });
  const View = M('StatusView');
  const views = View ? await View.findAll({ where: { statusId: status.id }, order: [['viewedAt', 'DESC']], limit: 500 }) : [];
  const UserModel = Users();
  const users = await Promise.all(views.map(v => UserModel ? UserModel.findByPk(v.viewerId, { attributes: ['id','username','displayName','avatar'] }).catch(() => null) : null));
  const rows = views.map((v,i) => ({ ...v.toJSON(), viewer: users[i] ? users[i].toJSON() : null }));
  return res.json({ success: true, data: rows, viewers: rows, viewCount: Number(status.viewCount || 0) });
}));

router.get('/:statusId/likes', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  // SECURITY HARDENING: reactions on a private/contact-restricted status must
  // not become a public side-channel. Anonymous viewers may still inspect
  // reactions on genuinely public statuses.
  if (!status || !(await canView(status, uid(req) || 0))) {
    return res.status(404).json({ success: false, message: 'Status not found' });
  }
  const Like = M('StatusLike');
  const likes = Like ? await Like.findAll({ where: { statusId: status.id }, order: [['createdAt', 'DESC']], limit: 200 }) : [];
  return res.json({ success: true, data: likes });
}));

router.post('/:statusId/like', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || !(await canView(status, uid(req))) || !status.allowReactions) return res.status(404).json({ success: false, message: 'Status unavailable' });
  const Reaction = M('StatusReaction');
  const emoji = String(req.body?.emoji || '❤️').slice(0, 16);
  const [reaction] = await Reaction.findOrCreate({ where: { statusId: status.id, userId: uid(req) }, defaults: { emoji } });
  if (!reaction.changed()) {
    await Reaction.update({ emoji }, { where: { id: reaction.id } });
  }
  const count = await Reaction.count({ where: { statusId: status.id } });
  await status.update({ reactionCount: count });
  const io = global.__socketIO;
  if (io) io.to('user:' + status.userId).emit('status:reaction', { storyId: status.id, userId: uid(req), emoji, count });
  return res.json({ success: true, liked: true, reaction: reaction.toJSON(), count });
}));

router.delete('/:statusId/like', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const Reaction = M('StatusReaction');
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
  await Reaction.destroy({ where: { statusId: status.id, userId: uid(req) } });
  const count = await Reaction.count({ where: { statusId: status.id } });
  await status.update({ reactionCount: count });
  return res.json({ success: true, count });
}));

router.post('/:statusId/comment', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || !(await canView(status, uid(req))) || !status.allowReplies) return res.status(404).json({ success: false, message: 'Replies are disabled.' });
  const Reply = M('StatusReply');
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ success: false, message: 'Reply cannot be empty.' });
  const reply = await Reply.create({ statusId: status.id, userId: uid(req), text });
  // Recount from the table instead of increment(): the client shows this number, so it must be the real total.
  const count = await Reply.count({ where: { statusId: status.id } });
  await status.update({ replyCount: count });
  const io = global.__socketIO;
  if (io) io.to('user:' + status.userId).emit('status:reply', { storyId: status.id, userId: uid(req), text, replyId: reply.id, count });
  const UserModel = Users();
  const author = UserModel ? await UserModel.findByPk(uid(req), { attributes: ['id', 'username', 'displayName', 'avatar'] }).catch(() => null) : null;
  return res.status(201).json({ success: true, count, reply: { ...reply.toJSON(), user: author ? author.toJSON() : null } });
}));

router.get('/:statusId/comments', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  // SECURITY HARDENING: comments are protected by the same audience check as
  // the status itself. This prevents unauthenticated enumeration of replies
  // attached to private/contact-only stories.
  if (!status || !(await canView(status, uid(req) || 0))) {
    return res.status(404).json({ success: false, message: 'Status not found' });
  }
  const Reply = M('StatusReply');
  const replies = Reply ? await Reply.findAll({ where: { statusId: status.id }, order: [['createdAt', 'ASC']], limit: 200 }) : [];
  // Show who wrote each comment (the client used to display "User <id>") and return the real total.
  const UserModel = Users();
  const ids = [...new Set(replies.map(r => Number(r.userId)).filter(Number.isFinite))];
  const people = UserModel && ids.length ? await UserModel.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'username', 'displayName', 'avatar'] }).catch(() => []) : [];
  const byId = new Map(people.map(u => [Number(u.id), u.toJSON()]));
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, count: replies.length, data: replies.map(r => ({ ...r.toJSON(), user: byId.get(Number(r.userId)) || null })) });
}));

router.delete('/:statusId/comment/:commentId', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const Reply = M('StatusReply');
  const reply = await Reply.findByPk(Number(req.params.commentId));
  if (!reply || reply.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Reply not found' });
  await reply.destroy();
  return res.json({ success: true });
}));

router.post('/:statusId/share', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || !(await canView(status, uid(req))) || !status.allowSharing) return res.status(404).json({ success: false, message: 'Sharing is disabled.' });
  await status.increment('shareCount');
  return res.json({ success: true });
}));

router.put('/:statusId', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || status.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Status not found' });
  const allowed = ['caption', 'content', 'background', 'font', 'musicUrl', 'linkUrl', 'mentions', 'stickers', 'topics', 'moodType', 'category', 'intent', 'privacy', 'privacyList', 'allowReplies', 'allowReactions', 'allowSharing', 'highlight'];
  const patch = {};
  for (const key of allowed) if (req.body?.[key] !== undefined) patch[key] = req.body[key];
  if (patch.privacy && !VALID_PRIVACY.has(patch.privacy)) delete patch.privacy;
  await status.update(patch);
  return res.json({ success: true, status: await ownerPayload(status) });
}));

router.delete('/:statusId', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || status.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Status not found' });
  await status.update({ isActive: false, expiresAt: new Date() });
  const io = global.__socketIO;
  if (io) {
    const payload = { storyId: status.id, userId: uid(req) };
    io.to('user:' + uid(req)).emit('status:deleted', payload);
    io.to('user_' + uid(req)).emit('status:deleted', payload);
  }
  return res.json({ success: true });
}));


router.post('/:statusId/report', authenticateToken, requireUser, apiRateLimiter, asyncHandler(async (req, res) => {
  const Report = M('StatusReport');
  if (!Report) return res.status(503).json({ success: false, message: 'Reporting unavailable' });
  const reason = String(req.body?.reason || 'other').slice(0, 80);
  const details = String(req.body?.details || '').slice(0, 1000);
  await Report.create({ statusId: Number(req.params.statusId), reporterId: uid(req), reason, details });
  return res.status(201).json({ success: true });
}));

// Log the real cause server-side and give the client a JSON body (it used to get an empty
// 500). Only the Postgres error code is exposed, never the SQL/message.
router.use((err, req, res, next) => {
  console.error('[status] ' + req.method + ' ' + req.originalUrl + ' failed:', err && (err.parent?.message || err.message), err?.parent?.code || '');
  if (res.headersSent) return next(err);
  return res.status(Number(err?.status) || 500).json({ success: false, message: 'Status service error (' + (err?.parent?.code || err?.name || 'ERROR') + ')', code: err?.parent?.code || err?.name || 'ERROR' });
});

module.exports = router;