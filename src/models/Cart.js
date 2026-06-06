// --- MODEL: Cart.js (Marketplace Cart) ---
// FIX (Forensic Audit P1): Cart model was missing entirely. Cart data was only held
// in-memory on the frontend, lost on page refresh. This model adds server-side
// cart persistence so carts survive sessions and can be shared across devices.
//
// Table: marketplace_carts
// Items are stored as JSONB array to avoid a separate CartItems table.
// Each item: { product_id, seller_id, title, price, quantity, image, variant? }

module.exports = (sequelize, DataTypes) => {
  const Cart = sequelize.define(
    'Cart',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      userId: {
        // FIX: Was UUID but Users.id is INTEGER — must match for FK constraint and queries
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'user_id',
        comment: 'Owner of this cart (one active cart per user)',
      },
      items: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Array of cart items: [{product_id,seller_id,title,price,quantity,image,variant}]',
        validate: {
          isArray(value) {
            if (!Array.isArray(value)) throw new Error('items must be an array');
          },
        },
      },
      currency: {
        type: DataTypes.STRING(10),
        defaultValue: 'KES',
        allowNull: false,
      },
      couponCode: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'coupon_code',
      },
      discountAmount: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0,
        allowNull: false,
        field: 'discount_amount',
        validate: { min: 0 },
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'expires_at',
        comment: 'Cart auto-expires after 30 days of inactivity',
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: true,
        comment: 'Extra data: saved_address, delivery_preference, etc.',
      },
    },
    {
      tableName: 'marketplace_carts',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          unique: true,
          fields: ['user_id'],
          name: 'idx_cart_user_unique',
          comment: 'One active cart per user',
        },
        {
          fields: ['expires_at'],
          name: 'idx_cart_expires',
        },
      ],
    }
  );

  // ── Class methods ────────────────────────────────────────────────────────────

  /**
   * Get or create a cart for a user.
   * @param {string} userId
   * @returns {Promise<Cart>}
   */
  Cart.getOrCreate = async function (userId) {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const [cart] = await this.findOrCreate({
      where: { userId },
      defaults: {
        userId,
        items: [],
        expiresAt: new Date(Date.now() + THIRTY_DAYS),
      },
    });
    // Reset expiry on access
    await cart.update({ expiresAt: new Date(Date.now() + THIRTY_DAYS) });
    return cart;
  };

  /**
   * Add or update an item. If product_id already in cart, increments quantity.
   */
  Cart.prototype.addItem = async function (item) {
    const items = [...(this.items || [])];
    const idx = items.findIndex(
      (i) => i.product_id === item.product_id && i.variant === item.variant
    );
    if (idx >= 0) {
      items[idx] = { ...items[idx], quantity: items[idx].quantity + (item.quantity || 1) };
    } else {
      items.push({
        product_id: item.product_id,
        seller_id: item.seller_id,
        title: item.title || '',
        price: parseFloat(item.price) || 0,
        quantity: item.quantity || 1,
        image: item.image || null,
        variant: item.variant || null,
        added_at: new Date().toISOString(),
      });
    }
    return this.update({ items });
  };

  /**
   * Remove an item by product_id (and optional variant).
   */
  Cart.prototype.removeItem = async function (productId, variant = null) {
    const items = (this.items || []).filter(
      (i) => !(i.product_id === productId && i.variant === variant)
    );
    return this.update({ items });
  };

  /**
   * Update quantity for a specific item.
   */
  Cart.prototype.updateItemQuantity = async function (productId, quantity, variant = null) {
    const items = (this.items || []).map((i) => {
      if (i.product_id === productId && i.variant === variant) {
        return { ...i, quantity: Math.max(1, quantity) };
      }
      return i;
    });
    return this.update({ items });
  };

  /**
   * Clear all items (e.g. after successful checkout).
   */
  Cart.prototype.clear = async function () {
    return this.update({ items: [], couponCode: null, discountAmount: 0 });
  };

  /**
   * Compute subtotal.
   */
  Cart.prototype.getSubtotal = function () {
    return (this.items || []).reduce((sum, i) => sum + (i.price * i.quantity), 0);
  };

  /**
   * Total item count.
   */
  Cart.prototype.getItemCount = function () {
    return (this.items || []).reduce((sum, i) => sum + i.quantity, 0);
  };

  // ── Associations ─────────────────────────────────────────────────────────────
  Cart.associate = function (models) {
    Cart.belongsTo(models.Users || models.User, {
      foreignKey: 'user_id',
      as: 'owner',
    });
  };

  return Cart;
};