# Persistent local message cache (WhatsApp-Web-style)

Repo: moodfronted. Files changed: `js/message-client.js` (edited),
`message.html` (edited, 1 script tag added), `js/message-local-db.js` (new).
Diffs for the two edited files are included alongside this changelog
(`message-client.js.diff`, `message.html.diff`).

## Root cause

`js/message-client.js`'s `state` object (`conversations` +
`messagesByConversation`) is a plain in-memory `Map` — the app's single
source of truth for rendering, per the file's own header comment. It has
never been backed by anything on disk. Concretely:

- `openChat()` (message-client.js:1005) unconditionally called
  `await loadHistory(resolvedChatId)` (was line 1224) — a full
  `GET /messages/:chatId` fetch of the last 50 messages — on *every* chat
  open, including the first chat open after a page reload or relogin, even
  though nothing about that conversation had changed since the browser was
  last open.
- Every one of those 50 messages then went through
  `decryptForDisplay()` → `window.KynectaE2E.decryptMessageForDisplay()`,
  redoing the full E2E decrypt (ECDH derive + HKDF + AES-GCM, per
  js/e2e-encryption.js) for messages that had already been decrypted in a
  previous session.
- `loadConversations()` (message-client.js:1312, the sidebar list) had the
  same problem: `GET /chats?limit=50` on every load, with the UI empty until
  that round-trip returned.

Notably, `js/authStorage.js`'s account-switch wipe logic already had a
placeholder for this: `KNOWN_INDEXEDDB_NAMES` (authStorage.js:38-45) reserves
the name `'nexopa_message_lifecycle_v1'` with a comment calling it "Message
history" — but no code anywhere in the repo ever created a database by that
name (confirmed: `grep -rl nexopa_message_lifecycle_v1` matched only that one
comment before this change). The persistence layer was planned for but never
built.

## What was built

### `js/message-local-db.js` (new)

Small, dependency-free IndexedDB wrapper, `window.KynectaMessageCache`, with
two object stores:

- `messages` — keyed by `` `${chatId}::${id}` ``, indexed by `chatId`. Stores
  the full message object as last held in memory, including
  `displayContent` (the resolved plaintext) once decryption succeeds.
- `conversations` — keyed by `chatId`. Stores the sidebar conversation
  object (otherUser, lastMessage with its own resolved `displayContent`,
  unreadCount, muted, etc.).

Deliberately reuses the exact DB name `nexopa_message_lifecycle_v1` already
reserved in `authStorage.js`'s wipe-allowlist, so the existing account-switch
wipe (`wipePreviousAccountData()`, authStorage.js:117) continues to correctly
delete this cache with zero changes to that file. The module also listens for
the `kyn:accountSwitchWipe` event that function dispatches and closes its own
DB connection on it, so `indexedDB.deleteDatabase()` doesn't hang blocked on
this tab's open handle.

