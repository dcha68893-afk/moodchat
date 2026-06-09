/**
 * marketplace.controller.js — COMPLETE MARKETPLACE API CONTROLLER
 * ═══════════════════════════════════════════════════════════════════
 * Implements ALL endpoints needed by marketplace-ecommerce.js
 * Works with existing Tool, Order, Review Sequelize models.
 * Routes prefix: /api/marketplace  (or /api/tools/marketplace)
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

const { Op } = require('sequelize');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');

// ─── Ensure marketplace uploads directory exists ──────────────────────────────
const MARKETPLACE_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'marketplace');
try { fs.mkdirSync(MARKETPLACE_UPLOAD_DIR, { recursive: true }); } catch(_) {}

// ─── Multer storage for marketplace images ────────────────────────────────────
const _marketplaceStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MARKETPLACE_UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `product-${Date.now()}-${Math.round(Math.random()*1e6)}${ext}`);
    }
});
const _marketplaceUpload = multer({
    storage: _marketplaceStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (/^image\//i.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files are allowed'), false);
    }
}).single('image');

// ─── Error helpers ────────────────────────────────────────────────────────────
let AppError;
try { AppError = require('../middleware/errorHandler').AppError; }
catch (_) { AppError = class extends Error { constructor(m, c=400) { super(m); this.statusCode=c; this.status='fail'; } }; }

let logger;
try { logger = require('../utils/logger'); }
catch (_) { logger = { error: console.error, info: console.info, warn: console.warn }; }

const ok  = (res, data, msg='OK', code=200) => res.status(code).json({ success: true, message: msg, data });
const err = (next, e, label) => { logger.error(`[Marketplace] ${label}:`, e.message||e); next(e); };

// ─── Model loader (works whether db is passed by ref or require) ──────────────
let _db = null;
function getDb() {
    if (_db) return _db;
    try { _db = require('../models'); } catch (_) {}
    if (!_db) try { _db = require('../models'); } catch (_) {}
    return _db || {};
}
const Model = {
    get Tool()   { return getDb().Tool   || getDb().Listing   || null; },
    get Order()  { return getDb().Order  || null; },
    get Review() { return getDb().Review || null; },
    get User()   { return getDb().Users  || getDb().User || null; },
    // FIX (Forensic Audit P1): Cart model now exists — resolves to the Cart Sequelize model
    get Cart()   { return getDb().Cart   || null; },
};

// ─── Sequelize instance ───────────────────────────────────────────────────────
function getSequelize() {
    const db = getDb();
    return db.sequelize || db.Sequelize || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTS (Tools table)
// ══════════════════════════════════════════════════════════════════════════════

class MarketplaceController {

    // ── GET /api/marketplace/products ─────────────────────────────────────────
    async getProducts(req, res, next) {
        try {
            const { page=1, limit=40, category, type, search, sort='newest',
                    seller_id, min_price, max_price, featured, available='true' } = req.query;

            const T = Model.Tool;
            if (!T) {
                return ok(res, { products: [], total: 0, page: 1, totalPages: 0 }, 'No products');
            }

            const where = {};
            if (available !== 'false') {
                where.available = true;
                where.status = { [Op.in]: ['active'] };
                // P1 FIX: Only return approved products in public listing
                where.approvalStatus = 'approved';
            }
            if (category)  where.category  = category;
            if (type)      where.type      = type;
            if (seller_id) where.sellerId  = seller_id;
            if (featured === 'true') where.isFeatured = true;
            if (min_price !== undefined || max_price !== undefined) {
                where.price = {};
                if (min_price) where.price[Op.gte] = parseFloat(min_price);
                if (max_price) where.price[Op.lte] = parseFloat(max_price);
            }
            if (search) {
                // P2 FIX: Try PostgreSQL full-text search first (uses GIN index = fast at scale).
                // Falls back to iLike if the search_vector column doesn't exist yet.
                const seq = getSequelize();
                let useFTS = false;
                if (seq) {
                    try {
                        await seq.query(`SELECT 1 FROM information_schema.columns
                            WHERE table_name='tools' AND column_name='search_vector' LIMIT 1`);
                        useFTS = true;
                    } catch(_) {}
                }
                if (useFTS) {
                    where[Op.and] = where[Op.and] || [];
                    where[Op.and].push(
                        seq.literal(`search_vector @@ plainto_tsquery('english', ${seq.escape(search)})`)
                    );
                } else {
                    // iLike fallback (works without GIN index, slower on large tables)
                    where[Op.or] = [
                        { title:       { [Op.iLike]: `%${search}%` } },
                        { description: { [Op.iLike]: `%${search}%` } },
                    ];
                }
            }

            const orderMap = {
                newest:     [['createdAt', 'DESC']],
                oldest:     [['createdAt', 'ASC']],
                price_low:  [['price', 'ASC']],
                price_high: [['price', 'DESC']],
                popular:    [['views', 'DESC']],
                rating:     [['rating', 'DESC']],
            };
            const orderBy = orderMap[sort] || orderMap.newest;
            const offset   = (parseInt(page)-1) * parseInt(limit);

            const includeOpts = _sellerInclude(T);
            const { count, rows } = await T.findAndCountAll({
                where, order: orderBy, limit: parseInt(limit), offset,
                include: includeOpts,
            });

            const products = rows.map(r => _formatProduct(r));
            return ok(res, { products, total: count, page: parseInt(page), totalPages: Math.ceil(count/parseInt(limit)) }, 'Products fetched');
        } catch(e) { err(next, e, 'getProducts'); }
    }

    // ── GET /api/marketplace/products/:id ─────────────────────────────────────
    async getProductById(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return next(new AppError('Product not found', 404));

            const product = await T.findOne({
                where: { id: req.params.id, status: { [Op.ne]: 'deleted' } },
                include: [..._sellerInclude(T), ..._reviewsInclude(T)],
            });
            if (!product) return next(new AppError('Product not found', 404));

            // Increment views (non-blocking)
            product.increment('views').catch(() => {});

            return ok(res, { product: _formatProduct(product) }, 'Product found');
        } catch(e) { err(next, e, 'getProductById'); }
    }

    // ── POST /api/marketplace/products ────────────────────────────────────────
    async createProduct(req, res, next) {
        try {
            const T = Model.Tool;
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));

            const {
                title, description, price=0, category='other', type='physical',
                images=[], tags=[], stock, condition, brand, delivery_fee,
                location, available=true, metadata={}
            } = req.body;

            if (!title?.trim()) return next(new AppError('Title is required', 400));
            if (title.trim().length < 3) return next(new AppError('Title must be at least 3 characters', 400));

            const product = await T.create({
                sellerId:    userId,
                title:       title.trim().substring(0, 255),
                description: (description||'').trim().substring(0, 10000),
                price:       parseFloat(price) || 0,
                category:    _sanitizeCategory(category),
                type:        _sanitizeType(type),
                images:      Array.isArray(images) ? images.slice(0, 10) : [],
                tags:        Array.isArray(tags)   ? tags.slice(0, 20)  : [],
                stock:       stock != null ? parseInt(stock) : null,
                available:   false,          // not available until approved
                // P1 FIX: Products must be approved by admin before going live.
                // Was: status='active' — any user could list anything immediately.
                // Now: pending_review → admin approves → status='active' + available=true.
                status:          'inactive',
                approvalStatus:  'pending_review',
                metadata:    {
                    ...metadata,
                    condition: condition || 'new',
                    brand:     brand || '',
                    delivery_fee: parseFloat(delivery_fee) || 0,
                    location:  location || '',
                },
            });

            // Broadcast via socket
            _socketBroadcast(req, 'product:created', { product_id: product.id, seller_id: userId });

            return ok(res, { product: _formatProduct(product) }, 'Product created', 201);
        } catch(e) { err(next, e, 'createProduct'); }
    }

    // ── PUT /api/marketplace/products/:id ─────────────────────────────────────
    async updateProduct(req, res, next) {
        try {
            const T = Model.Tool;
            const product = await T?.findByPk(req.params.id);
            if (!product) return next(new AppError('Product not found', 404));
            if (product.sellerId !== req.user?.id) return next(new AppError('Not authorized', 403));

            const updates = {};
            const { title, description, price, category, type, images, tags, stock, available, metadata } = req.body;
            if (title       != null) updates.title       = title.trim().substring(0, 255);
            if (description != null) updates.description = description.trim().substring(0, 10000);
            if (price       != null) updates.price       = parseFloat(price) || 0;
            if (category    != null) updates.category    = _sanitizeCategory(category);
            if (type        != null) updates.type        = _sanitizeType(type);
            if (images      != null) updates.images      = Array.isArray(images) ? images.slice(0,10) : [];
            if (tags        != null) updates.tags        = Array.isArray(tags)   ? tags.slice(0,20)   : [];
            if (stock       != null) updates.stock       = parseInt(stock);
            if (available   != null) updates.available   = !!available;
            if (metadata    != null) updates.metadata    = { ...product.metadata, ...metadata };

            await product.update(updates);
            _socketBroadcast(req, 'product:updated', { product_id: product.id });
            return ok(res, { product: _formatProduct(product) }, 'Product updated');
        } catch(e) { err(next, e, 'updateProduct'); }
    }

    // ── DELETE /api/marketplace/products/:id ──────────────────────────────────
    async deleteProduct(req, res, next) {
        try {
            const T = Model.Tool;
            const product = await T?.findByPk(req.params.id);
            if (!product) return next(new AppError('Product not found', 404));

            const isOwner = product.sellerId === req.user?.id;
            const isAdmin = req.user?.role === 'admin';
            if (!isOwner && !isAdmin) return next(new AppError('Not authorized', 403));

            await product.update({ status: 'deleted', available: false });
            _socketBroadcast(req, 'product:deleted', { product_id: product.id });
            return ok(res, null, 'Product deleted');
        } catch(e) { err(next, e, 'deleteProduct'); }
    }

    // ── PATCH /api/marketplace/products/:id/stock ─────────────────────────────
    async updateStock(req, res, next) {
        try {
            const T = Model.Tool;
            const product = await T?.findByPk(req.params.id);
            if (!product) return next(new AppError('Product not found', 404));
            if (product.sellerId !== req.user?.id) return next(new AppError('Not authorized', 403));

            const qty = parseInt(req.body.stock_quantity ?? req.body.stock ?? req.body.quantity);
            if (isNaN(qty) || qty < 0) return next(new AppError('Invalid stock quantity', 400));

            await product.update({ stock: qty, available: qty > 0 });
            _socketBroadcast(req, 'product:stock_updated', { product_id: product.id, quantity: qty });
            return ok(res, { product_id: product.id, stock_quantity: qty }, 'Stock updated');
        } catch(e) { err(next, e, 'updateStock'); }
    }

    // ── POST /api/marketplace/products/upload-image ───────────────────────────
    async uploadImage(req, res, next) {
        // Run multer middleware inline
        _marketplaceUpload(req, res, async (multerErr) => {
            try {
                if (multerErr) return next(new AppError(multerErr.message || 'File upload failed', 400));
                if (!req.file) return next(new AppError('No file uploaded', 400));
                // Build absolute URL so the frontend can load the image cross-origin
                const baseUrl = process.env.RENDER_EXTERNAL_URL ||
                                process.env.BACKEND_URL ||
                                `${req.protocol}://${req.get('host')}`;
                const relativePath = `/uploads/marketplace/${req.file.filename}`;
                const url = `${baseUrl.replace(/\/+$/, '')}${relativePath}`;
                return ok(res, { url, relativePath }, 'Image uploaded', 201);
            } catch(e) { err(next, e, 'uploadImage'); }
        });
    }

    // ── GET /api/marketplace/categories ───────────────────────────────────────
    async getCategories(req, res, next) {
        try {
            const categories = [
                { id:'electronics', name:'Electronics',     icon:'📱', color:'#2196F3' },
                { id:'fashion',     name:'Fashion',         icon:'👗', color:'#E91E63' },
                { id:'home',        name:'Home & Garden',   icon:'🏠', color:'#4CAF50' },
                { id:'beauty',      name:'Beauty',          icon:'💄', color:'#FF4081' },
                { id:'sports',      name:'Sports',          icon:'⚽', color:'#FF9800' },
                { id:'books',       name:'Books',           icon:'📚', color:'#795548' },
                { id:'toys',        name:'Toys',            icon:'🧸', color:'#FFC107' },
                { id:'food',        name:'Food & Groceries',icon:'🛒', color:'#66BB6A' },
                { id:'automotive',  name:'Automotive',      icon:'🚗', color:'#607D8B' },
                { id:'services',    name:'Services',        icon:'🔧', color:'#9C27B0' },
                { id:'digital',     name:'Digital',         icon:'💾', color:'#00BCD4' },
                { id:'health',      name:'Health',          icon:'💊', color:'#F44336' },
                { id:'other',       name:'Other',           icon:'📦', color:'#9E9E9E' },
            ];
            return ok(res, { categories }, 'Categories fetched');
        } catch(e) { err(next, e, 'getCategories'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CART (FIX: Forensic Audit P1 — Cart model + endpoints added)
    // ══════════════════════════════════════════════════════════════════════════

    async getCart(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));
            const CartModel = getDb().Cart;
            if (!CartModel) {
                // Graceful degradation if migration not yet run
                return ok(res, { cart: { items: [], subtotal: 0, item_count: 0 } }, 'OK');
            }
            const cart = await CartModel.getOrCreate(userId);
            return ok(res, {
                cart: {
                    id:           cart.id,
                    items:        cart.items || [],
                    item_count:   cart.getItemCount(),
                    subtotal:     parseFloat(cart.getSubtotal().toFixed(2)),
                    currency:     cart.currency,
                    coupon_code:  cart.couponCode,
                    discount:     parseFloat(cart.discountAmount || 0),
                    expires_at:   cart.expiresAt,
                }
            });
        } catch(e) { err(next, e, 'getCart'); }
    }

    async addToCart(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));
            const { product_id, seller_id, title, price, quantity = 1, image, variant } = req.body;
            if (!product_id) return next(new AppError('product_id required', 400));
            if (!price && price !== 0) return next(new AppError('price required', 400));

            // P1 FIX: Check stock before adding to cart — prevents adding out-of-stock items.
            const T = Model.Tool;
            if (T) {
                const product = await T.findByPk(product_id).catch(() => null);
                if (product) {
                    if (product.status !== 'active' || product.approvalStatus !== 'approved') {
                        return next(new AppError('This product is not available', 400));
                    }
                    if (product.stock != null && product.stock < quantity) {
                        return next(new AppError(
                            product.stock === 0
                                ? 'This item is out of stock'
                                : `Only ${product.stock} item(s) available`,
                            409
                        ));
                    }
                }
            }

            const CartModel = getDb().Cart;
            if (!CartModel) return next(new AppError('Cart service not available', 503));

            const cart = await CartModel.getOrCreate(userId);
            await cart.addItem({ product_id, seller_id, title, price, quantity, image, variant });
            await cart.reload();

            _socketBroadcast(req, 'cart:updated', { user_id: userId, item_count: cart.getItemCount() });
            return ok(res, {
                cart: {
                    id:         cart.id,
                    items:      cart.items,
                    item_count: cart.getItemCount(),
                    subtotal:   parseFloat(cart.getSubtotal().toFixed(2)),
                }
            }, 'Item added to cart');
        } catch(e) { err(next, e, 'addToCart'); }
    }

    async removeFromCart(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));
            const { product_id, variant } = req.body;
            if (!product_id) return next(new AppError('product_id required', 400));

            const CartModel = getDb().Cart;
            if (!CartModel) return next(new AppError('Cart service not available', 503));

            const cart = await CartModel.getOrCreate(userId);
            await cart.removeItem(product_id, variant || null);
            await cart.reload();

            return ok(res, {
                cart: {
                    id:         cart.id,
                    items:      cart.items,
                    item_count: cart.getItemCount(),
                    subtotal:   parseFloat(cart.getSubtotal().toFixed(2)),
                }
            }, 'Item removed from cart');
        } catch(e) { err(next, e, 'removeFromCart'); }
    }

    async updateCartItem(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));
            const { product_id, quantity, variant } = req.body;
            if (!product_id || !quantity) return next(new AppError('product_id and quantity required', 400));

            const CartModel = getDb().Cart;
            if (!CartModel) return next(new AppError('Cart service not available', 503));

            const cart = await CartModel.getOrCreate(userId);
            await cart.updateItemQuantity(product_id, quantity, variant || null);
            await cart.reload();

            return ok(res, {
                cart: {
                    id:         cart.id,
                    items:      cart.items,
                    item_count: cart.getItemCount(),
                    subtotal:   parseFloat(cart.getSubtotal().toFixed(2)),
                }
            }, 'Cart updated');
        } catch(e) { err(next, e, 'updateCartItem'); }
    }

    async clearCart(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));
            const CartModel = getDb().Cart;
            if (!CartModel) return next(new AppError('Cart service not available', 503));
            const cart = await CartModel.getOrCreate(userId);
            await cart.clear();
            return ok(res, { cart: { id: cart.id, items: [], item_count: 0, subtotal: 0 } }, 'Cart cleared');
        } catch(e) { err(next, e, 'clearCart'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WISHLIST / SAVED
    // ══════════════════════════════════════════════════════════════════════════

    async getWishlist(req, res, next) {
        try {
            const T = Model.Tool;
            const userId = req.user?.id;
            if (!T || !userId) return ok(res, { items: [] });

            const products = await T.findAll({
                where: { savedBy: { [Op.contains]: [userId] }, status: 'active' },
                include: _sellerInclude(T),
                order: [['updatedAt', 'DESC']],
                limit: 100,
            });
            return ok(res, { items: products.map(p => ({ product_id: p.id, ..._formatProduct(p) })) });
        } catch(e) { err(next, e, 'getWishlist'); }
    }

    async toggleWishlist(req, res, next) {
        try {
            const T = Model.Tool;
            const userId = req.user?.id;
            const { product_id } = req.body;
            if (!T || !userId || !product_id) return next(new AppError('Invalid request', 400));

            const product = await T.findByPk(product_id);
            if (!product) return next(new AppError('Product not found', 404));

            const saved = await product.toggleSave(userId);
            return ok(res, { saved: (product.savedBy||[]).includes(userId), product_id }, 'Wishlist updated');
        } catch(e) { err(next, e, 'toggleWishlist'); }
    }

    async removeFromWishlist(req, res, next) {
        try {
            const T = Model.Tool;
            const userId = req.user?.id;
            const product = await T?.findByPk(req.params.id);
            if (!product) return next(new AppError('Product not found', 404));
            product.savedBy = (product.savedBy||[]).filter(id => id !== userId);
            await product.save();
            return ok(res, null, 'Removed from wishlist');
        } catch(e) { err(next, e, 'removeFromWishlist'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ORDERS
    // ══════════════════════════════════════════════════════════════════════════

    // ── POST /api/marketplace/orders ─────────────────────────────────────────
    async createOrder(req, res, next) {
        try {
            const O = Model.Order;
            const T = Model.Tool;
            const buyerId = req.user?.id;
            if (!buyerId) return next(new AppError('Authentication required', 401));

            const { items, delivery_address, payment_method, phone, notes, total, subtotal, delivery, currency='KES', idempotency_key, coupon_code } = req.body;
            if (!items?.length) return next(new AppError('Cart is empty', 400));
            if (!delivery_address) return next(new AppError('Delivery address required', 400));

            if (!O || !T) {
                return next(new AppError('Checkout service is temporarily unavailable. Please try again later.', 503));
            }

            // P1 FIX: Coupon validation — model existed but was never wired into checkout.
            // First coupon use was crashing with "relation coupons does not exist" (now fixed in migration).
            let couponDiscount = 0;
            let appliedCoupon = null;
            if (coupon_code) {
                try {
                    const CouponModel = getDb().Coupon;
                    if (CouponModel) {
                        const coupon = await CouponModel.findOne({
                            where: { code: coupon_code.toUpperCase(), isActive: true }
                        });
                        if (!coupon) {
                            return next(new AppError('Invalid or expired coupon code', 400));
                        }
                        const now = new Date();
                        if (coupon.validUntil && coupon.validUntil < now) {
                            return next(new AppError('This coupon has expired', 400));
                        }
                        if (coupon.validFrom && coupon.validFrom > now) {
                            return next(new AppError('This coupon is not yet active', 400));
                        }
                        if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) {
                            return next(new AppError('This coupon has reached its usage limit', 400));
                        }
                        const orderTotal = parseFloat(total) || 0;
                        if (coupon.minOrderValue && orderTotal < coupon.minOrderValue) {
                            return next(new AppError(
                                `Minimum order value for this coupon is KES ${coupon.minOrderValue}`,
                                400
                            ));
                        }
                        // Calculate discount
                        if (coupon.discountType === 'percentage') {
                            couponDiscount = (orderTotal * coupon.discountValue) / 100;
                        } else {
                            couponDiscount = Math.min(coupon.discountValue, orderTotal);
                        }
                        appliedCoupon = coupon;
                    }
                } catch(couponErr) {
                    logger.warn('[Marketplace] Coupon validation error (non-fatal):', couponErr.message);
                }
            }

            // P1 FIX: Idempotency — prevent duplicate orders on double-click.
            // If an idempotency_key is provided, check for an existing order with the same key.
            if (idempotency_key) {
                const existingOrder = await O.findOne({
                    where: { buyerId, metadata: { idempotency_key } }
                }).catch(() => null);
                if (existingOrder) {
                    return ok(res, {
                        order: {
                            id:       existingOrder.id,
                            buyer_id: buyerId,
                            status:   existingOrder.status,
                            currency,
                            payment_method,
                            delivery_address,
                            items,
                            created_at: existingOrder.createdAt,
                        }
                    }, 'Order already placed (idempotent)');
                }
            }

            const sequelize = getSequelize();

            // P1 FIX: Wrap stock deduction in a DB transaction with SELECT FOR UPDATE.
            // Previously stock was reduced in a non-atomic for-loop after order creation,
            // allowing two concurrent buyers to purchase the last item (overselling).
            const runWithTransaction = async (callback) => {
                if (sequelize) {
                    return sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, callback);
                }
                // Fallback if sequelize not available (should not happen in production)
                return callback(null);
            };

            // Group items by seller
            const sellerGroups = {};
            for (const item of items) {
                const sid = item.seller_id;
                if (!sellerGroups[sid]) sellerGroups[sid] = [];
                sellerGroups[sid].push(item);
            }

            const orders = await runWithTransaction(async (t) => {
                const txOpts = t ? { transaction: t } : {};
                const created = [];

                for (const [sellerId, sellerItems] of Object.entries(sellerGroups)) {
                    // P1 FIX: Validate stock with SELECT FOR UPDATE before deducting
                    for (const item of sellerItems) {
                        if (item.product_id) {
                            const product = await T.findOne({
                                where: { id: item.product_id },
                                lock: t ? t.LOCK.UPDATE : undefined,
                                ...txOpts,
                            });
                            if (product && product.stock != null) {
                                if (product.stock < item.quantity) {
                                    throw new AppError(
                                        `Insufficient stock for "${product.title}". Available: ${product.stock}`,
                                        409
                                    );
                                }
                            }
                        }
                    }

                    const groupTotal = sellerItems.reduce((s, i) => s + (i.price * i.quantity) + (i.delivery_fee||0), 0);
                    const order = await O.create({
                        buyerId,
                        sellerId,
                        productId: sellerItems[0].product_id,
                        status:    'pending',
                        quantity:  sellerItems.reduce((s,i) => s + i.quantity, 0),
                        totalPrice: parseFloat(groupTotal.toFixed(2)),
                        currency,
                        paymentMethod: payment_method,
                        deliveryAddress: { ...delivery_address, phone },
                        notes: notes || '',
                        metadata: {
                            items: sellerItems,
                            idempotency_key: idempotency_key || null,
                            coupon_code:     coupon_code || null,
                            coupon_discount: couponDiscount || 0,
                        },
                    }, txOpts);
                    created.push(order);

                    // P1 FIX: Deduct stock inside the same transaction
                    for (const item of sellerItems) {
                        try {
                            const product = await T.findByPk(item.product_id, txOpts);
                            if (product && product.stock != null) {
                                const newStock = Math.max(0, product.stock - item.quantity);
                                await product.update({ stock: newStock, available: newStock > 0 }, txOpts);
                                _socketBroadcast(req, 'product:stock_updated', { product_id: item.product_id, quantity: newStock });
                            }
                        } catch(_) {}
                    }

                    _socketBroadcast(req, 'order:created', { order_id: order.id, buyer_id: buyerId, seller_id: sellerId });
                }
                return created;
            });

            // Increment coupon usedCount outside transaction (non-critical, best-effort)
            if (appliedCoupon) {
                appliedCoupon.increment('usedCount').catch(() => {});
            }

            const primaryOrder = orders[0];
            return ok(res, {
                order: {
                    id:               primaryOrder.id,
                    buyer_id:         buyerId,
                    status:           'pending',
                    total:            parseFloat(total||0) - couponDiscount,
                    coupon_discount:  couponDiscount,
                    currency,
                    payment_method,
                    delivery_address,
                    items,
                    orders:           orders.map(o => o.id),
                    created_at:       primaryOrder.createdAt,
                }
            }, 'Order placed successfully', 201);
        } catch(e) { err(next, e, 'createOrder'); }
    }

    // ── GET /api/marketplace/orders ───────────────────────────────────────────
    async getOrders(req, res, next) {
        try {
            const O = Model.Order;
            const userId = req.user?.id;
            if (!O || !userId) return ok(res, { orders: [] });

            const isSeller = req.query.role === 'seller';
            const where = isSeller ? { sellerId: userId } : { buyerId: userId };
            if (req.query.status) where.status = req.query.status;

            const orders = await O.findAll({
                where,
                order: [['createdAt', 'DESC']],
                limit: parseInt(req.query.limit) || 50,
                offset: ((parseInt(req.query.page)||1)-1) * (parseInt(req.query.limit)||50),
                include: _productInclude(O),
            });

            return ok(res, { orders: orders.map(o => _formatOrder(o)) });
        } catch(e) { err(next, e, 'getOrders'); }
    }

    // ── GET /api/marketplace/orders/:id ───────────────────────────────────────
    async getOrder(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return next(new AppError('Order not found', 404));
            const order = await O.findByPk(req.params.id, { include: _productInclude(O) });
            if (!order) return next(new AppError('Order not found', 404));

            const userId = req.user?.id;
            if (order.buyerId !== userId && order.sellerId !== userId && req.user?.role !== 'admin') {
                return next(new AppError('Not authorized', 403));
            }
            return ok(res, { order: _formatOrder(order) });
        } catch(e) { err(next, e, 'getOrder'); }
    }

    // ── PUT /api/marketplace/orders/:id/status ────────────────────────────────
    async updateOrderStatus(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return next(new AppError('Order not found', 404));
            const order = await O.findByPk(req.params.id);
            if (!order) return next(new AppError('Order not found', 404));

            const userId = req.user?.id;
            const isAdmin = req.user?.role === 'admin';
            // Sellers can update to processing/shipped/delivered; buyers can cancel
            const sellerStatuses = ['processing', 'shipped', 'delivered'];
            const buyerStatuses  = ['cancelled'];
            const { status, note } = req.body;

            if (!['pending','paid','processing','shipped','delivered','cancelled','refunded'].includes(status)) {
                return next(new AppError('Invalid status', 400));
            }

            const isSeller = order.sellerId === userId;
            const isBuyer  = order.buyerId  === userId;

            if (!isAdmin) {
                if (isSeller && !sellerStatuses.includes(status)) return next(new AppError('Sellers can only set: processing, shipped, delivered', 403));
                if (isBuyer  && !buyerStatuses.includes(status))  return next(new AppError('Buyers can only cancel orders', 403));
                if (!isSeller && !isBuyer) return next(new AppError('Not authorized', 403));
            }

            const updates = { status };
            if (status === 'paid')      updates.paidAt      = new Date();
            if (status === 'shipped')   updates.shippedAt   = new Date();
            if (status === 'delivered') updates.deliveredAt = new Date();
            if (note) updates.metadata = { ...(order.metadata||{}), status_notes: [...(order.metadata?.status_notes||[]), { status, note, at: new Date() }] };

            await order.update(updates);

            // Broadcast status change
            _socketBroadcast(req, 'order:status_changed', {
                order_id:  order.id,
                status,
                buyer_id:  order.buyerId,
                seller_id: order.sellerId,
            });

            return ok(res, { order_id: order.id, status }, 'Order status updated');
        } catch(e) { err(next, e, 'updateOrderStatus'); }
    }

    // ── GET /api/marketplace/orders/:id/tracking ──────────────────────────────
    async getOrderTracking(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { tracking: null });
            const order = await O.findByPk(req.params.id, { attributes: ['id','status','trackingNumber','shippedAt','deliveredAt','metadata'] });
            if (!order) return next(new AppError('Order not found', 404));

            return ok(res, {
                tracking: {
                    order_id:       order.id,
                    status:         order.status,
                    tracking_number: order.trackingNumber,
                    shipped_at:     order.shippedAt,
                    delivered_at:   order.deliveredAt,
                    history:        order.metadata?.status_notes || [],
                    eta:            '1-3 business days',
                }
            });
        } catch(e) { err(next, e, 'getOrderTracking'); }
    }

    // ── PUT /api/marketplace/orders/:id/tracking ──────────────────────────────
    async updateTracking(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, null, 'Updated');
            const order = await O.findByPk(req.params.id);
            if (!order) return next(new AppError('Order not found', 404));
            if (order.sellerId !== req.user?.id && req.user?.role !== 'admin') return next(new AppError('Not authorized', 403));

            const { tracking_number, status, location, note } = req.body;
            const updates = {};
            if (tracking_number) updates.trackingNumber = tracking_number;
            if (status) updates.status = status;
            updates.metadata = {
                ...(order.metadata||{}),
                tracking: { number: tracking_number, location, updatedAt: new Date() },
            };
            await order.update(updates);

            _socketBroadcast(req, 'delivery:updated', { order_id: order.id, status, location, tracking_number });
            return ok(res, null, 'Tracking updated');
        } catch(e) { err(next, e, 'updateTracking'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PAYMENTS
    // ══════════════════════════════════════════════════════════════════════════

    async initiateMpesa(req, res, next) {
        try {
            const { phone, amount, order_id, description, callback_url } = req.body;
            if (!phone || !amount || !order_id) return next(new AppError('phone, amount, order_id required', 400));

            // FIX (Forensic Audit P2): Validate/derive callbackUrl.
            // If caller doesn't supply one, auto-derive from BACKEND_URL env var.
            // Without a valid callbackUrl, M-Pesa never delivers payment confirmation.
            const backendUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '';
            const resolvedCallback = callback_url
                || (backendUrl ? `${backendUrl.replace(/\/$/, '')}/api/tools/marketplace/payment/mpesa/callback` : null);

            if (!resolvedCallback) {
                logger.error('[Marketplace] initiateMpesa: callbackUrl is empty. Set BACKEND_URL env var.');
                return next(new AppError(
                    'Payment callback URL could not be resolved. Set BACKEND_URL environment variable.',
                    500
                ));
            }

            // M-Pesa STK Push via Safaricom Daraja API
            const result = await _mpesaStkPush({ phone, amount, orderId: order_id, description, callbackUrl: resolvedCallback });
            return ok(res, result, 'STK Push sent');
        } catch(e) { err(next, e, 'initiateMpesa'); }
    }

    async mpesaCallback(req, res, next) {
        try {
            // P1 FIX: Validate that the callback is genuinely from Safaricom.
            // Without this, ANY POST to this endpoint marks orders as paid.
            // Safaricom sends from known IP ranges; in production also validate
            // the HMAC-SHA256 signature using MPESA_PASSKEY.
            const SAFARICOM_IPS = [
                '196.201.214.200', '196.201.214.206', '196.201.213.114',
                '196.201.214.207', '196.201.214.208', '196.201.213.44',
                '196.201.212.127', '196.201.212.138', '196.201.212.129',
                '196.201.212.136', '196.201.212.74',  '196.201.212.69',
            ];
            const clientIp = (
                req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                req.connection?.remoteAddress ||
                req.socket?.remoteAddress || ''
            ).replace('::ffff:', '');

            const isLocalDev = process.env.NODE_ENV !== 'production' ||
                               clientIp === '127.0.0.1' || clientIp === '::1';
            if (!isLocalDev && !SAFARICOM_IPS.includes(clientIp)) {
                logger.warn(`[Marketplace] M-Pesa callback blocked from untrusted IP: ${clientIp}`);
                // Return 200 to avoid Safaricom retries but do NOT process the payment
                return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
            }

            const body = req.body?.Body?.stkCallback || req.body;
            const resultCode = body?.ResultCode ?? body?.result_code;

            if (resultCode === 0 || resultCode === '0') {
                // Payment successful — find and update order
                await _handleMpesaSuccess(body);
            }
            // Always return 200 to Safaricom
            return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
        } catch(e) {
            logger.error('[Marketplace] M-Pesa callback error:', e.message);
            return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
        }
    }

    async verifyMpesa(req, res, next) {
        try {
            const { request_id, order_id } = req.body;
            // In production: query Daraja API for status. Simplified:
            const O = Model.Order;
            const order = O ? await O.findByPk(order_id) : null;
            const isPaid = order?.status === 'paid';
            return ok(res, { status: isPaid ? 'paid' : 'pending', order_id });
        } catch(e) { err(next, e, 'verifyMpesa'); }
    }

    async cardPayment(req, res, next) {
        // FIX-P12: Card payment was a fake stub that marked any order as 'paid'
        // without a real charge. This is a critical financial integrity issue.
        // Returning 501 until Stripe/Flutterwave is integrated.
        return res.status(501).json({
            success: false,
            message: 'Card payment integration is not yet configured. Please use M-Pesa or contact support.',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED'
        });
    }

    async walletPayment(req, res, next) {
        // FIX-P12: Wallet payment was a fake stub that always returned 'paid'
        // with no balance check or deduction. Returning 501 until implemented.
        return res.status(501).json({
            success: false,
            message: 'Wallet payment is not yet implemented.',
            code: 'NOT_IMPLEMENTED'
        });
    }

    async getWalletBalance(req, res, next) {
        // FIX-P12: Was always returning balance: 0 (hardcoded stub).
        // Returning 501 until wallet system is built.
        return res.status(501).json({
            success: false,
            message: 'Wallet system is not yet implemented.',
            code: 'NOT_IMPLEMENTED'
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // REVIEWS
    // ══════════════════════════════════════════════════════════════════════════

    async getReviews(req, res, next) {
        try {
            const R = Model.Review;
            const productId = req.params.id;
            const { page=1, limit=20 } = req.query;
            if (!R) return ok(res, { reviews: [], avgRating: 0, total: 0 });

            const { count, rows } = await R.findAndCountAll({
                where:  { productId },
                order:  [['createdAt', 'DESC']],
                limit:  parseInt(limit),
                offset: (parseInt(page)-1) * parseInt(limit),
                include: _reviewerInclude(R),
            });

            const avgRating = rows.length ? rows.reduce((s,r) => s + r.rating, 0) / rows.length : 0;
            return ok(res, {
                reviews:   rows.map(r => _formatReview(r)),
                avgRating: parseFloat(avgRating.toFixed(1)),
                total:     count,
            });
        } catch(e) { err(next, e, 'getReviews'); }
    }

    async createReview(req, res, next) {
        try {
            const R = Model.Review;
            const T = Model.Tool;
            const userId = req.user?.id;
            if (!userId) return next(new AppError('Authentication required', 401));

            const productId = req.params.id;
            const { rating, comment, text, images=[], order_id } = req.body;
            const ratingNum = parseInt(rating);
            if (!ratingNum || ratingNum < 1 || ratingNum > 5) return next(new AppError('Rating must be 1-5', 400));

            if (!R) return ok(res, { review: { id: crypto.randomUUID(), rating: ratingNum } }, 'Review noted');

            // Get product to find sellerId
            const product = await T?.findByPk(productId);
            if (!product) return next(new AppError('Product not found', 404));

            // Check if already reviewed
            const existing = await R.findOne({ where: { productId, userId } });
            if (existing) return next(new AppError('You have already reviewed this product', 409));

            const review = await R.create({
                productId,
                userId,
                sellerId:          product.sellerId,
                orderId:           order_id || null,
                rating:            ratingNum,
                comment:           ((comment || text || '').trim()).substring(0, 2000),
                images:            Array.isArray(images) ? images.slice(0,5) : [],
                isVerifiedPurchase: !!order_id,
            });

            // Update product rating
            if (T) {
                await product.addRating(ratingNum);
            }

            // Notify seller
            _socketBroadcast(req, 'review:new', {
                product_id: productId,
                seller_id:  product.sellerId,
                rating:     ratingNum,
            });

            return ok(res, { review: _formatReview(review) }, 'Review submitted', 201);
        } catch(e) { err(next, e, 'createReview'); }
    }

    async respondToReview(req, res, next) {
        try {
            const R = Model.Review;
            if (!R) return ok(res, null, 'Response noted');
            const review = await R.findByPk(req.params.id);
            if (!review) return next(new AppError('Review not found', 404));
            if (review.sellerId !== req.user?.id) return next(new AppError('Not authorized', 403));

            await review.update({ sellerReply: req.body.response?.substring(0,1000), sellerRepliedAt: new Date() });
            return ok(res, null, 'Response posted');
        } catch(e) { err(next, e, 'respondToReview'); }
    }

    async markReviewHelpful(req, res, next) {
        try {
            const R = Model.Review;
            if (!R) return ok(res, null);
            await R.increment('helpfulCount', { where: { id: req.params.id } });
            return ok(res, null, 'Marked as helpful');
        } catch(e) { err(next, e, 'markReviewHelpful'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SELLER DASHBOARD
    // ══════════════════════════════════════════════════════════════════════════

    async getSellerProfile(req, res, next) {
        try {
            const T = Model.Tool;
            const U = Model.User;
            const O = Model.Order;
            const R = Model.Review;
            const { sellerId } = req.params;

            const user = U ? await U.findByPk(sellerId, { attributes: ['id','username','displayName','avatar','createdAt'] }) : null;
            const listingCount = T ? await T.count({ where: { sellerId, status: 'active' } }) : 0;
            const reviewCount  = R ? await R.count({ where: { sellerId } }) : 0;
            const avgRating    = R ? (await R.findOne({ where: { sellerId }, attributes: [[getSequelize()?.fn('AVG', getSequelize()?.col('rating')), 'avg']] }))?.dataValues?.avg || 0 : 0;

            const listings = T ? await T.findAll({
                where: { sellerId, status: 'active', available: true },
                order: [['createdAt','DESC']], limit: 6,
            }) : [];

            return ok(res, {
                seller: {
                    id:        sellerId,
                    name:      user?.displayName || user?.username || 'Seller',
                    avatar:    user?.avatar || '',
                    joinedAt:  user?.createdAt,
                    verified:  false,
                },
                stats: { listingCount, reviewCount, avgRating: parseFloat(avgRating||0).toFixed(1) },
                listings: listings.map(l => _formatProduct(l)),
            });
        } catch(e) { err(next, e, 'getSellerProfile'); }
    }

    async getSellerDashboard(req, res, next) {
        try {
            const T = Model.Tool;
            const O = Model.Order;
            const sellerId = req.params.sellerId || req.user?.id;
            if (!sellerId) return next(new AppError('Seller ID required', 400));

            const totalListings   = T ? await T.count({ where: { sellerId, status: { [Op.ne]: 'deleted' } } }) : 0;
            const activeListings  = T ? await T.count({ where: { sellerId, status: 'active', available: true } }) : 0;
            const totalOrders     = O ? await O.count({ where: { sellerId } }) : 0;
            const pendingOrders   = O ? await O.count({ where: { sellerId, status: 'pending' } }) : 0;
            const completedOrders = O ? await O.count({ where: { sellerId, status: 'delivered' } }) : 0;
            const totalRevenue    = O ? (await O.sum('totalPrice', { where: { sellerId, status: { [Op.in]: ['paid','delivered'] } } })) || 0 : 0;

            return ok(res, {
                totalListings, activeListings,
                totalOrders, pendingOrders, completedOrders,
                totalRevenue: parseFloat(totalRevenue).toFixed(2),
                currency: 'KES',
            });
        } catch(e) { err(next, e, 'getSellerDashboard'); }
    }

    async getSellerEarnings(req, res, next) {
        try {
            const O = Model.Order;
            const sellerId = req.params.sellerId || req.user?.id;
            const { period='30d' } = req.query;

            const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
            const since = new Date(Date.now() - days * 24*60*60*1000);

            const total = O ? (await O.sum('totalPrice', {
                where: { sellerId, status: { [Op.in]: ['paid','delivered'] }, createdAt: { [Op.gte]: since } }
            })) || 0 : 0;

            return ok(res, { total: parseFloat(total).toFixed(2), period, currency: 'KES' });
        } catch(e) { err(next, e, 'getSellerEarnings'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DELIVERY
    // ══════════════════════════════════════════════════════════════════════════

    async getDeliveryZones(req, res, next) {
        try {
            return ok(res, {
                zones: [
                    { id:'nairobi',  name:'Nairobi CBD',      fee:50,  eta:'1-2 hours' },
                    { id:'suburbs',  name:'Nairobi Suburbs',  fee:150, eta:'2-4 hours' },
                    { id:'kenya',    name:'Rest of Kenya',    fee:300, eta:'1-3 days' },
                    { id:'express',  name:'Express Nairobi',  fee:250, eta:'30-60 min' },
                    { id:'pickup',   name:'Pickup',           fee:0,   eta:'Anytime'  },
                ]
            });
        } catch(e) { err(next, e, 'getDeliveryZones'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FLASH SALES & RECOMMENDATIONS (P2 FIX: was returning empty stubs)
    // ══════════════════════════════════════════════════════════════════════════

    async getFlashSales(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return ok(res, { flash_sales: [], total: 0 }, 'No flash sales available');
            const now = new Date();
            const flashSales = await T.findAll({
                where: {
                    status:      'active',
                    available:   true,
                    approvalStatus: 'approved',
                    isFlashSale: true,
                    flashSaleEnd: { [Op.gt]: now },
                    flashSalePrice: { [Op.ne]: null },
                },
                order: [['flashSaleEnd', 'ASC']],
                limit: parseInt(req.query.limit) || 20,
            });
            return ok(res, {
                flash_sales: flashSales.map(p => ({
                    ..._formatProduct(p),
                    flash_sale_price: parseFloat(p.flashSalePrice || p.price),
                    flash_sale_end:   p.flashSaleEnd,
                    discount_pct:     p.flashSalePrice
                        ? Math.round((1 - p.flashSalePrice / p.price) * 100)
                        : 0,
                })),
                total: flashSales.length,
            });
        } catch(e) { err(next, e, 'getFlashSales'); }
    }

    async getRecommendations(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return ok(res, { recommendations: [], products: [] }, 'No recommendations');
            const userId = req.user?.id;
            const { category, limit = 10 } = req.query;

            // Simple collaborative recommendation: top-rated approved products
            // from the same category as the query param, or globally top-rated.
            const where = {
                status:      'active',
                available:   true,
                approvalStatus: 'approved',
            };
            if (category) where.category = category;

            const products = await T.findAll({
                where,
                order: [['rating', 'DESC'], ['views', 'DESC']],
                limit: parseInt(limit) || 10,
            });
            return ok(res, {
                recommendations: products.map(_formatProduct),
                products:        products.map(_formatProduct),
            });
        } catch(e) { err(next, e, 'getRecommendations'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════════════════

    async adminRemoveProduct(req, res, next) {
        try {
            if (req.user?.role !== 'admin') return next(new AppError('Admin only', 403));
            const T = Model.Tool;
            const p = T ? await T.findByPk(req.params.id) : null;
            if (!p) return next(new AppError('Product not found', 404));
            await p.update({ status: 'deleted', available: false });
            return ok(res, null, 'Product removed by admin');
        } catch(e) { err(next, e, 'adminRemoveProduct'); }
    }

    async adminBanSeller(req, res, next) {
        try {
            if (req.user?.role !== 'admin') return next(new AppError('Admin only', 403));
            // Mark all their listings inactive
            const T = Model.Tool;
            if (T) await T.update({ status:'inactive', available:false }, { where: { sellerId: req.params.sellerId } });
            return ok(res, null, 'Seller banned');
        } catch(e) { err(next, e, 'adminBanSeller'); }
    }

    async adminGetStats(req, res, next) {
        try {
            if (req.user?.role !== 'admin') return next(new AppError('Admin only', 403));
            const T = Model.Tool, O = Model.Order, R = Model.Review;
            return ok(res, {
                totalProducts:  T ? await T.count({ where: { status: { [Op.ne]: 'deleted' } } }) : 0,
                activeProducts: T ? await T.count({ where: { status: 'active' } }) : 0,
                totalOrders:    O ? await O.count() : 0,
                totalRevenue:   O ? await O.sum('totalPrice', { where: { status: { [Op.in]: ['paid','delivered'] } } }) || 0 : 0,
                totalReviews:   R ? await R.count() : 0,
            });
        } catch(e) { err(next, e, 'adminGetStats'); }
    }

    // ── Admin: Approve product ─────────────────────────────────────────────
    async adminApproveProduct(req, res, next) {
        try {
            // Note: adminOnly middleware already enforces admin role at router level.
            // Keeping this check as defence-in-depth.
            if (req.user?.role !== 'admin') return next(new AppError('Admin only', 403));
            const T = Model.Tool;
            if (!T) return ok(res, {}, 'Product approved (model unavailable)');
            const product = await T.findByPk(req.params.id);
            if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
            // P1 FIX: Also set status='active' and available=true so the product
            // actually becomes visible. Previously only approval_status was written.
            await product.update({
                status:        'active',
                available:     true,
                approvalStatus: 'approved',
                approvedAt:     new Date(),
                approvedBy:     req.user?.id || null,
            });
            // Notify seller via WebSocket
            try {
                const io = global.__socketIO || global.io;
                if (io && product.sellerId) {
                    io.to(`user:${product.sellerId}`).emit('product:approved', { productId: product.id, title: product.title });
                }
            } catch(_) {}
            return ok(res, _formatProduct(product), 'Product approved');
        } catch(e) { err(next, e, 'adminApproveProduct'); }
    }

    // ── Admin: Reject product ──────────────────────────────────────────────
    async adminRejectProduct(req, res, next) {
        try {
            if (req.user?.role !== 'admin') return next(new AppError('Admin only', 403));
            const T = Model.Tool;
            if (!T) return ok(res, {}, 'Product rejected (model unavailable)');
            const product = await T.findByPk(req.params.id);
            if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
            const { reason } = req.body || {};
            await product.update({
                status:         'inactive',
                available:       false,
                approvalStatus: 'rejected',
                approvalNote:   reason || 'Does not meet marketplace standards',
            });
            try {
                const io = global.__socketIO || global.io;
                if (io && product.sellerId) {
                    io.to(`user:${product.sellerId}`).emit('product:rejected', { productId: product.id, title: product.title, reason });
                }
            } catch(_) {}
            return ok(res, _formatProduct(product), 'Product rejected');
        } catch(e) { err(next, e, 'adminRejectProduct'); }
    }

    // ── Admin: Get pending products ────────────────────────────────────────
    async adminGetPendingProducts(req, res, next) {
        try {
            if (req.user?.role !== 'admin') return next(new AppError('Admin only', 403));
            const T = Model.Tool;
            if (!T) return ok(res, [], 'No products (model unavailable)');
            // P1 FIX: Use correct field value 'pending_review' matching new Tool model default
            const pending = await T.findAll({
                where: { approvalStatus: 'pending_review' },
                order: [['createdAt', 'ASC']],
                limit: parseInt(req.query.limit) || 50,
            });
            return ok(res, pending.map(_formatProduct), `${pending.length} pending products`);
        } catch(e) { err(next, e, 'adminGetPendingProducts'); }
    }

} // end class MarketplaceController

// ══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _sellerInclude(T) {
    try {
        if (T.associations?.seller) {
            return [{ association: T.associations.seller, attributes: ['id','username','displayName','avatar'], required: false }];
        }
    } catch(_) {}
    return [];
}

function _reviewsInclude(T) {
    try {
        if (T.associations?.reviews) {
            return [{ association: T.associations.reviews, limit: 5, order: [['createdAt','DESC']], required: false }];
        }
    } catch(_) {}
    return [];
}

function _productInclude(O) {
    try {
        if (O.associations?.product) {
            return [{ association: O.associations.product, attributes: ['id','title','images','price'], required: false }];
        }
    } catch(_) {}
    return [];
}

function _reviewerInclude(R) {
    try {
        if (R.associations?.reviewer) {
            return [{ association: R.associations.reviewer, attributes: ['id','username','displayName','avatar'], required: false }];
        }
    } catch(_) {}
    return [];
}

function _formatProduct(row) {
    const r = row.toJSON ? row.toJSON() : { ...row };
    const meta = r.metadata || {};
    // FIX: convert all image paths to absolute URLs so cross-origin frontend can load them
    const rawImages = Array.isArray(r.images) ? r.images : [];
    const base = (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || '').replace(/\/+$/, '');
    const images = rawImages.map(u => {
        if (!u) return '';
        if (/^https?:\/\//.test(u)) return u;
        return base ? `${base}${u.startsWith('/') ? '' : '/'}${u}` : u;
    }).filter(Boolean);
    return {
        id:             r.id,
        seller_id:      r.sellerId || r.seller_id,
        seller: {
            id:       r.seller?.id || r.sellerId,
            name:     r.seller?.displayName || r.seller?.username || 'Seller',
            avatar:   r.seller?.avatar || '',
            verified: false,
            rating:   0,
        },
        title:          r.title,
        description:    r.description || '',
        category:       r.category,
        type:           r.type,
        images:         images,
        tags:           r.tags || [],
        price:          parseFloat(r.price) || 0,
        original_price: parseFloat(meta.original_price) || 0,
        discount:       parseFloat(meta.discount) || 0,
        stock_quantity: r.stock ?? r.stockQuantity ?? null,
        rating:         parseFloat(r.rating) || 0,
        reviews_count:  parseInt(r.ratingCount || r.rating_count) || 0,
        delivery_fee:   parseFloat(meta.delivery_fee) || 0,
        location:       meta.location || '',
        condition:      meta.condition || 'new',
        brand:          meta.brand || '',
        is_featured:    !!(r.isFeatured || r.is_featured),
        is_flash_sale:  !!(r.isFlashSale || r.is_flash_sale),
        available:      !!r.available,
        status:         r.status,
        views:          parseInt(r.views) || 0,
        sold_count:     (r.purchasedBy || []).length,
        created_at:     r.createdAt,
        updated_at:     r.updatedAt,
        // Legacy compat
        userId:         r.sellerId,
        user: {
            id:          r.seller?.id || r.sellerId,
            displayName: r.seller?.displayName || r.seller?.username || 'Seller',
            photoURL:    r.seller?.avatar || '',
        },
    };
}

function _formatOrder(row) {
    const r = row.toJSON ? row.toJSON() : { ...row };
    return {
        id:               r.id,
        buyer_id:         r.buyerId,
        seller_id:        r.sellerId,
        product_id:       r.productId,
        status:           r.status,
        quantity:         r.quantity,
        total_price:      parseFloat(r.totalPrice),
        currency:         r.currency || 'KES',
        payment_method:   r.paymentMethod,
        payment_ref:      r.paymentRef,
        delivery_address: r.deliveryAddress || {},
        tracking_number:  r.trackingNumber,
        notes:            r.notes,
        items:            r.metadata?.items || [],
        product:          r.product ? _formatProduct(r.product) : null,
        paid_at:          r.paidAt,
        shipped_at:       r.shippedAt,
        delivered_at:     r.deliveredAt,
        created_at:       r.createdAt,
        updated_at:       r.updatedAt,
    };
}

function _formatReview(row) {
    const r = row.toJSON ? row.toJSON() : { ...row };
    return {
        id:                  r.id,
        product_id:          r.productId,
        user_id:             r.userId,
        seller_id:           r.sellerId,
        rating:              r.rating,
        text:                r.comment || '',
        comment:             r.comment || '',
        images:              r.images || [],
        is_verified_purchase: r.isVerifiedPurchase,
        helpful_count:       r.helpfulCount || 0,
        seller_response:     r.sellerReply,
        seller_replied_at:   r.sellerRepliedAt,
        user: {
            id:   r.reviewer?.id || r.userId,
            name: r.reviewer?.displayName || r.reviewer?.username || 'User',
        },
        reviewer: r.reviewer || null,
        created_at: r.createdAt,
    };
}

function _sanitizeCategory(cat) {
    const VALID = ['electronics','furniture','clothing','books','services','digital','premium',
                   'fashion','home','beauty','sports','toys','food','automotive','health','other'];
    return VALID.includes(cat) ? cat : 'other';
}
function _sanitizeType(type) {
    return ['service','digital','premium','physical'].includes(type) ? type : 'physical';
}

function _socketBroadcast(req, event, data, targetUserId = null) {
    try {
        const io = req.app?.get?.('io') || global.__socketIO || global._io;
        if (targetUserId) {
            // Targeted delivery to specific user
            const uid = parseInt(targetUserId, 10);
            const wsService = (() => { try { return require('../services/webSocketService'); } catch(_) { return null; } })();
            if (wsService && typeof wsService.sendToUser === 'function') {
                wsService.sendToUser(uid, event, data);
            } else if (io) {
                io.to(`user:${uid}`).emit(event, data);
                io.to(`user_${uid}`).emit(event, data);
            }
        } else {
            // Broadcast to all connected clients
            if (io) { io.emit(event, data); return; }
            const rt = global.KynectaRealtime;
            if (rt?.emit) rt.emit(event, data);
        }
    } catch(_) {}
}

async function _mpesaStkPush({ phone, amount, orderId, description, callbackUrl }) {
    // Production implementation should call Safaricom Daraja API
    const consumerKey    = process.env.MPESA_CONSUMER_KEY    || '';
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET || '';
    const shortcode      = process.env.MPESA_SHORTCODE       || '174379';
    const passkey        = process.env.MPESA_PASSKEY         || '';
    const baseUrl        = process.env.MPESA_ENV === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';

    if (!consumerKey || !consumerSecret) {
        logger.warn('[Marketplace] M-Pesa env vars not set — returning mock response');
        return { CheckoutRequestID: 'MOCK-' + Date.now(), mock: true };
    }

    try {
        // 1. Get access token
        const authRes = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: {
                Authorization: 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64'),
            }
        });
        const { access_token } = await authRes.json();

        // 2. STK Push
        const timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
        const password  = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        const stkRes = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                BusinessShortCode: shortcode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: Math.ceil(amount),
                PartyA: phone,
                PartyB: shortcode,
                PhoneNumber: phone,
                CallBackURL: callbackUrl,
                AccountReference: `Order-${orderId?.slice(-8)||'KNT'}`,
                TransactionDesc: description || 'Marketplace Payment',
            })
        });
        return await stkRes.json();
    } catch(e) {
        logger.error('[Marketplace] M-Pesa STK error:', e.message);
        throw e;
    }
}

async function _handleMpesaSuccess(callbackData) {
    try {
        const O = Model.Order;
        if (!O) return;

        // Extract amount and checkout ID
        const items = callbackData?.CallbackMetadata?.Item || [];
        const ref   = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
        const amt   = items.find(i => i.Name === 'Amount')?.Value;
        const checkoutId = callbackData?.CheckoutRequestID;

        if (checkoutId) {
            await O.update(
                { status:'paid', paidAt: new Date(), paymentRef: ref },
                { where: { paymentRef: checkoutId } }
            );

            // FIX: find updated order and notify buyer + seller via socket
            try {
                const updatedOrders = await O.findAll({ where: { paymentRef: checkoutId }, limit: 5 });
                const io = global.__socketIO;
                if (io && updatedOrders.length) {
                    updatedOrders.forEach(order => {
                        const payload = {
                            orderId    : order.id,
                            status     : 'paid',
                            paymentRef : ref,
                            amount     : amt,
                            paidAt     : order.paidAt,
                        };
                        // Notify buyer
                        if (order.buyerId) {
                            io.to(`user:${order.buyerId}`).emit('order:status_changed', payload);
                        }
                        // Notify seller
                        if (order.sellerId) {
                            io.to(`user:${order.sellerId}`).emit('order:status_changed', payload);
                        }
                    });
                }
            } catch(notifyErr) {
                logger.warn('[Marketplace] Socket notification after Mpesa failed:', notifyErr.message);
            }
        }
        logger.info('[Marketplace] M-Pesa payment confirmed, ref:', ref);
    } catch(e) {
        logger.error('[Marketplace] M-Pesa success handler error:', e.message);
    }
}

module.exports = new MarketplaceController();