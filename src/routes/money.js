'use strict';
const express=require('express');
const jwt=require('jsonwebtoken');
const { comparePassword }=require('../utils/passwordUtils');
const { authenticator } = require('otplib');
const router=express.Router();
const db=()=>{const m=require('../models');
 // The models index exports the user model as `User` (getter), never `Users`. money.js read `d.Users`,
 // which was always undefined, so names fell back to "User <id>" and member search/add found nobody.
 return new Proxy(m,{get:(t,k)=>k==='Users'?(t.User||t.Users||(t.sequelize&&t.sequelize.models&&(t.sequelize.models.Users||t.sequelize.models.User))||null):t[k]});};
const uid=req=>Number(req.user?.id||req.user?.userId||req.user?.sub||req.userId);
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('[money]',e.message);if(!res.headersSent)res.status(e.status||500).json({success:false,message:e.message||'Server error'});});
function ok(res,data,status=200){return res.status(status).json({success:true,...data});}
const moneyJwtSecret=()=>process.env.JWT_ACCESS_SECRET||process.env.JWT_SECRET||'';
function verifyMoneyStepUp(req,userId){const token=String(req.get('X-Money-Step-Up')||'').trim();const secret=moneyJwtSecret();if(!token||!secret)return false;try{const p=jwt.verify(token,secret);return p&&p.type==='money_step_up'&&Number(p.userId)===Number(userId);}catch(_){return false;}}
function requireMoneyStepUp(req,res,userId){if(!verifyMoneyStepUp(req,userId)){res.status(401).json({success:false,message:'Fresh account authentication is required for this money action.',errorCode:'MONEY_STEP_UP_REQUIRED'});return false;}return true;}

function normalizePhone(phone){let d=String(phone||'').replace(/\D/g,'');if(/^0[17]\d{8}$/.test(d))d='254'+d.slice(1);else if(/^[17]\d{8}$/.test(d))d='254'+d;if(!/^254[17]\d{8}$/.test(d))throw Object.assign(new Error('Enter a valid Kenyan M-Pesa number (07XX XXX XXX)'),{status:400});return d;}
async function mpesaStk({phone,amount,reference,description,callbackPath}){
 const consumerKey=process.env.MPESA_CONSUMER_KEY||'',consumerSecret=process.env.MPESA_CONSUMER_SECRET||'',shortcode=process.env.MPESA_SHORTCODE||process.env.MPESA_GAME_SHORTCODE||(process.env.MPESA_ENV==='production'?'':'174379'),passkey=process.env.MPESA_PASSKEY||process.env.MPESA_GAME_PASSKEY||(process.env.MPESA_ENV==='production'?'':'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919');
 if(!consumerKey||!consumerSecret||!shortcode||!passkey) throw Object.assign(new Error('M-Pesa STK is not configured on the server'),{status:503,code:'MPESA_NOT_CONFIGURED'});
 const base=process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
 const p=normalizePhone(phone); const tokenRes=await fetch(base+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+Buffer.from(consumerKey+':'+consumerSecret).toString('base64')}}); const tokenJson=await tokenRes.json(); if(!tokenRes.ok||!tokenJson.access_token)throw Object.assign(new Error('Unable to authenticate with M-Pesa'),{status:502});
 const timestamp=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14); const password=Buffer.from(shortcode+passkey+timestamp).toString('base64');
 const backend=process.env.BACKEND_URL||process.env.RENDER_EXTERNAL_URL||''; if(!backend)throw Object.assign(new Error('BACKEND_URL is required for M-Pesa callbacks'),{status:500});
 const callback=backend.replace(/\/$/,'')+callbackPath;
 const res=await fetch(base+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{Authorization:'Bearer '+tokenJson.access_token,'Content-Type':'application/json'},body:JSON.stringify({BusinessShortCode:shortcode,Password:password,Timestamp:timestamp,TransactionType:'CustomerPayBillOnline',Amount:Math.ceil(amount),PartyA:p,PartyB:shortcode,PhoneNumber:p,CallBackURL:callback,AccountReference:String(reference).slice(0,12),TransactionDesc:String(description||'NECPRA Money').slice(0,20)})});
 const data=await res.json(); if(!res.ok||data.ResponseCode&&String(data.ResponseCode)!=='0')throw Object.assign(new Error(data.errorMessage||data.ResponseDescription||'M-Pesa STK request failed'),{status:502,provider:data}); return data;
}
async function handleMoneyCallback(body){
 const d=db(),checkoutId=body?.CheckoutRequestID;if(!checkoutId)return;
 const items=body?.CallbackMetadata?.Item||[];const receipt=items.find(i=>i.Name==='MpesaReceiptNumber')?.Value;const amount=Number(items.find(i=>i.Name==='Amount')?.Value||0);
 const C=d.MoneyContribution&&await d.MoneyContribution.findOne({where:{paymentRef:checkoutId}});
 if(C){if(Number(C.amount)!==amount)return;if(body.ResultCode===0||String(body.ResultCode)==='0'){if(C.status!=='paid'){const [moved]=await d.MoneyContribution.update({status:'paid',paymentRef:receipt||checkoutId,metadata:{...(C.metadata||{}),checkoutRequestId:checkoutId,receipt}},{where:{id:C.id,status:{[d.Op.ne]:'paid'}}});if(moved)await d.MoneyCircle.increment('collectedAmount',{by:amount,where:{id:C.circleId}});}}else if(C.status==='pending')await C.update({status:'failed',metadata:{...(C.metadata||{}),failureCode:body.ResultCode,failureDescription:body.ResultDesc}});return;}
 const R=d.MoneyRequest&&await d.MoneyRequest.findOne({where:{paymentRef:checkoutId}});if(R){if(Number(R.amount)!==amount)return;if(body.ResultCode===0||String(body.ResultCode)==='0'){if(R.status!=='paid')await R.update({status:'paid',paymentRef:receipt||checkoutId,metadata:{...(R.metadata||{}),checkoutRequestId:checkoutId,receipt}});}else if(R.status==='requested')await R.update({status:'expired',metadata:{...(R.metadata||{}),failureCode:body.ResultCode,failureDescription:body.ResultDesc}});}
}

