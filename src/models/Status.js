'use strict';

const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Status = sequelize.define('Status', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: true },
    type: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'text' },
    mediaUrl: { type: DataTypes.TEXT, allowNull: true },
    mediaPublicId: { type: DataTypes.STRING(500), allowNull: true },
    mediaMime: { type: DataTypes.STRING(120), allowNull: true },
    thumbnailUrl: { type: DataTypes.TEXT, allowNull: true },
    caption: { type: DataTypes.TEXT, allowNull: true },
    background: { type: DataTypes.STRING(120), allowNull: true },
    font: { type: DataTypes.STRING(80), allowNull: true },
    musicUrl: { type: DataTypes.TEXT, allowNull: true },
    linkUrl: { type: DataTypes.TEXT, allowNull: true },
    mentions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    stickers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    topics: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    moodType: { type: DataTypes.STRING(60), allowNull: true },
    category: { type: DataTypes.STRING(60), allowNull: true },
    intent: { type: DataTypes.STRING(60), allowNull: true },
    privacy: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'all_contacts' },
    privacyList: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    durationSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
    publicationTarget: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'status' },
    vibeExpiresAt: { type: DataTypes.DATE, allowNull: true },
    allowReplies: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    allowReactions: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    allowSharing: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reactionCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    replyCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    shareCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    highlight: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    pollOptions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  }, {
    tableName: 'Status',
    modelName: 'Status',
    timestamps: true,
    freezeTableName: true,
    indexes: [
      { fields: ['publicationTarget', 'isActive', 'vibeExpiresAt'] },
      { fields: ['userId', 'isActive', 'expiresAt'] },
      { fields: ['isPublic', 'isActive', 'createdAt'] },
      { fields: ['expiresAt'] },
      { fields: ['moodType'] },
      { fields: ['category'] },
    ],
  });

  Status.associate = function(models) {
    if (models.Users && !Status.associations?.owner) {
      Status.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'owner',
        constraints: false,
      });
    }
  };

  Status.isExpired = status => !status || !status.isActive || new Date(status.expiresAt).getTime() <= Date.now();

  Status.getUserStatuses = async function(userId, options = {}) {
    const where = { userId };
    if (options.activeOnly !== false) {
      where.isActive = true;
      where.expiresAt = { [Op.gt]: new Date() };
    }
    if (options.type) where.type = options.type;
    if (options.moodType) where.moodType = options.moodType;
    return this.findAll({
      where,
      order: [['createdAt', 'ASC']],
      limit: Math.min(Math.max(Number(options.limit) || 100, 1), 200),
      offset: Math.max(Number(options.offset) || 0, 0),
    });
  };

  Status.getFriendsStatuses = async function(userId, friendIds, options = {}) {
    if (!friendIds?.length) return [];
    return this.findAll({
      where: {
        userId: { [Op.in]: friendIds },
        isActive: true,
        expiresAt: { [Op.gt]: new Date() },
      },
      order: [['createdAt', 'ASC']],
      limit: Math.min(Math.max(Number(options.limit) || 200, 1), 300),
      offset: Math.max(Number(options.offset) || 0, 0),
    });
  };

  Status.getStatusStats = async function(userId) {
    const rows = await this.findAll({ where: { userId }, attributes: ['id', 'viewCount', 'reactionCount', 'replyCount', 'shareCount', 'createdAt', 'expiresAt', 'isActive'] });
    return {
      total: rows.length,
      active: rows.filter(r => !this.isExpired(r)).length,
      views: rows.reduce((n, r) => n + Number(r.viewCount || 0), 0),
      reactions: rows.reduce((n, r) => n + Number(r.reactionCount || 0), 0),
      replies: rows.reduce((n, r) => n + Number(r.replyCount || 0), 0),
      shares: rows.reduce((n, r) => n + Number(r.shareCount || 0), 0),
    };
  };

  Status.cleanupExpiredStatuses = async function() {
    const now = new Date();
    return this.destroy({ where: { isActive: true, expiresAt: { [Op.lte]: now }, [Op.or]: [{ publicationTarget: { [Op.notIn]: ['vibe','both'] } }, { vibeExpiresAt: { [Op.is]: null } }, { vibeExpiresAt: { [Op.lte]: now } }] } });
  };

  return Status;
};