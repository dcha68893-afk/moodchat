// src/services/cloudinaryService.js
// Central Cloudinary adapter for persistent media uploads.
'use strict';

let cloudinary = null;
let streamifier = null;

function readCredentials() {
  const url = String(process.env.CLOUDINARY_URL || '').trim();
  if (url) {
    // CLOUDINARY_URL must contain api_key, api_secret and cloud_name.
    // Do not let the Cloudinary SDK receive a partial URL: it otherwise throws
    // low-level errors such as "Must supply api_key" to the user-facing upload route.
    const match = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)$/);
    if (!match) return null;
    return { api_key: match[1], api_secret: match[2], cloud_name: match[3] };
  }
  const cloud_name = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const api_key = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const api_secret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloud_name || !api_key || !api_secret) return null;
  return { cloud_name, api_key, api_secret };
}

function _load() {
  if (cloudinary) return cloudinary;
  const credentials = readCredentials();
  if (!credentials) return null;
  try {
    const client = require('cloudinary').v2;
    client.config({ ...credentials, secure: true });
    cloudinary = client;
    return cloudinary;
  } catch (error) {
    cloudinary = null;
    console.error('[Cloudinary] SDK/configuration unavailable:', error.message);
    return null;
  }
}

function _loadStreamifier() {
  if (streamifier) return streamifier;
  try { streamifier = require('streamifier'); return streamifier; } catch (_) { return null; }
}

async function uploadToCloudinary(fileData, options = {}) {
  const cld = _load();
  if (!cld) return null;

  const {
    folder = 'nexopa/uploads',
    publicId = null,
    width = null,
    height = null,
    crop = 'fill',
    gravity = 'face:auto',
  } = options;

  const uploadOpts = {
    folder,
    resource_type: 'auto',
    overwrite: true,
    ...(publicId && { public_id: publicId }),
    ...(width && height && { transformation: [{ width, height, crop, gravity }] }),
  };

  return new Promise((resolve, reject) => {
    const uploadTimeout = setTimeout(() => {
      reject(new Error('Cloudinary upload timed out; check the server media configuration.'));
    }, 15000);

    let uploadStream;
    try {
      uploadStream = cld.uploader.upload_stream(uploadOpts, (error, result) => {
        clearTimeout(uploadTimeout);
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        });
      });
    } catch (error) {
      clearTimeout(uploadTimeout);
      reject(error);
      return;
    }

    if (Buffer.isBuffer(fileData)) {
      const sfy = _loadStreamifier();
      if (sfy) sfy.createReadStream(fileData).pipe(uploadStream);
      else {
        const { Readable } = require('stream');
        Readable.from(fileData).pipe(uploadStream);
      }
    } else if (fileData && typeof fileData.pipe === 'function') {
      fileData.pipe(uploadStream);
    } else {
      clearTimeout(uploadTimeout);
      reject(new Error('Invalid upload data'));
    }
  });
}

async function uploadGroupAvatar(fileBuffer, groupId) {
  return uploadToCloudinary(fileBuffer, { folder: 'nexopa/group-avatars', publicId: `group_${groupId}_avatar`, width: 400, height: 400, crop: 'fill', gravity: 'face:auto' });
}

async function uploadGroupCover(fileBuffer, groupId) {
  return uploadToCloudinary(fileBuffer, { folder: 'nexopa/group-covers', publicId: `group_${groupId}_cover`, width: 1600, height: 500, crop: 'fill' });
}

async function uploadUserAvatar(fileBuffer, userId) {
  return uploadToCloudinary(fileBuffer, { folder: 'nexopa/user-avatars', publicId: `user_${userId}_avatar`, width: 400, height: 400, crop: 'fill', gravity: 'face:auto' });
}

async function deleteFromCloudinary(publicId) {
  const cld = _load();
  if (!cld || !publicId) return false;
  try { await cld.uploader.destroy(publicId); return true; } catch (_) { return false; }
}

function isConfigured() { return !!readCredentials(); }

async function validateConfig() {
  if (!readCredentials()) {
    console.warn('[Cloudinary] Not configured — media uploads will use the server disk fallback. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET on Render for persistent CDN storage.');
    return { ok: false, reason: 'not_configured' };
  }
  const cld = _load();
  if (!cld) return { ok: false, reason: 'invalid_configuration' };
  try {
    await cld.api.ping();
    console.log(`[Cloudinary] Config OK — cloud_name="${cld.config().cloud_name}" reachable`);
    return { ok: true };
  } catch (error) {
    console.error(`[Cloudinary] Configuration rejected by provider: ${error.message}`);
    return { ok: false, reason: 'invalid_credentials', error: error.message };
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