router.post('/security/step-up',wrap(async(req,res)=>{const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});const password=String(req.body?.password||'');const otp=String(req.body?.otp||'').replace(/\D/g,'');if(!password)return res.status(400).json({success:false,message:'Account password is required'});const User=d.Users||d.User;if(!User)return res.status(500).json({success:false,message:'User service unavailable'});const user=await User.findByPk(userId);if(!user)return res.status(401).json({success:false,message:'Account not found'});if(user.hasLocalPassword===false)return res.status(400).json({success:false,message:'This account has no local password. Set a password in account security before using Money.',errorCode:'MONEY_PASSWORD_NOT_SET'});const valid=await comparePassword(password,user.password);if(!valid)return res.status(401).json({success:false,message:'Incorrect account password. Use the same password you use for NECPRA sign-in.',errorCode:'MONEY_STEP_UP_FAILED'});if(user.mfaEnabled){if(!otp)return res.status(428).json({success:false,message:'Enter the 6-digit authenticator code to continue.',errorCode:'MONEY_OTP_REQUIRED'});authenticator.options={...authenticator.options,window:1};if(otp.length!==6||!user.mfaSecret||!authenticator.verify({token:otp,secret:user.mfaSecret}))return res.status(401).json({success:false,message:'Invalid or expired authenticator code. Open your authenticator app and enter the current 6-digit code.',errorCode:'MONEY_OTP_FAILED'});}const secret=moneyJwtSecret();if(!secret)return res.status(503).json({success:false,message:'Money security is not configured',errorCode:'MONEY_SECURITY_NOT_CONFIGURED'});const stepUpToken=jwt.sign({userId:Number(userId),type:'money_step_up'},secret,{expiresIn:'10m'});return ok(res,{stepUpToken,expiresIn:600},200);}));

