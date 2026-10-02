'use strict';

/**
 * Ephemeral server-retention layer.
 *
 * The server is a delivery mailbox, not the permanent message-history store.
 * Once a client has durably accepted a message locally, the ciphertext and
 * delivery bookkeeping are removed from PostgreSQL. The device/local encrypted
 * store (and optional encrypted backup) becomes the history.
 *
 * This is intentionally conservative: deletion is only performed after an
 * explicit delivery acknowledgement or an expiry condition. Realtime delivery
 * itself never deletes anything.
 */
const fs = require('fs');
const path = require('path');

function storageProviderType(type) {
  return ['video', 'audio'].includes(String(type || '').toLowerCase()) ? 'video' : 'image';
}

async function deleteExternalAsset(asset = {}) {
  const provider = String(asset.storageProvider || '').toLowerCase();
  const value = String(asset.storagePath || asset.publicId || asset.url || '').trim();
  if (!value) return;

  try {
    if (provider === 'cloudinary' || /res\.cloudinary\.com/i.test(value)) {
      const cloudinary = require('cloudinary').v2;
      if (process.env.CLOUDINARY_URL) cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
      else if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
        });
      } else return;
      let publicId = value;
      if (/^https?:\/\//i.test(publicId)) {
        const marker = publicId.split('/upload/')[1];
        if (!marker) return;
        publicId = marker.replace(/^v\d+\//, '').replace(/\.[a-z0-9]+$/i, '');
      }
      await cloudinary.uploader.destroy(publicId, {
        resource_type: storageProviderType(asset.type),
        invalidate: true,
      }).catch(() => {});
      return;
    }

    if (provider === 's3') {
      const bucket = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
      if (!bucket) return;
      const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const client = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });
      const key = value.replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
      return;
    }

    // Local uploads: accept either an absolute filesystem path or a URL/path
    // rooted under the application's uploads directory. Never delete an
    // arbitrary path supplied by a database row.
    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    let filePath = value;
    if (/^https?:\/\//i.test(filePath)) {
      try { filePath = new URL(filePath).pathname; } catch (_) { return; }
    }
    filePath = path.resolve(filePath.startsWith('/') ? path.join(process.cwd(), filePath) : filePath);
    if (filePath.startsWith(uploadsRoot + path.sep) && fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  } catch (_) {
    // Storage cleanup is best-effort. Database retention must never be blocked
    // by a provider outage.
  }
}

async function collectMessageMedia(db, messageId) {
  const Media = db.models?.Media || db.Media;
  if (!Media) return [];
  const rows = await Media.findAll({ where: { messageId }, raw: true }).catch(() => []);
  return rows.map(m => ({
    ...m,
    storageProvider: m.storageProvider || m.storage_provider,
    storagePath: m.storagePath || m.storage_path,
    thumbnailUrl: m.thumbnailUrl || m.thumbnail_url,
  }));
}

