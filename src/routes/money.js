'use strict';
const express=require('express');
const jwt=require('jsonwebtoken');
const { comparePassword }=require('../utils/passwordUtils');
const router=express.Router();
const db=()=>require('../models');
const uid=req=>Number(req.user?.id||req.user?.userId||req.user?.sub||req.userId);
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('[money]',e.message);if(!res.headersSent)res.status(e.status||500).json({success:false,message:e.message||'Server error'});});
function ok(res,data,status=200){return res.status(status).json({success:true,...data});}
const moneyJwtSecret=()=>process.env.JWT_ACCESS_SECRET||process.env.JWT_SECRET||'';
function verifyMoneyStepUp(req,userId){const token=String(req.get('X-Money-Step-Up')||'').trim();const secret=moneyJwtSecret();if(!token||!secret)return false;try{const p=jwt.verify(token,secret);return p&&p.type==='money_step_up'&&Number(p.userId)===Number(userId);}catch(_){return false;}}
function requireMoneyStepUp(req,res,userId){if(!verifyMoneyStepUp(req,userId)){res.status(401).json({success:false,message:'Fresh account authentication is required for this money action.',errorCode:'MONEY_STEP_UP_REQUIRED'});return false;}return true;}

function normalizePhone(phone){let d=String(phone||'').replace(/\D/g,'');if(/^0[17]\d{8}$/.test(d))d='254'+d.slice(1);else if(/^[17]\d{8}$/.test(d))d='254'+d;if(!/^254[17]\d{8}$/.test(d))throw Object.assign(new Error('Enter a valid Kenyan M-Pesa number (07XX XXX XXX)'),{status:400});return d;}
async function mpesaStk({phone,amount,reference,description,callbackPath}){
 const consumerKey=process.env.MPESA_CONSUMER_KEY||'',consumerSecret=process.env.MPESA_CONSUMER_SECRET||'',shortcode=process.env.MPESA_SHORTCODE||'',passkey=process.env.MPESA_PASSKEY||'';
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
 if(C){if(Number(C.amount)!==amount)return;if(body.ResultCode===0||String(body.ResultCode)==='0'){if(C.status!=='paid'){await C.update({status:'paid',paymentRef:receipt||checkoutId,metadata:{...(C.metadata||{}),checkoutRequestId:checkoutId,receipt}});const circle=await d.MoneyCircle.findByPk(C.circleId);if(circle)await circle.increment('collectedAmount',{by:amount});}}else if(C.status==='pending')await C.update({status:'failed',metadata:{...(C.metadata||{}),failureCode:body.ResultCode,failureDescription:body.ResultDesc}});return;}
 const R=d.MoneyRequest&&await d.MoneyRequest.findOne({where:{paymentRef:checkoutId}});if(R){if(Number(R.amount)!==amount)return;if(body.ResultCode===0||String(body.ResultCode)==='0'){if(R.status!=='paid')await R.update({status:'paid',paymentRef:receipt||checkoutId,metadata:{...(R.metadata||{}),checkoutRequestId:checkoutId,receipt}});}else if(R.status==='requested')await R.update({status:'expired',metadata:{...(R.metadata||{}),failureCode:body.ResultCode,failureDescription:body.ResultDesc}});}
}

router.post('/security/step-up',wrap(async(req,res)=>{const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});const password=String(req.body?.password||'');if(!password)return res.status(400).json({success:false,message:'Account password is required'});const User=d.Users||d.User;if(!User)return res.status(500).json({success:false,message:'User service unavailable'});const user=await User.findByPk(userId);if(!user)return res.status(401).json({success:false,message:'Account not found'});const valid=await comparePassword(password,user.password);if(!valid)return res.status(401).json({success:false,message:'Incorrect account password',errorCode:'MONEY_STEP_UP_FAILED'});const secret=moneyJwtSecret();if(!secret)return res.status(503).json({success:false,message:'Money security is not configured',errorCode:'MONEY_SECURITY_NOT_CONFIGURED'});const stepUpToken=jwt.sign({userId:Number(userId),type:'money_step_up'},secret,{expiresIn:'10m'});return ok(res,{stepUpToken,expiresIn:600},200);}));

router.get('/overview',wrap(async(req,res)=>{
 const d=db(), userId=uid(req); if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const [circles,requests,contributions]=await Promise.all([
  d.MoneyCircle?.findAll({where:{ownerId:userId},order:[['createdAt','DESC']],limit:30})||[],
  d.MoneyRequest?.findAll({where:{requesterId:userId},order:[['createdAt','DESC']],limit:20})||[],
  d.MoneyContribution?.findAll({where:{contributorId:userId},order:[['createdAt','DESC']],limit:20})||[]
 ]);
 const activity=[
  ...requests.map(x=>({kind:'request',title:x.purpose||'Payment request',subtitle:x.status+' · '+x.recipientPhone.replace(/^(\\+?254|0)(\\d{2})\\d{5}(\\d{2})$/,'$1$2*****$3'),amount:x.amount,createdAt:x.createdAt})),
  ...contributions.map(x=>({kind:'contribution',title:'Circle contribution',subtitle:x.status,amount:x.amount,createdAt:x.createdAt}))
 ].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,20);
 const circleRows=circles.map(x=>x.toJSON());
 const tracked=circles.reduce((n,x)=>n+Number(x.collectedAmount||0),0);
 return ok(res,{overview:{trackedAmount:tracked},circles:circleRows,activity});
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
 const contributions=d.MoneyContribution?await d.MoneyContribution.findAll({where:{circleId:circle.id},order:[['createdAt','DESC']],limit:100}):[];
 return ok(res,{circle,members:d.MoneyCircleMember?await d.MoneyCircleMember.findAll({where:{circleId:circle.id,status:'active'}}):[],contributions});
}));

router.post('/circles/:id/members',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const circle=await d.MoneyCircle?.findByPk(req.params.id);if(!circle)return res.status(404).json({success:false,message:'Circle not found'});
 if(circle.ownerId!==userId)return res.status(403).json({success:false,message:'Only the circle owner can add members'});
 const targetId=Number(req.body?.userId);if(!Number.isInteger(targetId)||targetId<1)return res.status(400).json({success:false,message:'Valid userId required'});
 const [member,created]=await d.MoneyCircleMember.findOrCreate({where:{circleId:circle.id,userId:targetId},defaults:{circleId:circle.id,userId:targetId,role:'member',status:'active'}});
 return ok(res,{member,created},created?201:200);
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

module.exports=router;

router.post('/mpesa/callback',(req,res)=>{handleMoneyCallback(req.body?.Body?.stkCallback||req.body).then(()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'})).catch(e=>{console.error('[money] callback',e.message);res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});});});
router.mpesaCallback=(req,res)=>handleMoneyCallback(req.body?.Body?.stkCallback||req.body).then(()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'})).catch(e=>{console.error('[money] callback',e.message);res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});});