router.get('/overview',wrap(async(req,res)=>{
 const d=db(), userId=uid(req); if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const memberRows=d.MoneyCircleMember?await d.MoneyCircleMember.findAll({where:{userId,status:'active'},attributes:['circleId']}):[];
 const memberIds=memberRows.map(x=>x.circleId);
 const [circles,requests,contributions]=await Promise.all([
  d.MoneyCircle?.findAll({where:memberIds.length?{[d.Op.or]:[{ownerId:userId},{id:memberIds}]}:{ownerId:userId},order:[['createdAt','DESC']],limit:30})||[],
  d.MoneyRequest?.findAll({where:{requesterId:userId},order:[['createdAt','DESC']],limit:20})||[],
  d.MoneyContribution?.findAll({where:{contributorId:userId},order:[['createdAt','DESC']],limit:20})||[]
 ]);
 const activity=[
  ...requests.map(x=>({kind:'request',title:x.purpose||'Payment request',subtitle:x.status+' · '+x.recipientPhone.replace(/^(\\+?254|0)(\\d{2})\\d{5}(\\d{2})$/,'$1$2*****$3'),amount:x.amount,createdAt:x.createdAt})),
  ...contributions.map(x=>({kind:'contribution',title:'Circle contribution',subtitle:x.status,amount:x.amount,createdAt:x.createdAt}))
 ].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,20);
 const circleRows=circles.map(x=>x.toJSON());
 const cids=circleRows.map(c=>c.id),memberCounts=new Map(),myTotals=new Map();
 if(cids.length){
  const [ms,mc]=await Promise.all([
   d.MoneyCircleMember?d.MoneyCircleMember.findAll({where:{circleId:cids,status:'active'},attributes:['circleId']}):[],
   d.MoneyContribution?d.MoneyContribution.findAll({where:{circleId:cids,contributorId:userId,status:'paid'},attributes:['circleId','amount']}):[]
  ]);
  ms.forEach(m=>memberCounts.set(m.circleId,(memberCounts.get(m.circleId)||0)+1));
  mc.forEach(x=>myTotals.set(x.circleId,(myTotals.get(x.circleId)||0)+Number(x.amount||0)));
 }
 const tracked=circles.reduce((n,x)=>n+Number(x.collectedAmount||0),0);
 const pendingIncoming=d.MoneyRequest?await d.MoneyRequest.count({where:{recipientUserId:userId,status:'requested',expiresAt:{[d.Op.gt]:new Date()}}}):0;
 const pendingOutgoing=requests.filter(x=>x.status==='requested').length;
 return ok(res,{overview:{trackedAmount:tracked,circleCount:circleRows.length,pendingIncoming,pendingOutgoing},circles:circleRows.map(c=>({...c,isOwner:c.ownerId===userId,memberCount:memberCounts.get(c.id)||1,myContributed:myTotals.get(c.id)||0})),activity});
}));

router.get('/circles',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const Member=d.MoneyCircleMember;
 let circles=[];
 if(Member){
  const rows=await Member.findAll({where:{userId,status:'active'},attributes:['circleId']});
  const ids=rows.map(x=>x.circleId);
  if(ids.length)circles=await d.MoneyCircle.findAll({where:{id:ids},order:[['createdAt','DESC']]});
 }
 if(!circles.length&&d.MoneyCircle)circles=await d.MoneyCircle.findAll({where:{ownerId:userId},order:[['createdAt','DESC']]});
 return ok(res,{circles});
}));

router.post('/circles',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const {name,purpose,targetAmount,type='other'}=req.body||{};
 const target=Number(targetAmount||0);
 if(!name||name.length>120)return res.status(400).json({success:false,message:'Circle name is required'});
 if(!Number.isFinite(target)||target<0)return res.status(400).json({success:false,message:'Invalid target amount'});
 const allowed=['chama','family','trip','event','emergency','project','purchase','other'];
 const circle=await d.MoneyCircle.create({ownerId:userId,name:name.trim(),purpose:String(purpose||'').trim()||null,targetAmount:target,type:allowed.includes(type)?type:'other'});
 if(d.MoneyCircleMember)await d.MoneyCircleMember.create({circleId:circle.id,userId,role:'owner',status:'active'});
 return ok(res,{circle},201);
}));

