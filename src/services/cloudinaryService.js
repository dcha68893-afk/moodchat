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
 * @param {string} options.folder   e.g. 'moodchat/group-avatars'
 * @param {string} options.publicId optional stable public ID
 * @param {number} options.width    resize width
 * @param {number} options.height   resize height
 */
async function uploadToCloudinary(fileData, options = {}) {
  const cld = _load();
  if (!cld) return null;

  const {
    folder   = 'moodchat/uploads',
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
    const upload_stream = cld.uploader.upload_stream(uploadOpts, (error, result) => {
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
 * Square crop, 400×400, stored in moodchat/group-avatars
 */
async function uploadGroupAvatar(fileBuffer, groupId) {
  return uploadToCloudinary(fileBuffer, {
    folder:   'moodchat/group-avatars',
    publicId: `group_${groupId}_avatar`,
    width:    400,
    height:   400,
    crop:     'fill',
    gravity:  'face:auto',
  });
}

/**
 * Upload a user avatar
 */
async function uploadUserAvatar(fileBuffer, userId) {
  return uploadToCloudinary(fileBuffer, {
    folder:   'moodchat/user-avatars',
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

module.exports = {
  uploadToCloudinary,
  uploadGroupAvatar,
  uploadUserAvatar,
  deleteFromCloudinary,
  isConfigured,
};
