# Message Lifecycle Rebuild — Backend (nexopa)

Scope agreed with you: **messages only**. Calls/groups/games and the shared
iframe relay system are untouched.

## Root cause (verified by reading the actual code, not guessing)

1. **No idempotency key on send.** A message had no client-generated ID the
   server would recognize on retry, so a client couldn't safely resend after
   a dropped connection without risking a duplicate. That's the opposite of
   the Signal lifecycle you described (local PENDING → persistent queue →
   automatic resend, no duplicate risk).
2. **Dead-letter reconnect sync.** `webSocketService.js` already emits
   `sync:missed_messages_result` on reconnect with any messages the server
   held for you while you were offline — but nothing on the frontend was
   listening for that event. Correctly-queued messages were fetched and then
   thrown away client-side. This is the biggest single explanation for
   "sometimes the message just doesn't show up."

## What was added (all additive — nothing removed)

| File | What |
|---|---|
| `migrations/2026999990013_add_message_lifecycle_fields.js` | Adds `clientMessageId`, `status`, `deliveryAttempts` to `Messages`; unique index on `(senderId, clientMessageId)` for idempotency; backfills `status` on existing rows. |
| `src/models/Message.js` | Model updated with the three new fields. |
| `src/services/messageDeliveryService.js` | **New.** Single canonical service: `sendMessage()` (idempotent), `markDelivered()`, `markRead()`, `getMissedMessages()`. |
| `src/sockets/messageLifecycleSocket.js` | **New.** Registers a separate `msg:*` socket event namespace (`msg:send`, `msg:delivered_ack`, `msg:read`, `msg:sync`) that doesn't collide with the existing `message:*` events calls/groups/games use. |
| `src/services/webSocketService.js` | One additive `require(...).register(...)` call on connection. Nothing existing was removed. |
| `src/routes/messages.js` | Two new endpoints: `POST /api/messages/lifecycle/send` and `GET /api/messages/lifecycle/sync/:chatId`, for when a client has no live socket. |

## Deploy steps

```bash
npm run db:migrate           # or db:migrate:render on Render
npm run start                # or your normal deploy
```

No env vars, no config changes. The old `message:*` pipeline keeps running
exactly as before — this is a second, parallel, canonical pipeline the new
frontend module (`MessageLifecycleClient.js`) uses, not a replacement.

## What I'd still recommend (not done, out of scope for "messages only")

- Once you're confident in the new `msg:*` path, you can retire the old
  `message:send` / duplicate-emit code in `messageService.js` and
  `webSocketService.js` — but that touches code other features may still
  read from, so I left it alone per your call on scope.
- The stray top-level `models/` and `routes/` directories at the repo root
  are dead code (the app's `routesDir`/`modelsPath` both resolve to `src/`
  at runtime — confirmed by tracing `server.js`). Safe to delete, just
  didn't want to do it silently in the same pass as functional changes.