Not user-namespaced by design: a plain logout/relogin as the *same* user is
exactly the case this is meant to survive (that's what was asked for); a
switch to a *different* account is handled by the existing wipe, which drops
the whole DB.

Every read/write is wrapped so a failure (private browsing, quota, IndexedDB
unavailable) degrades to "no cache" rather than breaking the app — caching is
strictly additive to the existing network+decrypt path, never a replacement
that could fail closed.

### `js/message-client.js` (edited)

- Added `persistMessage(chatId, message)` / `persistConversation(chatId)` —
  fire-and-forget write-through helpers, never awaited by callers.
- Wired those into every place a message's `displayContent` or metadata
  gets finalized: `applyIncomingMessage` (the file's own documented "one
  place a message enters state"), the plaintext short-circuit and all three
  resolution branches inside `decryptForDisplay`, the
  `kyn:messageDecryptFailed` listener, and `deleteMessage` / `editMessage` /
  `starMessage` / `unstarMessage` / `reactToMessage` / `removeReaction`.
  Deliberately *not* persisting the transient `'Decrypting…'` display state —
  only a final resolved plaintext or the terminal `'🔒 Unable to decrypt
  this message'` placeholder is written, so anything caught mid-flight
  re-attempts fresh on next load instead of being frozen mid-retry.
- Added `hydrateFromCacheThenSync(chatId)`, called from `openChat()` in
  place of the old unconditional `loadHistory(resolvedChatId)` call. It
  replays cached messages through `applyIncomingMessage` (same one entry
  point, so no parallel state-mutation path was added), which short-circuits
  `decryptForDisplay`'s very first line (`if (message.displayContent !==
  undefined) return;`) — cached messages render with zero crypto work. If a
  chat has cached history, only a delta sync runs afterward
  (`syncMissed(chatId, lastCachedId)`, the existing sync-since-id endpoint,
  previously only used for reconnect/focus resync) instead of a blind
  last-50 refetch. A chat with no cache yet still gets the original full
  `loadHistory()`.
- Added `hydrateConversationsFromCache()`, run once at boot alongside the
  existing `loadConversations()` — populates the sidebar from disk
  immediately (no network wait), and the existing network call still runs
  right after to reconcile.
- `syncLastMessageDisplay` now also calls `persistConversation` so the
  sidebar's last-message preview is cache-hit on next load too.
- Cleaned up the optimistic-send reconciliation path (`sendMessage`,
  around the `bucket.delete(optimisticId)` call): when a brand-new chat's
  synthetic `pending:<receiverId>` bucket gets folded into the real
  server-assigned `chatId`, its cache entries (if any) are cleared too, so a
  stale synthetic-id bucket can't resurface as a duplicate on a later load.
  Optimistic ("sending…"/local-echo) messages themselves were never written
  to cache in the first place (no `persistMessage` call on that code path) —
  intentional, so an app closed mid-send doesn't leave a phantom bubble.

### `message.html` (edited)

Added `<script src="/js/message-local-db.js"></script>` immediately before
the existing `<script src="/js/message-client.js"></script>` tag, not
deferred (message-client.js's own top-level bootstrap runs synchronously on
load, same as before).

## Testing performed

- `node --check` on both `js/message-client.js` and `js/message-local-db.js`
  — passes.
- Standalone functional test of `js/message-local-db.js` in Node using
  `fake-indexeddb` (not shipped — was cleaned up before packaging), covering:
  put/get roundtrip including `displayContent`, per-chat isolation, that
  `getLastMessageId` ignores non-numeric optimistic ids and returns the
  correct numeric max, overwrite-in-place on decrypt resolution (no
  duplicate rows), `deleteMessage`, `deleteChatMessages` (scoped to one
  chat only), conversation put/get/delete, and that the module keeps
  working after a simulated `kyn:accountSwitchWipe` event. All assertions
  passed.

## Not yet verified (flagging explicitly, not implying it's covered)

This was built and unit-tested in a sandboxed container with no real
browser and no access to the live Render backend/socket infrastructure —
every `message-client.js` edit was traced by hand against the surrounding
code (each is a small, localized addition alongside an existing
`bucket.set`/`notify` call, not a new code path), but the full
`openChat()` → cache-hydrate → delta-sync flow has **not** been exercised
end-to-end against a running instance of the app. Please verify live,
specifically:
- Open a chat, reload the page, reopen the same chat — messages should
  appear instantly with no visible "Decrypting…" flash, and the Network
  tab should show a `/sync?sinceId=` call, not a `/messages/:chatId` call.
- Send a message in a brand-new (first-ever) conversation, then reload —
  confirm no duplicate/phantom message appears from the synthetic
  `pending:<receiverId>` cache cleanup path.
- Log out and log back in as a *different* account on the same
  browser/device — confirm the first account's cached messages are gone
  (this exercises the pre-existing `authStorage.js` wipe path against the
  new DB name, not new code, but is worth confirming since nothing
  previously wrote to that DB name).