router.get('/circles/:id',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 const member=d.MoneyCircleMember?await d.MoneyCircleMember.findOne({where:{circleId:circle.id,userId,status:'active'}}):null;
 if(!member)return res.status(403).json({success:false,message:'Not a circle member'});
 // Every figure below comes from MoneyContribution rows. A row only becomes 'paid' inside
 // handleMoneyCallback after Safaricom confirms the payment, so neither the owner nor the
 // member can type a contribution in by hand.
 const allContribs=d.MoneyContribution?await d.MoneyContribution.findAll({where:{circleId:circle.id,status:['paid','pending']},order:[['createdAt','DESC']],limit:5000}):[];
 const memberRows=d.MoneyCircleMember?await d.MoneyCircleMember.findAll({where:{circleId:circle.id,status:'active'},order:[['createdAt','ASC']]}):[];
 const ids=[...new Set([...memberRows.map(m=>m.userId),...allContribs.map(c=>c.contributorId)])];
 const us=d.Users&&ids.length?await d.Users.findAll({where:{id:ids},attributes:['id','username','firstName','lastName','avatar']}):[];
 const nm=new Map(us.map(u=>[Number(u.id),[u.firstName,u.lastName].filter(Boolean).join(' ')||u.username||('User '+u.id)]));
 const av=new Map(us.map(u=>[Number(u.id),u.avatar||null]));
 const un=new Map(us.map(u=>[Number(u.id),u.username||null]));
 const stats=new Map(),guestMap=new Map();
 const now=Date.now();
 const isOffline=c=>!!c.method&&c.method!=='mpesa';
 allContribs.forEach(c=>{const k=Number(c.contributorId),meta=c.metadata||{},amt=Number(c.amount||0),off=isOffline(c);
  if(off&&k===0){ // cash/goods from someone who is not on Necpra, recorded by the owner under a typed name
   if(c.status!=='paid')return;const label=String(meta.guestName||'Guest').trim()||'Guest',gk=label.toLowerCase();
   const g=guestMap.get(gk)||{name:label,contributed:0,contributionCount:0,items:[],lastPaidAt:null};
   g.contributed+=amt;g.contributionCount++;if(meta.item)g.items.push(meta.item);if(!g.lastPaidAt||new Date(c.createdAt)>new Date(g.lastPaidAt))g.lastPaidAt=c.createdAt;guestMap.set(gk,g);return;}
  const e=stats.get(k)||{contributed:0,contributionCount:0,pendingAmount:0,lastPaidAt:null,mpesaAmount:0,cashAmount:0,items:[]};
  if(c.status==='paid'){e.contributed+=amt;e.contributionCount++;if(off){e.cashAmount+=amt;if(meta.item)e.items.push(meta.item);}else e.mpesaAmount+=amt;if(!e.lastPaidAt||new Date(c.createdAt)>new Date(e.lastPaidAt))e.lastPaidAt=c.createdAt;}
  else if(c.status==='pending'&&now-new Date(c.createdAt).getTime()<30*60*1000)e.pendingAmount+=amt;
  stats.set(k,e);});
 const blank={contributed:0,contributionCount:0,pendingAmount:0,lastPaidAt:null,mpesaAmount:0,cashAmount:0,items:[]};
 const members=memberRows.map(m=>{const k=Number(m.userId),e=stats.get(k)||blank;return {...m.toJSON(),name:nm.get(k)||('User '+m.userId),username:un.get(k)||null,avatar:av.get(k)||null,isYou:k===Number(userId),...e};})
  .sort((a,b)=>(b.contributed-a.contributed)||(a.role==='owner'?-1:b.role==='owner'?1:0)||String(a.name).localeCompare(String(b.name)));
 const W=require('../services/moneyReminderWorker');
 const sched=(circle.settings&&circle.settings.schedule&&circle.settings.schedule.dueDate)?circle.settings.schedule:null;
 if(sched){const pm=await W.paidByMember(d,circle);members.forEach(m=>{m.cyclePaid=pm.get(Number(m.userId))||0;m.owes=!W.hasPaid(sched,m.cyclePaid);});}
 const paidList=allContribs.filter(c=>c.status==='paid');
 const ledgerTotal=paidList.reduce((n,c)=>n+Number(c.amount||0),0);
 const cashTotal=paidList.filter(isOffline).reduce((n,c)=>n+Number(c.amount||0),0);
 const guests=[...guestMap.values()].sort((a,b)=>(b.contributed-a.contributed)||a.name.localeCompare(b.name));
 return ok(res,{circle,isOwner:circle.ownerId===userId,members,guests,schedule:sched?{...sched,daysLeft:W.dayDiff(sched.dueDate,W.nairobiParts())}:null,
  totals:{collected:ledgerTotal,mpesa:ledgerTotal-cashTotal,cash:cashTotal,paidCount:paidList.length,membersPaid:members.filter(m=>m.contributed>0||m.items.length>0).length,membersUnpaid:members.filter(m=>!(m.contributed>0||m.items.length>0)).length},
  contributions:paidList.slice(0,100).map(c=>{const meta=c.metadata||{},k=Number(c.contributorId),off=isOffline(c);return {...c.toJSON(),offline:off,item:meta.item||null,contributorName:(off&&k===0)?(meta.guestName||'Guest'):(nm.get(k)||'Member')}})});
}));

