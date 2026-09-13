# MoodChat (backend) — Fix Changelog

This zip contains ONLY the files that changed. Copy each file over the
matching path in your existing project (same relative paths as your repo).

## 1. Branding: "Nexopa" → "Necpa"

Replaced every case variant (NEXOPA/Nexopa/nexopa → NECPA/Necpa/necpa)
across the backend — README, .env.example, config, email templates,
Cloudinary folder paths (e.g. `necpa/group-avatars`), package.json name,
Docker/deploy scripts, etc. All 34 changed files are included here.

**Note:** no backend logic was changed for this — it was purely a text
rename, consistent with the same rename applied on the frontend.

## 2, 3, 4 — Admin approval, status module, groups

On inspection, the backend logic for all three of these was **already
correctly fixed in a prior session** and is intact in this codebase:

- Admin promotion (ADMIN_EMAIL/ADMIN_USERNAME → role='admin') in
  `src/routes/auth.js` and `src/services/authService.js`.
- Group member-count computation (`src/services/groupService.js`) — every
  call site (`createGroup`, `getGroupById`, `updateGroup`, `getUserGroups`,
  `searchGroups`) already computes and returns the real live count.
- Sender-key distribution/rotation (`src/routes/groupEncryption.js`,
  `GroupSenderKeyDistribution`/`GroupSenderKeyGeneration` models) —
  already includes a fix for a real race condition in key-generation
  numbering.
- The duplicate/typo'd migration filenames
  (`2026118080600creategroup.js` / `2026118080700creategroupmembers.js`)
  already contain a guard so they don't break your migration batch.

The actual remaining bugs for items 2–4 were all on the **frontend**
(moodfronted) — see that repo's CHANGELOG.md for what was fixed there.

No further backend files needed functional changes this round beyond the
branding rename.
