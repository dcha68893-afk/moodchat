// --- MODEL: Tool.js (Marketplace Listings) ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Tool = sequelize.define(
    'Tool',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      sellerId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'seller_id',
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          len: [3, 255],
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      category: {
        type: DataTypes.STRING(100),
        allowNull: false,
        defaultValue: 'other',
        validate: {
          isIn: [['electronics', 'furniture', 'clothing', 'books', 'services', 'digital', 'premium', 'other']],
        },
      },
      type: {
        type: DataTypes.ENUM('service', 'digital', 'premium', 'physical'),
        allowNull: false,
        defaultValue: 'physical',
      },
      images: {
        type: DataTypes.ARRAY(DataTypes.TEXT),
        defaultValue: [],
      },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
      },
      available: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'available',
      },
      isPremium: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_premium',
      },
      isSpotlight: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_spotlight',
      },
      isFeatured: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_featured',
      },
      isBoosted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_boosted',
      },
      boostExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'boost_expires_at',
      },
      views: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        validate: { min: 0 },
      },
      savedBy: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        defaultValue: [],
        field: 'saved_by',
      },
      purchasedBy: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        defaultValue: [],
        field: 'purchased_by',
      },
      rating: {
        type: DataTypes.DECIMAL(3, 2),
        defaultValue: 0,
        validate: { min: 0, max: 5 },
      },
      ratingCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'rating_count',
        validate: { min: 0 },
      },
      status: {
        type: DataTypes.ENUM('active', 'inactive', 'sold', 'deleted'),
        defaultValue: 'active',
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(10),
        defaultValue: 'USD',
      },
      stock: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 0 },
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'tools',
      modelName: 'Tool',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        { fields: ['seller_id'] },
        { fields: ['category'] },
        { fields: ['type'] },
        { fields: ['status'] },
        { fields: ['is_premium'] },
        { fields: ['is_spotlight'] },
        { fields: ['is_featured'] },
        { fields: ['available'] },
        { fields: ['created_at'] },
      ],
    }
  );

  // ─── Instance methods ───────────────────────────────────────────

  Tool.prototype.incrementViews = async function () {
    this.views = (this.views || 0) + 1;
    return await this.save();
  };

  Tool.prototype.toggleSave = async function (userId) {
    const saved = this.savedBy || [];
    const idx = saved.indexOf(userId);
    if (idx === -1) {
      this.savedBy = [...saved, userId];
    } else {
      this.savedBy = saved.filter((id) => id !== userId);
    }
    return await this.save();
  };

  Tool.prototype.isSavedBy = function (userId) {
    return (this.savedBy || []).includes(userId);
  };

  Tool.prototype.addRating = async function (newRating) {
    const total = (this.rating || 0) * (this.ratingCount || 0) + newRating;
    this.ratingCount = (this.ratingCount || 0) + 1;
    this.rating = total / this.ratingCount;
    return await this.save();
  };

  Tool.prototype.markAsSold = async function () {
    this.status = 'sold';
    this.available = false;
    return await this.save();
  };

  // ─── Static methods ─────────────────────────────────────────────

  /**
   * Get all active listings with optional filters.
   * Used by GET /api/marketplace/listings
   */
  Tool.getListings = async function ({ page = 1, limit = 20, category, type, search, minPrice, maxPrice, sort = 'newest' } = {}) {
    const where = { status: 'active', available: true };
    if (category) where.category = category;
    if (type) where.type = type;
    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price[Op.gte] = minPrice;
      if (maxPrice !== undefined) where.price[Op.lte] = maxPrice;
    }
    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const orderMap = {
      newest:     [['createdAt', 'DESC']],
      oldest:     [['createdAt', 'ASC']],
      price_asc:  [['price', 'ASC']],
      price_desc: [['price', 'DESC']],
      popular:    [['views', 'DESC']],
      rating:     [['rating', 'DESC']],
    };
    const order = orderMap[sort] || orderMap.newest;
    const offset = (page - 1) * limit;

    // FIX: Gracefully skip seller include if association is not defined
    const includeOpts = (Tool.associations && Tool.associations.seller)
      ? [{ association: Tool.associations.seller, attributes: ['id', 'username', 'avatar', 'displayName'], required: false }]
      : [];

    const { count, rows } = await this.findAndCountAll({
      where,
      order,
      limit,
      offset,
      include: includeOpts,
    });

    // FIX: Normalize rows so frontend gets consistent userId/user fields
    const listings = rows.map(row => {
      const r = row.toJSON ? row.toJSON() : { ...row };
      r.userId = r.sellerId;
      if (!r.user && r.seller) {
        r.user = {
          id: r.seller.id,
          displayName: r.seller.displayName || r.seller.username || 'User',
          photoURL: r.seller.avatar || ''
        };
      } else if (!r.user) {
        r.user = { id: r.sellerId, displayName: 'User', photoURL: '' };
      }
      return r;
    });

    return { listings, total: count, page, limit, totalPages: Math.ceil(count / limit) };
  };

  /**
   * Get spotlight / featured listings.
   * Used by GET /api/marketplace/spotlight
   */
  Tool.getSpotlight = async function (limit = 10) {
    const includeOpts = (Tool.associations && Tool.associations.seller)
      ? [{ association: Tool.associations.seller, attributes: ['id', 'username', 'avatar', 'displayName'], required: false }]
      : [];
    const rows = await this.findAll({
      where: { status: 'active', available: true, isSpotlight: true },
      order: [['createdAt', 'DESC']],
      limit,
      include: includeOpts,
    });
    return rows.map(row => {
      const r = row.toJSON ? row.toJSON() : { ...row };
      r.userId = r.sellerId;
      if (!r.user && r.seller) {
        r.user = { id: r.seller.id, displayName: r.seller.displayName || r.seller.username || 'User', photoURL: r.seller.avatar || '' };
      } else if (!r.user) {
        r.user = { id: r.sellerId, displayName: 'User', photoURL: '' };
      }
      return r;
    });
  };

  /**
   * Get premium listings.
   * Used by GET /api/marketplace/listings/premium
   */
  Tool.getPremiumListings = async function (limit = 20) {
    const includeOpts = (Tool.associations && Tool.associations.seller)
      ? [{ association: Tool.associations.seller, attributes: ['id', 'username', 'avatar', 'displayName'], required: false }]
      : [];
    const rows = await this.findAll({
      where: { status: 'active', available: true, isPremium: true },
      order: [['createdAt', 'DESC']],
      limit,
      include: includeOpts,
    });
    return rows.map(row => {
      const r = row.toJSON ? row.toJSON() : { ...row };
      r.userId = r.sellerId;
      if (!r.user && r.seller) {
        r.user = { id: r.seller.id, displayName: r.seller.displayName || r.seller.username || 'User', photoURL: r.seller.avatar || '' };
      } else if (!r.user) {
        r.user = { id: r.sellerId, displayName: 'User', photoURL: '' };
      }
      return r;
    });
  };

  /**
   * Get seller's own listings.
   * Used by GET /api/marketplace/listings/mine
   */
  Tool.getMyListings = async function (sellerId) {
    return await this.findAll({
      where: { sellerId, status: { [Op.ne]: 'deleted' } },
      order: [['createdAt', 'DESC']],
    });
  };

  /**
   * Get saved listings for a user.
   * Used by GET /api/marketplace/listings/saved
   */
  Tool.getSavedListings = async function (userId) {
    const includeOpts = (Tool.associations && Tool.associations.seller)
      ? [{ association: Tool.associations.seller, attributes: ['id', 'username', 'avatar', 'displayName'], required: false }]
      : [];
    const rows = await this.findAll({
      where: {
        status: 'active',
        savedBy: { [Op.contains]: [userId] },
      },
      order: [['createdAt', 'DESC']],
      include: includeOpts,
    });
    return rows.map(row => {
      const r = row.toJSON ? row.toJSON() : { ...row };
      r.userId = r.sellerId;
      if (!r.user && r.seller) {
        r.user = { id: r.seller.id, displayName: r.seller.displayName || r.seller.username || 'User', photoURL: r.seller.avatar || '' };
      } else if (!r.user) {
        r.user = { id: r.sellerId, displayName: 'User', photoURL: '' };
      }
      return r;
    });
  };

  /**
   * Leaderboard: top sellers by sales/views.
   * Used by GET /api/marketplace/leaderboard
   */
  Tool.getLeaderboard = async function (limit = 20) {
    const { QueryTypes } = require('sequelize');
    try {
      // Raw query to aggregate by seller
      const results = await sequelize.query(
        `SELECT
          seller_id,
          COUNT(*) AS listing_count,
          SUM(views) AS total_views,
          AVG(rating) AS avg_rating,
          SUM(array_length(purchased_by, 1)) AS total_sales
        FROM tools
        WHERE status != 'deleted'
        GROUP BY seller_id
        ORDER BY total_sales DESC NULLS LAST, total_views DESC
        LIMIT :limit`,
        { replacements: { limit }, type: QueryTypes.SELECT }
      );
      return results;
    } catch (err) {
      // Fallback: return top-viewed listings grouped by seller
      return await this.findAll({
        where: { status: { [Op.ne]: 'deleted' } },
        order: [['views', 'DESC']],
        limit,
      });
    }
  };

  // ─── Associations ────────────────────────────────────────────────

  Tool.associate = function (models) {
    if (models.Users) {
      Tool.belongsTo(models.Users, {
        foreignKey: 'sellerId',
        as: 'seller',
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Tool;
};