// =============================================================================
// messageBroadcast.js — canonical post-create realtime delivery
// =============================================================================
'use strict';
function getSequelize(){return require('../models').sequelize;}
async function broadcastNewMessage(message,senderId){
 const sequelize=getSequelize(),wsService=require('./webSocketService'),messageDeliveryService=require('./messageDeliveryService');
 const senderIdInt=parseInt(senderId,10),chatIdInt=parseInt(message.chatId,10);
 if(!Number.isInteger(chatIdInt)||chatIdInt<=0){console.error('[Messages] Refusing realtime broadcast: invalid chatId');return{recipientIds:[],delivered:[],offline:[]};}
 const participants=await sequelize.query(`SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId"=:chatId AND "userId"!=:senderId`,{replacements:{chatId:chatIdInt,senderId:senderIdInt},type:sequelize.QueryTypes.SELECT}).catch(()=>[]);
 const recipientIds=participants.map(p=>p.userId).filter(Boolean);
 const [chat]=await sequelize.query(`SELECT "type" FROM "chats" WHERE id=:chatId LIMIT 1`,{replacements:{chatId:chatIdInt},type:sequelize.QueryTypes.SELECT}).catch(()=>[null]);
 const chatType=String(chat?.type||'').toLowerCase();
 if(chatType!=='group'&&chatType!=='direct'){console.error(`[Messages] Refusing realtime broadcast: unsupported chat type for chatId=${chatIdInt}`);return{recipientIds,delivered:[],offline:recipientIds.slice()};}
 const payload={id:message.id,chatId:message.chatId,conversationId:message.chatId,chatType,isGroup:chatType==='group',senderId:message.senderId,content:message.content,type:message.type,sender:message.sender||null,replyToId:message.replyToId||null,clientMessageId:message.clientMessageId||null,metadata:message.metadata||null,createdAt:message.createdAt,sentAt:message.sentAt,status:'sent'};
 // Post-commit sender echo: this lets the message iframe reconcile its
 // optimistic bubble even if the REST response times out after the database
 // transaction has already committed.
 await wsService.sendToUser(senderIdInt,'message:new',payload).catch(()=>{});
 await wsService.sendToUser(senderIdInt,'message:sent',{serverId:message.id,messageId:message.id,localId:message.clientMessageId||null,clientMessageId:message.clientMessageId||null,chatId:message.chatId,sentAt:message.sentAt||message.createdAt}).catch(()=>{});
 if(!recipientIds.length){await messageDeliveryService.notifyMessageRecipients(message,[],{push:false,offlineRecipientIds:[]}).catch(()=>{});return{recipientIds:[],delivered:[],offline:[]};}
 let delivered=[],offline=[];
 if(chatType==='group'){
  const results=await Promise.allSettled(recipientIds.map(uid=>wsService.sendToUser(uid,'group:message',{message:payload,groupId:chatIdInt})));
  recipientIds.forEach((uid,i)=>{const ok=results[i].status==='fulfilled'&&results[i].value===true;(ok?delivered:offline).push(uid);});
 }else{
  const results=await Promise.allSettled(recipientIds.map(uid=>wsService.sendToUser(uid,'message:new',payload)));
  recipientIds.forEach((uid,i)=>{const ok=results[i].status==='fulfilled'&&results[i].value===true;(ok?delivered:offline).push(uid);});
 }
 await messageDeliveryService.notifyMessageRecipients(message,recipientIds,{push:true,offlineRecipientIds:offline}).catch(()=>{});
 return{recipientIds,delivered,offline};
}
module.exports={broadcastNewMessage};