// Type-to-search for the "Add member" box (owner only, same rule as adding).
router.get('/circles/:id/member-search',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can add members'});
 const U=d.Users;if(!U)return res.status(503).json({success:false,message:'User service unavailable'});
 const q=String(req.query.q||'').trim().replace(/^@/,'').slice(0,40);
 const have=new Set((await d.MoneyCircleMember.findAll({where:{circleId:circle.id,status:'active'},attributes:['userId']})).map(m=>Number(m.userId)));
 let friendUsers=[];
 try{if(d.Friend&&d.Friend.getUserFriends){friendUsers=(await d.Friend.getUserFriends(userId)).map(r=>r.user).filter(Boolean);}}catch(_){friendUsers=[];}
 const friendIds=new Set(friendUsers.map(u=>Number(u.id)));
 let users=[];
 if(q.length>=2){
  const like=q.replace(/[\\%_]/g,'\\$&'),Op=d.Op;
  const or=[{username:{[Op.iLike]:'%'+like+'%'}},{firstName:{[Op.iLike]:'%'+like+'%'}},{lastName:{[Op.iLike]:'%'+like+'%'}}];
  const digits=q.replace(/\D/g,'');
  if(digits.length>=9)or.push({phone:{[Op.like]:'%'+digits.slice(-9)}});
  users=await U.findAll({where:{isActive:true,[Op.or]:or},attributes:['id','username','firstName','lastName','avatar'],limit:25});
 }else if(!q){users=friendUsers.slice(0,30);}
 const out=users.filter(u=>!have.has(Number(u.id))).map(u=>({id:u.id,username:u.username||null,displayName:[u.firstName,u.lastName].filter(Boolean).join(' ')||u.username||('User '+u.id),avatar:u.avatar||null,isFriend:friendIds.has(Number(u.id))}))
  .sort((a,b)=>(b.isFriend-a.isFriend)||String(a.displayName).localeCompare(String(b.displayName)));
 return ok(res,{users:out,query:q,suggestions:!q});
}));

router.post('/circles/:id/members',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can add members'});
 let targetId=Number(req.body?.userId);
 if(!Number.isInteger(targetId)||targetId<1){
  const U=d.Users,phoneRaw=String(req.body?.phone||'').trim(),uname=String(req.body?.username||'').trim().replace(/^@/,'');
  let found=null;
  if(U&&phoneRaw){let ph;try{ph=normalizePhone(phoneRaw);}catch(e){return res.status(400).json({success:false,message:e.message});}found=await U.findOne({where:{phone:{[d.Op.or]:[ph,'+'+ph,'0'+ph.slice(3)]}}});}
  else if(U&&uname){found=await U.findOne({where:{username:{[d.Op.iLike]:uname.replace(/[\\%_]/g,'\\$&')}}});}
  if(!found)return res.status(404).json({success:false,message:'No Necpra account matches that. Ask them to join Necpra first, or pick them from the search results.',errorCode:'MONEY_MEMBER_NOT_FOUND'});
  targetId=Number(found.id);
 }
 const [member,created]=await d.MoneyCircleMember.findOrCreate({where:{circleId:circle.id,userId:targetId},defaults:{circleId:circle.id,userId:targetId,role:'member',status:'active'}});
 if(!created&&member.status!=='active')await member.update({status:'active'});
 if(created&&targetId!==userId){try{const W=require('../services/moneyReminderWorker'),sc=circle.settings&&circle.settings.schedule;
  const amt=sc&&Number(sc.amountPerMember)>0?' Contribution: KSh '+Number(sc.amountPerMember).toLocaleString('en-KE')+(sc.dueDate?' by '+sc.dueDate:'')+'.':'';
  await W.notify(targetId,circle,'You were added to "'+circle.name+'"','You are now a member of this Money Circle.'+amt,'added');}catch(e){console.warn('[money] add-member notify failed',e.message);}}
 return ok(res,{member,created},created?201:200);
}));

// Owner sets / changes / clears the contribution schedule. Changing it starts a new cycle (startedAt = now),
// so earlier payments no longer count as "paid" for the new due date.
router.put('/circles/:id/schedule',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can set the schedule'});
 const W=require('../services/moneyReminderWorker');
 const settings={...(circle.settings||{})};
 if(req.body?.clear===true){delete settings.schedule;delete settings.reminderLog;}
 else{
  const dueDate=String(req.body?.dueDate||'').trim(),amount=Number(req.body?.amountPerMember||0);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)||isNaN(Date.parse(dueDate+'T00:00:00Z')))return res.status(400).json({success:false,message:'Choose a valid due date'});
  if(!Number.isFinite(amount)||amount<0||amount>1000000)return res.status(400).json({success:false,message:'Enter a valid amount per member'});
  settings.schedule={dueDate,amountPerMember:amount,remindersEnabled:req.body?.remindersEnabled!==false,startedAt:new Date().toISOString()};
  delete settings.reminderLog;
 }
 circle.settings=settings;circle.changed('settings',true);await circle.save();
 if(settings.schedule){ // tell every other member right away
  const members=await d.MoneyCircleMember.findAll({where:{circleId:circle.id,status:'active'},attributes:['userId']});
  const sc=settings.schedule,amt=sc.amountPerMember>0?'KSh '+Number(sc.amountPerMember).toLocaleString('en-KE'):'your contribution';
  for(const m of members){if(Number(m.userId)===userId)continue;try{await W.notify(Number(m.userId),circle,'New contribution schedule: '+circle.name,'Please pay '+amt+' by '+sc.dueDate+'. You will get reminders before the due date.','schedule');}catch(_){}}
 }
 return ok(res,{schedule:settings.schedule||null});
}));

