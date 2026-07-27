// src/services/cloudinaryService.js
// P1 FIX: Group avatar CDN — replaces ephemeral disk storage with Cloudinary
// Falls back to disk storage if CLOUDINARY_URL is not configured
'use strict';

let cloudinary = null;
let streamifier = null;

function _load() {
  if (cloudinary) return cloudinary;
  try {
    cloudinary = require('cloudinary').v2;
    // Configure from CLOUDINARY_URL env var (format: cloudinary://api_key:api_secret@cloud_name)
    if (process.env.CLOUDINARY_URL) {
      cloudinary.config({ secure: true });
    } else if (process.env.CLOUDINARY_CLOUD_NAME) {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure:     true,
      });
    } else {
      cloudinary = null;
      return null;
    }
    return cloudinary;
  } catch (_) {
    cloudinary = null;
    return null;
  }
}

function _loadStreamifier() {
  if (streamifier) return streamifier;
  try { streamifier = require('streamifier'); return streamifier; } catch (_) { return null; }
}

/**
 * Upload a file buffer or stream to Cloudinary.
 * Returns { url, publicId, width, height, format, bytes }
 * Falls back to null if Cloudinary is not configured.
 *
 * @param {Buffer|ReadableStream} fileData
 * @param {object} options
 * @param {string} options.folder   e.g. 'nexopa/group-avatars'
 * @param {string} options.publicId optional stable public ID
 * @param {number} options.width    resize width
 * @param {number} options.height   resize height
 */
async function uploadToCloudinary(fileData, options = {}) {
  const cld = _load();
  if (!cld) return null;

  const {
    folder   = 'nexopa/uploads',
    publicId = null,
    width    = null,
    height   = null,
    crop     = 'fill',
    gravity  = 'face:auto',
  } = options;

  const uploadOpts = {
    folder,
    resource_type: 'auto',
    overwrite: true,
    ...(publicId && { public_id: publicId }),
    ...(width && height && {
      transformation: [{ width, height, crop, gravity }],
    }),
  };

  return new Promise((resolve, reject) => {
    // FIX (fast-fail-on-bad-config): an invalid cloud_name still makes a
    // real network round-trip to Cloudinary before it comes back with 401 —
    // on a single free-tier dyno that's also serving every WebSocket
    // connection, a pile of these slow failing uploads (e.g. from repeated
    // save-button clicks) can compete for the same limited resources and
    // has been observed correlating with socket reconnect storms. Bound
    // every upload attempt to 15s so a bad config (or a slow Cloudinary
    // response) can never hold a request open indefinitely.
    const uploadTimeout = setTimeout(() => {
      reject(new Error('Cloudinary upload timed out after 15s — check CLOUDINARY_CLOUD_NAME/CLOUDINARY_URL on Render'));
    }, 15000);

    const upload_stream = cld.uploader.upload_stream(uploadOpts, (error, result) => {
      clearTimeout(uploadTimeout);
      if (error) return reject(error);
      resolve({
        url:      result.secure_url,
        publicId: result.public_id,
        width:    result.width,
        height:   result.height,
        format:   result.format,
        bytes:    result.bytes,
      });
    });

    // Handle both Buffer and Stream
    if (Buffer.isBuffer(fileData)) {
      const sfy = _loadStreamifier();
      if (sfy) {
        sfy.createReadStream(fileData).pipe(upload_stream);
      } else {
        // Manual buffer write
        const { Readable } = require('stream');
        Readable.from(fileData).pipe(upload_stream);
      }
    } else {
      // Already a stream
      fileData.pipe(upload_stream);
    }
  });
}

/**
 * Upload a group avatar specifically.
 * Square crop, 400×400, stored in nexopa/group-avatars
 */
async function uploadGroupAvatar(fileBuffer, groupId) {
  return uploadToCloudinary(fileBuffer, {
    folder:   'nexopa/group-avatars',
    publicId: `group_${groupId}_avatar`,
    width:    400,
    height:   400,
    crop:     'fill',
    gravity:  'face:auto',
  });
}

/**
 * Upload a group cover photo (banner). Wide crop, 1600×500, stored in
 * nexopa/group-covers.
 */
async function uploadGroupCover(fileBuffer, groupId) {
  return uploadToCloudinary(fileBuffer, {
    folder:   'nexopa/group-covers',
    publicId: `group_${groupId}_cover`,
    width:    1600,
    height:   500,
    crop:     'fill',
  });
}

/**
 * Upload a user avatar
 */
async function uploadUserAvatar(fileBuffer, userId) {
  return uploadToCloudinary(fileBuffer, {
    folder:   'nexopa/user-avatars',
    publicId: `user_${userId}_avatar`,
    width:    400,
    height:   400,
    crop:     'fill',
    gravity:  'face:auto',
  });
}

/**
 * Delete a file from Cloudinary by public ID.
 */
async function deleteFromCloudinary(publicId) {
  const cld = _load();
  if (!cld || !publicId) return false;
  try {
    await cld.uploader.destroy(publicId);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Returns true if Cloudinary is configured and available.
 */
function isConfigured() {
  return Boolean(
    process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
  );
}

// FIX-DIAG (avatar/cover-photo-upload-401): isConfigured() only checks that
// the env vars are *present*, not that they're *valid* — a typo'd or
// nonexistent cloud_name (e.g. CLOUDINARY_CLOUD_NAME=nexora, which is not a
// real Cloudinary account) passes isConfigured() fine and then fails with a
// 401 "Invalid cloud_name" on every real upload attempt, buried in
// per-request error logs with no obvious link back to the env var. This
// pings Cloudinary once at boot so the misconfiguration shows up as one
// unmissable line in the startup log instead of a stream of upload 401s.
async function validateConfig() {
  const cld = _load();
  if (!cld) {
    console.warn('[Cloudinary] \u23ed\ufe0f  Not configured \u2014 CLOUDINARY_URL / CLOUDINARY_CLOUD_NAME not set. Photo uploads will fail with "not configured" errors until this is set on Render.');
    return { ok: false, reason: 'not_configured' };
  }
  try {
    await cld.api.ping();
    console.log(`[Cloudinary] \u2705 Config OK \u2014 cloud_name="${cld.config().cloud_name}" reachable`);
    return { ok: true };
  } catch (e) {
    console.error(`[Cloudinary] \u274c MISCONFIGURED \u2014 cloud_name="${cld.config().cloud_name}" was rejected by Cloudinary (${e.message}). Avatar/cover photo uploads will fail for every user until CLOUDINARY_CLOUD_NAME/CLOUDINARY_URL is corrected in Render \u2192 Environment. Get the correct value from your Cloudinary dashboard (Settings \u2192 API Keys \u2192 "Cloud name").`);
    return { ok: false, reason: 'invalid_credentials', error: e.message };
  }
}

module.exports = {
  uploadToCloudinary,
  uploadGroupAvatar,
  uploadGroupCover,
  uploadUserAvatar,
  deleteFromCloudinary,
  isConfigured,
  validateConfig,
};
