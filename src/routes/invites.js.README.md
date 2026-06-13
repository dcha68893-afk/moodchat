# invites.js — DISABLED (Forensic Audit follow-up)

This route file (`invites.js.disabled`) was disabled because:

1. It calls `friendController.getFriendRequests`, `friendController.acceptFriendRequest`,
   and `friendController.rejectFriendRequest` — but `src/controllers/friendController.js`
   **exports zero functions** (`Object.keys(friendController)` is `[]`).
   `router.post('/friends/requests/:requestId/accept', friendController.acceptFriendRequest)`
   passes `undefined` as the route handler, which Express rejects with
   `Route.get() requires a callback function but got a [object Undefined]`
   at require()-time — this crashed the `/invites` route mount on every
   server boot.

2. **All functionality in this file is redundant** with working, already-
   mounted routes:
   - `/groups/invites`, `/groups/invites/:inviteId/accept|reject`,
     `/groups/invites/user` -> already implemented in `src/routes/group.js`
     via `groupController` (which DOES export these methods correctly),
     and these are the exact paths the frontend (`api-groups.js`) calls.
   - `/friends/request/:userId`, `/friends/requests/incoming`,
     `/friends/requests/send`, `/friends/requests/:id/accept|reject`
     -> already implemented in `src/routes/friends.js` with working inline
     logic (no controller dependency).

## To re-enable
Not recommended — functionality is fully covered elsewhere. If re-enabling
is desired anyway, `src/controllers/friendController.js` needs the four
methods implemented from scratch (it currently has none), and the
`ROUTE_MAPPING` entry `'invites.js': '/invites'` in `src/routes/index.js`
would need to be removed if you choose to delete this file instead of
re-enabling it.