// Owner prompts one chosen member (or all unpaid members) at any time. Paid members are never prompted.
router.post('/circles/:id/prompt',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can send prompts'});
 const W=require('../services/moneyReminderWorker');
 const sc=circle.settings&&circle.settings.schedule;
 const unpaid=sc&&sc.dueDate?await W.unpaidMembers(d,circle):(await d.MoneyCircleMember.findAll({where:{circleId:circle.id,status:'active'},attributes:['userId']})).map(m=>Number(m.userId));
 const target=req.body?.userId!=null?[Number(req.body.userId)]:unpaid;
 const log={...((circle.settings&&circle.settings.manualPrompts)||{})};const now=Date.now();let sent=0,skippedPaid=0,throttled=0;
 for(const t of target){
  if(t===userId)continue;
  if(!unpaid.includes(t)){skippedPaid++;continue;}
  if(log[t]&&now-log[t]<10*60*1000){throttled++;continue;} // max one manual prompt per member per 10 minutes
  const amt=sc&&Number(sc.amountPerMember)>0?'KSh '+Number(sc.amountPerMember).toLocaleString('en-KE'):'your contribution';
  try{await W.notify(t,circle,'Payment reminder: '+circle.name,'The circle owner is reminding you to pay '+amt+(sc&&sc.dueDate?' (due '+sc.dueDate+')':'')+'.','prompt');log[t]=now;sent++;}catch(e){console.warn('[money] prompt failed',e.message);}
 }
 circle.settings={...(circle.settings||{}),manualPrompts:log};circle.changed('settings',true);await circle.save();
 return ok(res,{sent,skippedPaid,throttled});
}));

// Cash / goods received outside M-Pesa (e.g. "1 goat + 1,000"). Only the circle owner can record these, they need a fresh
// password step-up, they are labelled as owner-recorded everywhere, and they can be voided (never silently edited).
router.post('/circles/:id/offline-contributions',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can record cash or goods'});
 if(!requireMoneyStepUp(req,res,userId))return;
 const b=req.body||{},amount=Number(b.amount||0),item=String(b.item||'').trim().slice(0,120),note=String(b.note||'').trim().slice(0,255);
 if(!Number.isFinite(amount)||amount<0||amount>10000000)return res.status(400).json({success:false,message:'Enter a valid cash amount (0 if only goods)'});
 if(!(amount>0)&&!item)return res.status(400).json({success:false,message:'Enter a cash amount or describe the goods (e.g. 1 goat)'});
 let contributorId=0,guestName=null;
 const targetId=Number(b.userId);
 if(Number.isInteger(targetId)&&targetId>0){
  const m=await d.MoneyCircleMember.findOne({where:{circleId:circle.id,userId:targetId,status:'active'}});
  if(!m)return res.status(400).json({success:false,message:'That person is not a member of this circle'});
  contributorId=targetId;
 }else{
  guestName=String(b.guestName||'').trim().replace(/\s+/g,' ').slice(0,80);
  if(guestName.length<2)return res.status(400).json({success:false,message:'Choose a member or type the contributor\'s name'});
 }
 const recent=await d.MoneyContribution.count({where:{circleId:circle.id,method:['cash','in_kind'],createdAt:{[d.Op.gte]:new Date(Date.now()-60*1000)}}});
 if(recent>=30)return res.status(429).json({success:false,message:'Too many entries in a minute. Wait a moment and try again.'});
 const contribution=await d.MoneyContribution.create({circleId:circle.id,contributorId,amount,method:item?'in_kind':'cash',status:'paid',note:note||null,
  metadata:{offline:true,recordedBy:userId,recordedAt:new Date().toISOString(),item:item||null,guestName}});
 if(amount>0)await d.MoneyCircle.increment('collectedAmount',{by:amount,where:{id:circle.id}});
 return ok(res,{contribution},201);
}));

