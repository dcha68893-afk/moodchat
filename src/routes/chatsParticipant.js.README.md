# chatsParticipant.js — DISABLED (P2 Forensic Audit)

This route file (`chatsParticipant.js.disabled`) was disabled because:

1. `src/services/chatParticipantService.js` (which this route's controller
   depends on) `require`s `mongoose`, which is not in package.json
   (removed during the Postgres migration). Loading this file throws
   `MODULE_NOT_FOUND`, causing `/chats-participant` to fail to mount
   (logged as a route-mount failure on every server start — contained to
   this one route, did not crash the server, per the per-file try/catch in
   src/routes/index.js).

2. `chatParticipantController.js` calls 18 service methods
   (`getChatParticipants`, `addParticipantToChat`, `removeParticipantFromChat`,
   `getParticipantDetails`, `updateParticipantSettings`, `leaveChat`,
   `muteChat`, `unmuteChat`, `getReadStatus`, `updateLastRead`,
   `getTypingStatus`, `updateTypingStatus`, `getPresenceStatus`,
   `updatePresence`, `isParticipant`, `getParticipantStatistics`,
   `searchParticipants`, `getOnlineParticipants`) that DO NOT EXIST on
   `chatParticipantService.js` — that file only exports `addParticipants`,
   `removeParticipants`, `getParticipants`, `updateParticipantRole`,
   `getUserConversations`, all written in Mongoose document style
   (`.findById().session()`, `Conversation.participants.push()`,
   `User.find({_id:{$in:...}})`) which is incompatible with the current
   Sequelize/Postgres models regardless of the mongoose import.

3. **The frontend (`moodfronted`) does not call `/chats-participant`
   anywhere.** This route appears unused/orphaned.

## To re-enable
This needs a full rewrite of `src/services/chatParticipantService.js`
against the Sequelize models (`ChatParticipant`, `Chats`, `Users`,
`TypingIndicator`, `UserStatus`, `ReadReceipt` — several of these already
have working, separately-mounted routes that may cover this functionality).
Once rewritten and tested, rename `chatsParticipant.js.disabled` back to
`chatsParticipant.js`.