async function deleteMessageFromServer(db, messageId, reason = 'delivered') {
  const sequelize = db.sequelize;
  const [message] = await sequelize.query(
    `SELECT id,"chatId","senderId","receiverId","createdAt"
       FROM "Messages" WHERE id=:messageId AND "isDeleted"=false LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!message) return { deleted: false, message: null, media: [] };

  const media = await collectMessageMedia(sequelize, messageId);

  // Remove short-lived bookkeeping first so a hard delete cannot be blocked
  // by a legacy foreign key. These rows have no value after the message leaves
  // the server mailbox.
  await sequelize.transaction(async (transaction) => {
    const replacements = { messageId };
    const qi = { replacements, transaction };
    for (const sql of [
      'DELETE FROM message_delivery_logs WHERE "messageId"=:messageId',
      'DELETE FROM "ReadReceipts" WHERE "messageId"=:messageId',
      'DELETE FROM starred_messages WHERE "messageId"=:messageId',
      'DELETE FROM pinned_messages WHERE "messageId"=:messageId',
      'DELETE FROM message_deletions WHERE "messageId"=:messageId',
      'DELETE FROM "Messages" WHERE id=:messageId',
    ]) {
      await sequelize.query(sql, qi).catch(async (err) => {
        // Optional/legacy tables may not exist in every deployed schema.
        if (!/does not exist|relation .* does not exist/i.test(String(err.message || ''))) throw err;
      });
    }
  });

  // Delete the actual attachment only after the DB record is gone. If a
  // provider is temporarily unavailable, the next orphan-media cleanup can
  // retry using the captured storage information.
  for (const m of media) {
    await deleteExternalAsset(m);
    if (m.thumbnailUrl && m.thumbnailUrl !== m.url) {
      await deleteExternalAsset({ ...m, url: m.thumbnailUrl, storagePath: m.thumbnailUrl });
    }
  }

  return { deleted: true, message, media, reason };
}

async function cleanupDeliveredMessages(db, limit = 200) {
  const rows = await db.sequelize.query(
    `SELECT id FROM "Messages" WHERE "deliveredAt" IS NOT NULL AND "isDeleted"=false ORDER BY "deliveredAt" ASC LIMIT :limit`,
    { replacements: { limit }, type: db.sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  let deleted = 0;
  for (const row of rows) {
    const result = await deleteMessageFromServer(db, row.id, 'delivered_retry').catch(() => null);
    if (result?.deleted) deleted++;
  }
  return deleted;
}

async function cleanupExpiredMessages(db, limit = 200) {
  const rows = await db.sequelize.query(
    `SELECT id FROM "Messages"
       WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= NOW()
         AND "isDeleted"=false
       ORDER BY "expiresAt" ASC LIMIT :limit`,
    { replacements: { limit }, type: db.sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  let deleted = 0;
  for (const row of rows) {
    const result = await deleteMessageFromServer(db, row.id, 'expired').catch(() => null);
    if (result?.deleted) deleted++;
  }
  return deleted;
}

async function cleanupExpiredStatuses(db, limit = 100) {
  const q = db.sequelize;
  const rows = await q.query(
    `SELECT id,"mediaUrl","mediaPublicId","type"
       FROM "Status"
       WHERE "isActive"=true
         AND "expiresAt" IS NOT NULL AND "expiresAt" <= NOW()
         AND (("publicationTarget" NOT IN ('vibe','both'))
              OR "vibeExpiresAt" IS NULL OR "vibeExpiresAt" <= NOW())
       ORDER BY "expiresAt" ASC LIMIT :limit`,
    { replacements: { limit }, type: q.QueryTypes.SELECT }
  ).catch(() => []);

  let deleted = 0;
  for (const row of rows) {
    const deletedRow = await q.transaction(async (transaction) => {
      const qi = { replacements: { id: row.id }, transaction };
      for (const table of ['StatusViews','StatusReactions','StatusReplies','VibeWatchStats','StatusPollVotes']) {
        await q.query(`DELETE FROM "${table}" WHERE "statusId"=:id`, qi).catch(async (err) => {
          if (!/does not exist|relation .* does not exist/i.test(String(err.message || ''))) throw err;
        });
      }
      await q.query('DELETE FROM "Status" WHERE id=:id', qi);
      return true;
    }).catch(() => false);
    if (!deletedRow) continue;

    await deleteExternalAsset({
      storageProvider: /cloudinary/i.test(String(row.mediaUrl || '')) ? 'cloudinary' : 'local',
      publicId: row.mediaPublicId,
      url: row.mediaUrl,
      type: row.type,
    });
    deleted++;
  }
  return deleted;
}

async function cleanupTransportTables(db) {
  const q = db.sequelize;
  let count = 0;
  for (const [table, age] of [
    ['TypingIndicators', '10 minutes'],
    ['message_delivery_logs', '7 days'],
  ]) {
    const quoted = table === 'message_delivery_logs' ? table : `"${table}"`;
    const result = await q.query(
      `DELETE FROM ${quoted} WHERE "createdAt" < NOW() - INTERVAL '${age}'`,
      { type: q.QueryTypes.DELETE }
    ).catch(() => null);
    if (Array.isArray(result)) count += Number(result[1] || 0);
  }
  return count;
}

async function run(db) {
  const delivered = await cleanupDeliveredMessages(db);
  const messages = await cleanupExpiredMessages(db);
  const statuses = await cleanupExpiredStatuses(db);
  const transport = await cleanupTransportTables(db);
  return { delivered, messages, statuses, transport };
}

module.exports = {
  deleteMessageFromServer,
  cleanupDeliveredMessages,
  cleanupExpiredMessages,
  cleanupExpiredStatuses,
  cleanupTransportTables,
  run,
};
