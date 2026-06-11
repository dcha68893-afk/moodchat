// src/services/contentFilter.js
// P2 FIX: Content filtering — word blocklist + anti-flood rate limiting
'use strict';

// In-memory rate limiter: userId:groupId → timestamps[]
const _messageTimes = new Map();
const FLOOD_WINDOW_MS = 30_000;  // 30 seconds
const FLOOD_MAX_MSGS  = 10;       // max messages in window
const FLOOD_MUTE_SECS = 60;       // auto-mute duration

/**
 * Check if message content contains any blocked word (case-insensitive).
 * @param {string} content
 * @param {string[]} blockedWords
 * @returns {{ blocked: boolean, word?: string }}
 */
function checkBlockedWords(content, blockedWords = []) {
  if (!content || !blockedWords.length) return { blocked: false };
  const lower = content.toLowerCase();
  for (const word of blockedWords) {
    if (!word) continue;
    const pattern = new RegExp(`\\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (pattern.test(lower)) return { blocked: true, word };
  }
  return { blocked: false };
}

/**
 * Track message send for flood detection.
 * @param {number|string} userId
 * @param {number|string} groupId
 * @returns {{ flooded: boolean }}  true = user is flooding
 */
function trackAndCheckFlood(userId, groupId) {
  const key = `${userId}:${groupId}`;
  const now = Date.now();
  let times = _messageTimes.get(key) || [];
  // Prune old entries
  times = times.filter(t => now - t < FLOOD_WINDOW_MS);
  times.push(now);
  _messageTimes.set(key, times);
  if (times.length > FLOOD_MAX_MSGS) {
    // Clear so next window starts fresh
    _messageTimes.delete(key);
    return { flooded: true };
  }
  return { flooded: false };
}

/**
 * Clear flood tracking for a user (called on mute/leave).
 */
function clearFloodTracking(userId, groupId) {
  _messageTimes.delete(`${userId}:${groupId}`);
}

module.exports = { checkBlockedWords, trackAndCheckFlood, clearFloodTracking, FLOOD_MUTE_SECS };
