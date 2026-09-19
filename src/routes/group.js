'use strict';
const express = require('express');
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const messageDeliveryService = require('../services/messageDeliveryService');
const { broadcastNewMessage } = require('../services/messageBroadcast');
const router = express.Router();
router.use(apiRateLimiter);
function getUserId(req){ return req.user && (req.user.userId || req.user.id || req.user.sub); }
function safeInt(v){ const n=parseInt(v,10); return Number.isFinite(n)&&n>0?n:null; }
function statusFor(err){ return err.status || (err.name==='ValidationError'?400:err.name==='ForbiddenError'?403:500); }
// Compatibility transport for the legacy Group OS client. Storage and lifecycle
// remain canonical in Messages/chat_participants + messageDeliveryService.
router.get('/:groupId/messages', asyncHandler(async(req,res)=>{
 const userId=getUserId(req); if(!userId)return res.status(401).json({success:false,message:'Authentication required'});
 const groupId=safeInt(req.params.groupId); if(!groupId)return res.status(400).json({success:false,message:'Invalid groupId'});
 try{const limit=Math.min(safeInt(req.query.limit)||100,200);const rows=await messageDeliveryService.getMissedMessages(userId,groupId,{limit});return res.json({success:true,data:rows});}
 catch(err){return res.status(statusFor(err)).json({success:false,message:err.message});}
}));
router.post('/:groupId/messages', asyncHandler(async(req,res)=>{
 const senderId=getUserId(req); if(!senderId)return res.status(401).json({success:false,message:'Authentication required'});
 const groupId=safeInt(req.params.groupId); if(!groupId)return res.status(400).json({success:false,message:'Invalid groupId'});
 const body=req.body||{},content=body.content==null?'':String(body.content).trim(),type=String(body.type||'text');
 const clientMessageId=String(body.clientMessageId||body.localId||'').trim();
 if(!clientMessageId)return res.status(400).json({success:false,message:'clientMessageId is required'});
 if(type==='text'&&!content)return res.status(400).json({success:false,message:'Content cannot be empty for text messages'});
 try{
  const {message,alreadyExisted}=await messageDeliveryService.sendMessage({chatId:groupId,senderId,content,type,clientMessageId,replyToId:body.replyToId||null,metadata:body.metadata||null,expiresAt:body.expiresAt||null});
  if(!alreadyExisted)broadcastNewMessage(message,senderId).catch(err=>console.error('[GroupMessages] broadcastNewMessage failed:',err.message));
  return res.status(alreadyExisted?200:201).json({success:true,data:message,alreadyExisted});
 }catch(err){return res.status(statusFor(err)).json({success:false,message:err.message,code:err.code});}
}));
router.post('/:groupId/messages/read', asyncHandler(async(req,res)=>{
 const userId=getUserId(req); if(!userId)return res.status(401).json({success:false,message:'Authentication required'});
 const groupId=safeInt(req.params.groupId); if(!groupId)return res.status(400).json({success:false,message:'Invalid groupId'});
 try{
  const ids=Array.isArray(req.body?.messageIds)?req.body.messageIds.map(Number).filter(Number.isFinite):[];
  if(!ids.length)return res.status(400).json({success:false,message:'messageIds array is required'});
  await messageDeliveryService.getMissedMessages(userId,groupId,{limit:1});
  await messageDeliveryService.markRead(ids,userId);
  return res.json({success:true});
 }catch(err){return res.status(statusFor(err)).json({success:false,message:err.message});}
}));
module.exports=router;