/**
 * group-suggestions.js — canonical group discovery/suggestion endpoints.
 * Uses the existing Chats + ChatParticipant tables; it does not create a
 * second group membership store.
 */
'use strict';

const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const db = require('../models');

function auth(req,res,next){
  const user=req.user||{};
  const id=Number(user.id||user.userId||user.sub||req.userId);
  if(!Number.isFinite(id)||id<=0) return res.status(401).json({success:false,message:'Authentication required'});
  req.__suggestionUserId=id;
  next();
}
function limitOf(req){
  const n=Number.parseInt(req.query.limit,10);
  return Math.min(100,Math.max(1,Number.isFinite(n)?n:30));
}
async function buildSuggestions(userId,limit){
  const Chat=db.Chats||db.Chat;
  const ChatParticipant=db.ChatParticipant;
  if(!Chat||!ChatParticipant) return [];
  const memberships=await ChatParticipant.findAll({where:{userId},attributes:['chatId'],raw:true});
  const memberIds=memberships.map(x=>Number(x.chatId)).filter(Number.isFinite);
  const where={type:'group'};
  if(memberIds.length) where.id={[Op.notIn]:memberIds};
  const groups=await Chat.findAll({where,order:[['updatedAt','DESC']],limit:Math.min(300,limit*5)});
  return groups.map(g=>{
    const x=g.toJSON?g.toJSON():g;
    const visibility=String(x.visibility||x.privacy||'public').toLowerCase();
    const isPublic=x.isPublic===false?false:(visibility!=='private'&&visibility!=='secret');
    if(!isPublic)return null;
    return {id:x.id,name:x.name||x.chatName||'Group',description:x.description||'',avatar:x.avatar||x.image||null,
      memberCount:Number(x.memberCount||x.participantCount||0),category:x.category||null,
      reason:'Suggested because it is a public group you have not joined'};
  }).filter(Boolean).slice(0,limit);
}
router.get('/',auth,async(req,res)=>{
  try{const suggestions=await buildSuggestions(req.__suggestionUserId,limitOf(req));res.json({success:true,data:suggestions,suggestions});}
  catch(err){console.error('[GroupSuggestions] list failed:',err);res.status(500).json({success:false,message:'Failed to load group suggestions',code:'GROUP_SUGGESTIONS_FAILED'});}
});
router.get('/manage',auth,async(req,res)=>{
  try{const suggestions=await buildSuggestions(req.__suggestionUserId,limitOf(req));res.json({success:true,data:{suggestions,total:suggestions.length},suggestions,total:suggestions.length});}
  catch(err){console.error('[GroupSuggestions] manage failed:',err);res.status(500).json({success:false,message:'Failed to load group suggestions',code:'GROUP_SUGGESTIONS_MANAGE_FAILED'});}
});
router.post('/manage',auth,async(req,res)=>{
  try{
    const groupId=Number(req.body?.groupId),action=String(req.body?.action||'').toLowerCase();
    if(!Number.isFinite(groupId)||!['join','dismiss','hide'].includes(action))
      return res.status(400).json({success:false,message:'groupId and action (join, dismiss or hide) are required'});
    if(action==='join'){
      const ChatParticipant=db.ChatParticipant,Chat=db.Chats||db.Chat;
      const group=await Chat.findOne({where:{id:groupId,type:'group'}});
      if(!group)return res.status(404).json({success:false,message:'Group not found'});
      const [membership]=await ChatParticipant.findOrCreate({where:{chatId:groupId,userId:req.__suggestionUserId},
        defaults:{chatId:groupId,userId:req.__suggestionUserId,role:'member'}});
      return res.json({success:true,action,groupId,membership});
    }
    res.json({success:true,action,groupId});
  }catch(err){console.error('[GroupSuggestions] manage action failed:',err);res.status(500).json({success:false,message:'Unable to manage group suggestion',code:'GROUP_SUGGESTION_ACTION_FAILED'});}
});
module.exports=router;
