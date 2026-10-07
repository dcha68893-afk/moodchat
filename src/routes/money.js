'use strict';
const express=require('express');
const router=express.Router();
const db=()=>require('../models');
const uid=req=>Number(req.user?.id||req.user?.userId||req.user?.sub||req.userId);
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('[money]',e.message);if(!res.headersSent)res.status(e.status||500).json({success:false,message:e.message||'Server error'});});
function ok(res,data,status=200){return res.status(status).json({success:true,...data});}

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
 return ok(res,{contribution,nextStep:'M-Pesa checkout will be attached to this contribution.'},201);
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
 return ok(res,{request,nextStep:'M-Pesa checkout will be attached to this request.'},201);
}));

module.exports=router;
