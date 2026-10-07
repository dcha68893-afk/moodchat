'use strict';
const express=require('express');
const router=express.Router();
const db=()=>require('../models');
const uid=req=>Number(req.user?.id||req.user?.userId||req.user?.sub||req.userId);
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('[money]',e.message);if(!res.headersSent)res.status(e.status||500).json({success:false,message:e.message||'Server error'});});
function ok(res,data,status=200){return res.status(status).json({success:true,...data});}

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

router.get('/overview',wrap(async(req,res)=>{
 const d=db(), userId=uid(req); if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const [circles,requests,contributions]=await Promise.all([
  d.MoneyCircle?.findAll({where:{ownerId:userId},order:[['createdAt','DESC']],limit:30})||[],
  d.MoneyRequest?.findAll({where:{requesterId:userId},order:[['createdAt','DESC']],limit:20})||[],
  d.MoneyContribution?.findAll({where:{contributorId:userId},order:[['createdAt','DESC']],limit:20})||[]
 ]);
 const activity=[
  ...requests.map(x=>({kind:'request',title:x.purpose||'Payment request',subtitle:x.status+' · '+x.recipientPhone,amount:x.amount,createdAt:x.createdAt})),
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
 const requests=await d.MoneyRequest?.findAll({where:{requesterId:userId},order:[['createdAt','DESC']],limit:50})||[];
 return ok(res,{requests});
}));

router.post('/requests',wrap(async(req,res)=>{
 const d=db(),userId=uid(req);if(!userId)return res.status(401).json({success:false,message:'Unauthorized'});
 const amount=Number(req.body?.amount),phone=String(req.body?.recipientPhone||'').trim(),purpose=String(req.body?.purpose||'').trim();
 if(!/^\+?254[17]\d{8}$/.test(phone.replace(/\s+/g,''))&&!/^0[17]\d{8}$/.test(phone.replace(/\s+/g,'')))return res.status(400).json({success:false,message:'Enter a valid Kenyan mobile number'});
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({success:false,message:'Valid amount required'});
 const request=await d.MoneyRequest.create({requesterId:userId,recipientPhone:phone,amount,purpose:purpose||null});
 return ok(res,{request,nextStep:'A payment request has been created. Actual bill/beneficiary settlement requires the configured merchant or B2C rail.'},201);
}));

module.exports=router;

router.post('/mpesa/callback',(req,res)=>{handleMoneyCallback(req.body?.Body?.stkCallback||req.body).then(()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'})).catch(e=>{console.error('[money] callback',e.message);res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});});});
router.mpesaCallback=(req,res)=>handleMoneyCallback(req.body?.Body?.stkCallback||req.body).then(()=>res.status(200).json({ResultCode:0,ResultDesc:'Accepted'})).catch(e=>{console.error('[money] callback',e.message);res.status(200).json({ResultCode:0,ResultDesc:'Accepted'});});