router.post('/circles/:id/offline-contributions/:contributionId/void',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can void an entry'});
 if(!requireMoneyStepUp(req,res,userId))return;
 const c=await d.MoneyContribution.findOne({where:{id:req.params.contributionId,circleId:circle.id,method:['cash','in_kind'],status:'paid'}});
 if(!c)return res.status(404).json({success:false,message:'Cash or goods entry not found'});
 const [moved]=await d.MoneyContribution.update({status:'refunded',metadata:{...(c.metadata||{}),voided:true,voidedBy:userId,voidedAt:new Date().toISOString()}},{where:{id:c.id,status:'paid'}});
 if(moved&&Number(c.amount)>0)await d.MoneyCircle.decrement('collectedAmount',{by:Number(c.amount),where:{id:circle.id}});
 return ok(res,{voided:!!moved});
}));

router.post('/circles/:id/contributions',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 const member=await d.MoneyCircleMember?.findOne({where:{circleId:circle.id,userId,status:'active'}});if(!member)return res.status(403).json({success:false,message:'Not a circle member'});
 const amount=Number(req.body?.amount);if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({success:false,message:'Valid amount required'});
 const contribution=await d.MoneyContribution.create({circleId:circle.id,contributorId:userId,amount,method:'mpesa',status:'pending',note:req.body?.note||null});
 return ok(res,{contribution,nextStep:'Call /money/circles/:id/contributions/:contributionId/pay with the payer phone.'},201);
}));

router.post('/circles/:id/contributions/:contributionId/pay',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const c=await d.MoneyContribution?.findOne({where:{id:req.params.contributionId,circleId:req.params.id,contributorId:userId,status:'pending'}});if(!c)return res.status(404).json({success:false,message:'Pending contribution not found'});
 const result=await mpesaStk({phone:req.body?.phone,amount:Number(c.amount),reference:'NC'+String(c.id).replace(/-/g,'').slice(-10),description:'NECPRA Circle',callbackPath:'/api/money/mpesa/callback'});
 await c.update({paymentRef:result.CheckoutRequestID,metadata:{...(c.metadata||{}),checkoutRequestId:result.CheckoutRequestID}});
 return ok(res,{status:'pending',contributionId:c.id,checkoutRequestId:result.CheckoutRequestID},202);
}));

router.get('/requests',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const now=new Date();
 await d.MoneyRequest?.update({status:'expired'},{where:{requesterId:userId,status:'requested',expiresAt:{[d.Op.lt]:now}}});
 const requests=await d.MoneyRequest?.findAll({where:{requesterId:userId},order:[['createdAt','DESC']],limit:50})||[];
 return ok(res,{requests:requests.map(x=>{const j=x.toJSON();j.recipientPhone=j.recipientPhone.replace(/^(\\+?254|0)(\\d{2})\\d{5}(\\d{2})$/,'$1$2*****$3');return j;})});
}));

router.get('/requests/incoming',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const now=new Date();
 await d.MoneyRequest?.update({status:'expired'},{where:{recipientUserId:userId,status:'requested',expiresAt:{[d.Op.lt]:now}}});
 const requests=await d.MoneyRequest?.findAll({where:{recipientUserId:userId},order:[['createdAt','DESC']],limit:50})||[];
 const User=d.Users;
 const requesterIds=[...new Set(requests.map(x=>x.requesterId))];
 const users=User&&requesterIds.length?await User.findAll({where:{id:requesterIds},attributes:['id','username','firstName','lastName','avatar','isVerified']}):[];
 const byId=new Map(users.map(u=>[u.id,u]));
 return ok(res,{requests:requests.map(x=>{const j=x.toJSON();delete j.recipientPhone;const u=byId.get(x.requesterId);j.requester=u?{id:u.id,username:u.username,displayName:u.displayName,avatar:u.avatar,isVerified:!!u.isVerified}:null;return j;})});
}));

router.get('/requests/:id',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const request=await d.MoneyRequest?.findByPk(req.params.id);if(!request)return res.status(404).json({success:false,message:'Payment request not found'});
 if(request.requesterId!==userId&&request.recipientUserId!==userId)return res.status(403).json({success:false,message:'You are not allowed to view this request'});
 if(request.status==='requested'&&request.expiresAt&&new Date(request.expiresAt)<new Date()){await request.update({status:'expired'});}
 const j=request.toJSON();
 if(request.recipientUserId!==userId)j.recipientPhone=j.recipientPhone.replace(/^(\\+?254|0)(\\d{2})\\d{5}(\\d{2})$/,'$1$2*****$3');
 else delete j.recipientPhone;
 return ok(res,{request:j});
}));

router.post('/requests/:id/cancel',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const request=await d.MoneyRequest?.findOne({where:{id:req.params.id,requesterId:userId,status:'requested'}});if(!request)return res.status(404).json({success:false,message:'Active payment request not found'});
 await request.update({status:'cancelled'});
 return ok(res,{request});
}));

