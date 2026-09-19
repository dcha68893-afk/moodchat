}));

// Compatibility/default status feed. Older shells request GET /api/status directly.
router.get('/', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  const friends = await Friend().getUserFriends(userId, 'accepted');
  const ids = friends.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
  const statuses = await Status().getFriendsStatuses(userId, ids);
  const visible = [];
  for (const s of statuses) if (await canView(s, userId)) visible.push(await ownerPayload(s));
  const mine = await Status().getUserStatuses(userId, { activeOnly: true });
  return res.json({ success: true, data: [...(await Promise.all(mine.map(ownerPayload))), ...visible] });
}));

// Current user's active statuses.
router.get('/my', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().getUserStatuses(uid(req), { activeOnly: true });
  return res.json({ success: true, data: await Promise.all(statuses.map(async s => ({ ...(await ownerPayload(s)), viewedByMe: true }))) });
}));

// Friend statuses.