const express = require('express');
const { Op } = require('sequelize');
const db = require('../models');

const router = express.Router();
const Users = db.models.Users;
const Friend = db.models.Friend;
const sequelize = db.sequelize || db;

const me = (req) => {
  const id = Number(req.user?.userId ?? req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const publicUser = (u, extra = {}) => ({
  id: u.id,
  username: u.username,
  displayName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username,
  firstName: u.firstName || null,
  lastName: u.lastName || null,
  avatar: u.avatar || null,
  bio: u.bio || null,
  isVerified: Boolean(u.isVerified),
  status: u.status || 'offline',
  lastSeen: u.lastSeen || null,
  ...extra
});

const attrs = ['id','username','firstName','lastName','avatar','bio','isVerified','status','lastSeen'];

async function relationships(userId, users) {
  const ids = users.map(u => Number(u.id)).filter(Number.isInteger);
  if (!ids.length) return new Map();
  const rows = await Friend.findAll({
    where: { [Op.and]: [
      { status: { [Op.in]: ['pending', 'accepted'] } },
      { [Op.or]: [
        { requesterId: userId, addresseeId: { [Op.in]: ids } },
        { addresseeId: userId, requesterId: { [Op.in]: ids } }
      ] }
    ] },
    attributes: ['id','requesterId','addresseeId','status']
  });
  const map = new Map();
  for (const r of rows) {
    const other = Number(r.requesterId) === userId ? Number(r.addresseeId) : Number(r.requesterId);
    map.set(other, r.status === 'accepted' ? { status:'accepted', direction:null, requestId:r.id } : {
      status:'pending', direction:Number(r.requesterId) === userId ? 'outgoing' : 'incoming', requestId:r.id
    });
  }
  return map;
}

async function mutualCounts(userId, users) {
  const ids = users.map(u => Number(u.id)).filter(Number.isInteger);
  const out = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return out;
  const mineRows = await Friend.findAll({
    where: { status:'accepted', [Op.or]: [{ requesterId:userId }, { addresseeId:userId }] },
    attributes:['requesterId','addresseeId']
  });
  const mine = new Set();
  for (const r of mineRows) mine.add(Number(r.requesterId) === userId ? Number(r.addresseeId) : Number(r.requesterId));
  if (!mine.size) return out;
  const second = await Friend.findAll({
    where: { status:'accepted', [Op.or]: [
      { requesterId:{ [Op.in]: [...mine] } },
      { addresseeId:{ [Op.in]: [...mine] } }
    ] },
    attributes:['requesterId','addresseeId']
  });
  for (const r of second) {
    const a = Number(r.requesterId), b = Number(r.addresseeId);
    if (ids.includes(a) && mine.has(b)) out.set(a, (out.get(a)||0)+1);
    if (ids.includes(b) && mine.has(a)) out.set(b, (out.get(b)||0)+1);
  }
  return out;
}

async function decorate(userId, users) {
  const [rel, mutual] = await Promise.all([relationships(userId, users), mutualCounts(userId, users)]);
  return users.map(u => publicUser(u, {
    relationship: rel.get(Number(u.id)) || { status:'none', direction:null, requestId:null },
    mutualCount: mutual.get(Number(u.id)) || 0
  }));
}

router.get('/search', async (req,res) => {
  try {
    const userId=me(req); if(!userId) return res.status(401).json({success:false,message:'Authentication required'});
    const q=String(req.query.q||'').trim();
    if(q.length<2) return res.json({success:true,data:{users:[],total:0}});
    const limit=Math.min(Math.max(Number(req.query.limit)||25,1),50);
    const users=await Users.findAll({where:{id:{[Op.ne]:userId},isActive:true,[Op.or]:[
      {username:{[Op.iLike]:`%${q}%`}},{firstName:{[Op.iLike]:`%${q}%`}},{lastName:{[Op.iLike]:`%${q}%`}}
    ]},attributes:attrs,order:[['username','ASC']],limit});
    return res.json({success:true,data:{users:await decorate(userId,users),total:users.length}});
  } catch(error){console.error('[FriendDiscovery] search',error);return res.status(500).json({success:false,message:'Unable to search users'});}
});

router.get('/browse', async (req,res) => {
  try {
    const userId=me(req); if(!userId) return res.status(401).json({success:false,message:'Authentication required'});
    const limit=Math.min(Math.max(Number(req.query.limit)||30,1),60);
    const offset=Math.max(Number(req.query.offset)||0,0);
    const users=await Users.findAll({where:{id:{[Op.ne]:userId},isActive:true},attributes:attrs,order:[['username','ASC']],limit,offset});
    const count=await Users.count({where:{id:{[Op.ne]:userId},isActive:true}});
    return res.json({success:true,data:{users:await decorate(userId,users),total:count,offset,limit,hasMore:offset+users.length<count}});
  } catch(error){console.error('[FriendDiscovery] browse',error);return res.status(500).json({success:false,message:'Unable to browse users'});}
});

router.get('/suggestions', async (req,res) => {
  try {
    const userId=me(req); if(!userId) return res.status(401).json({success:false,message:'Authentication required'});
    const limit=Math.min(Math.max(Number(req.query.limit)||20,1),40);
    const mine=await Friend.findAll({where:{status:'accepted',[Op.or]:[{requesterId:userId},{addresseeId:userId}]},attributes:['requesterId','addresseeId']});
    const directIds=new Set(); for(const f of mine) directIds.add(Number(f.requesterId)===userId?Number(f.addresseeId):Number(f.requesterId));
    if(!directIds.size){
      const users=await Users.findAll({where:{id:{[Op.ne]:userId},isActive:true},attributes:attrs,order:[['createdAt','DESC']],limit});
      return res.json({success:true,data:{users:await decorate(userId,users),reason:'discover'}});
    }
    const second=await Friend.findAll({where:{status:'accepted',[Op.or]:[
      {requesterId:{[Op.in]:[...directIds]}},{addresseeId:{[Op.in]:[...directIds]}}
    ]},attributes:['requesterId','addresseeId']});
    const scores=new Map();
    for(const f of second){const a=Number(f.requesterId),b=Number(f.addresseeId);
      if(directIds.has(a)&&b!==userId&&!directIds.has(b)) scores.set(b,(scores.get(b)||0)+1);
      if(directIds.has(b)&&a!==userId&&!directIds.has(a)) scores.set(a,(scores.get(a)||0)+1);
    }
    const ids=[...scores.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,limit).map(x=>x[0]);
    let users=ids.length?await Users.findAll({where:{id:{[Op.in]:ids},isActive:true},attributes:attrs}):[];
    const order=new Map(ids.map((id,i)=>[id,i])); users.sort((a,b)=>(order.get(Number(a.id))??999)-(order.get(Number(b.id))??999));
    if(!users.length) users=await Users.findAll({where:{id:{[Op.ne]:userId},isActive:true},attributes:attrs,order:[['createdAt','DESC']],limit});
    const decorated=await decorate(userId,users);
    for(const u of decorated) u.mutualCount=scores.get(Number(u.id))||u.mutualCount||0;
    return res.json({success:true,data:{users:decorated,reason:ids.length?'mutuals':'discover'}});
  } catch(error){console.error('[FriendDiscovery] suggestions',error);return res.status(500).json({success:false,message:'Unable to load suggestions'});}
});

router.put('/location', async (req,res) => {
  try {
    const userId=me(req); if(!userId) return res.status(401).json({success:false,message:'Authentication required'});
    const lat=Number(req.body?.latitude),lng=Number(req.body?.longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180)return res.status(400).json({success:false,message:'Invalid coordinates'});
    await sequelize.query('UPDATE "Users" SET "latitude" = :lat, "longitude" = :lng, "locationUpdatedAt" = CURRENT_TIMESTAMP WHERE "id" = :id',{replacements:{lat,lng,id:userId}});
    return res.json({success:true,data:{latitude:lat,longitude:lng,updatedAt:new Date().toISOString()}});
  } catch(error){console.error('[FriendDiscovery] location',error);return res.status(500).json({success:false,message:'Nearby location is not available yet'});}
});

router.get('/nearby', async (req,res) => {
  try {
    const userId=me(req); if(!userId) return res.status(401).json({success:false,message:'Authentication required'});
    const lat=Number(req.query.lat),lng=Number(req.query.lng); const radius=Math.min(Math.max(Number(req.query.radius)||25,1),100);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({success:false,message:'Location permission is required for nearby people'});
    const users=await Users.findAll({where:{id:{[Op.ne]:userId},isActive:true,latitude:{[Op.not]:null},longitude:{[Op.not]:null}},attributes:attrs.concat(['latitude','longitude']),limit:200});
    const earth=6371, p1=lat*Math.PI/180;
    const nearby=users.map(u=>{const la=Number(u.latitude)*Math.PI/180,lo=Number(u.longitude)*Math.PI/180,p2=lng*Math.PI/180,dLat=la-p1,dLon=lo-p2,h=Math.sin(dLat/2)**2+Math.cos(p1)*Math.cos(la)*Math.sin(dLon/2)**2;return{user:u,km:earth*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))};}).filter(x=>x.km<=radius).sort((a,b)=>a.km-b.km).slice(0,60);
    const decorated=await decorate(userId,nearby.map(x=>x.user)); const byId=new Map(decorated.map(x=>[Number(x.id),x]));
    return res.json({success:true,data:{users:nearby.map(x=>({...byId.get(Number(x.user.id)),distanceKm:Math.round(x.km*10)/10})),radiusKm:radius}});
  } catch(error){console.error('[FriendDiscovery] nearby',error);return res.status(500).json({success:false,message:'Unable to load nearby users'});}
});

module.exports=router;