router.post('/requests',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 if(!requireMoneyStepUp(req,res,userId))return;
 const amount=Number(req.body?.amount),rawPhone=String(req.body?.recipientPhone||'').trim(),purpose=String(req.body?.purpose||'').trim().slice(0,255);
 let phone;try{phone=normalizePhone(rawPhone);}catch(e){return res.status(400).json({success:false,message:'Enter a valid Kenyan M-Pesa number'});}
 if(!Number.isFinite(amount)||amount<=0||amount>50000)return res.status(400).json({success:false,message:'Amount must be between KSh 1 and KSh 50,000'});
 if(!purpose)return res.status(400).json({success:false,message:'A clear payment purpose is required'});
 const User=d.Users;
 let recipient=null;
 if(User)recipient=await User.findOne({where:{phone:{[d.Op.or]:[phone,'+'+phone,'0'+phone.slice(3)]}}});
 const requester=User?await User.findByPk(userId,{attributes:['id','phone','username','firstName','lastName','isVerified']}):null;
 if(requester?.phone){try{if(normalizePhone(requester.phone)===phone)return res.status(400).json({success:false,message:'You cannot create a payment request to your own number'});}catch(_){}}
 const dayStart=new Date(Date.now()-24*60*60*1000);
 const recent=await d.MoneyRequest.count({where:{requesterId:userId,createdAt:{[d.Op.gte]:dayStart}}});
 if(recent>=20)return res.status(429).json({success:false,message:'Too many payment requests today. Try again tomorrow.'});
 const duplicate=await d.MoneyRequest.findOne({where:{requesterId:userId,recipientPhone:phone,amount,purpose,status:'requested',createdAt:{[d.Op.gte]:new Date(Date.now()-10*60*1000)}}});
 if(duplicate)return ok(res,{request:duplicate,nextStep:'This request already exists. Do not create another copy.'},200);
 const idem=String(req.get('Idempotency-Key')||'').trim().slice(0,120)||null;
 if(idem){const existing=await d.MoneyRequest.findOne({where:{requesterId:userId,idempotencyKey:idem}});if(existing)return ok(res,{request:existing,nextStep:'This request was already created.'},200);}
 const expiresAt=new Date(Date.now()+24*60*60*1000);
 const request=await d.MoneyRequest.create({requesterId:userId,recipientUserId:recipient?.id||null,recipientPhone:phone,amount,purpose,status:'requested',expiresAt,idempotencyKey:idem,metadata:{security:{recipientMatchedToNecpraAccount:!!recipient,requesterAccountVerified:!!requester?.isVerified,createdFromAuthenticatedSession:true},warning:recipient?'Verified NECPRA recipient account matched to this phone.':'This phone is not currently matched to a NECPRA account; verify the recipient through a trusted channel before any payment.'}});
 return ok(res,{request,nextStep:recipient?'Request created for a matched NECPRA account. The payer must independently verify the recipient and purpose before approving any future payment.':'Request created, but the recipient is not a matched NECPRA account. Do not pay based on the request alone.'},201);
}));

router.post('/requests/:id/pay',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const R=await d.MoneyRequest?.findOne({where:{id:req.params.id,recipientUserId:userId,status:'requested'}});
 if(!R)return res.status(404).json({success:false,message:'Active payment request not found'});
 if(R.expiresAt&&new Date(R.expiresAt)<new Date()){await R.update({status:'expired'});return res.status(410).json({success:false,message:'This request has expired'});}
 const result=await mpesaStk({phone:req.body?.phone||R.recipientPhone,amount:Number(R.amount),reference:'NR'+String(R.id).replace(/-/g,'').slice(-10),description:'NECPRA Payment',callbackPath:'/api/money/mpesa/callback'});
 await R.update({paymentRef:result.CheckoutRequestID,metadata:{...(R.metadata||{}),checkoutRequestId:result.CheckoutRequestID}});
 return ok(res,{status:'pending',requestId:R.id,checkoutRequestId:result.CheckoutRequestID},202);
}));

module.exports=router;

router.post('/mpesa/callback',(req,res)=>{handleMoneyCallback(req.body?.Body?.stkCallback||req.body).then(()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'})).catch(e=>{console.error('[money] callback',e.message);res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});});});
router.mpesaCallback=(req,res)=>handleMoneyCallback(req.body?.Body?.stkCallback||req.body).then(()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'})).catch(e=>{console.error('[money] callback',e.message);res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});});
