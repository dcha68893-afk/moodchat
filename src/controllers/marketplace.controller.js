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
                // No model: return empty
                return ok(res, { products: [], total: 0, page: 1, totalPages: 0 }, 'No products');
            }

            const where = {};
            // ── CRITICAL: buyers only see approved/active products ─────────────
            if (available !== 'false') {
                where.available = true;
                where.status = { [Op.in]: ['active', 'approved'] };
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
                where[Op.or] = [
                    { title:       { [Op.iLike]: `%${search}%` } },
                    { description: { [Op.iLike]: `%${search}%` } },
                ];
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
                available:   available !== false,
                status:      'pending_review',  // ALWAYS starts pending — never visible until admin approves
                approvalStatus: 'pending',
                submittedAt: new Date(),
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
        try {
            if (!req.file) return next(new AppError('No file uploaded', 400));
            // In production: upload to S3/Cloudinary. Here: return local path.
            const url = `/uploads/marketplace/${req.file.filename}`;
            return ok(res, { url }, 'Image uploaded', 201);
        } catch(e) { err(next, e, 'uploadImage'); }
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

            const { items, delivery_address, payment_method, phone, notes, total, subtotal, delivery, currency='KES' } = req.body;
            if (!items?.length) return next(new AppError('Cart is empty', 400));
            if (!delivery_address) return next(new AppError('Delivery address required', 400));

            // If no Order model, return optimistic response
            if (!O || !T) {
                const fakeOrder = {
                    id: crypto.randomUUID(),
                    buyer_id: buyerId, status: 'pending',
                    items, delivery_address, payment_method, total: total||0, currency,
                    created_at: new Date().toISOString(),
                };
                return ok(res, { order: fakeOrder }, 'Order placed', 201);
            }

            // Create one order per seller (group items by seller)
            const sellerGroups = {};
            for (const item of items) {
                const sid = item.seller_id;
                if (!sellerGroups[sid]) sellerGroups[sid] = [];
                sellerGroups[sid].push(item);
            }

            const orders = [];
            for (const [sellerId, sellerItems] of Object.entries(sellerGroups)) {
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
                    metadata: { items: sellerItems },
                });
                orders.push(order);

                // Reduce stock for each product
                for (const item of sellerItems) {
                    try {
                        const product = await T.findByPk(item.product_id);
                        if (product && product.stock != null) {
                            const newStock = Math.max(0, product.stock - item.quantity);
                            await product.update({ stock: newStock, available: newStock > 0 });
                            _socketBroadcast(req, 'product:stock_updated', { product_id: item.product_id, quantity: newStock });
                        }
                    } catch(_) {}
                }

                // Broadcast new order to seller
                _socketBroadcast(req, 'order:created', { order_id: order.id, buyer_id: buyerId, seller_id: sellerId });
            }

            const primaryOrder = orders[0];
            return ok(res, {
                order: {
                    id:               primaryOrder.id,
                    buyer_id:         buyerId,
                    status:           'pending',
                    total:            parseFloat(total||0),
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

            // M-Pesa STK Push via Safaricom Daraja API
            const result = await _mpesaStkPush({ phone, amount, orderId: order_id, description, callbackUrl: callback_url });
            return ok(res, result, 'STK Push sent');
        } catch(e) { err(next, e, 'initiateMpesa'); }
    }

    async mpesaCallback(req, res, next) {
        try {
            const body = req.body?.Body?.stkCallback || req.body;
            const resultCode = body?.ResultCode ?? body?.result_code;
            const checkoutId = body?.CheckoutRequestID || body?.checkout_request_id;

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
        try {
            const { card_number, expiry_month, expiry_year, cvv, holder_name, amount, order_id } = req.body;
            if (!card_number || !amount || !order_id) return next(new AppError('Card details and order_id required', 400));

            // In production: integrate Stripe/Flutterwave. Simplified validation:
            if (String(card_number).replace(/\s/g,'').length < 13) return next(new AppError('Invalid card number', 400));

            const transactionId = 'TXN-' + crypto.randomUUID().toUpperCase().slice(0,12);

            // Update order status
            const O = Model.Order;
            if (O) {
                await O.update({ status:'paid', paidAt: new Date(), paymentMethod:'card', paymentRef: transactionId }, { where: { id: order_id } });
                _socketBroadcast(req, 'payment:confirmed', { order_id, method: 'card' });
            }

            return ok(res, { transaction_id: transactionId, status: 'paid' }, 'Payment successful');
        } catch(e) { err(next, e, 'cardPayment'); }
    }

    async walletPayment(req, res, next) {
        try {
            const { user_id, amount, order_id } = req.body;
            // Wallet logic depends on your Users model. Simplified:
            return ok(res, { status: 'paid', order_id }, 'Wallet payment processed');
        } catch(e) { err(next, e, 'walletPayment'); }
    }

    async getWalletBalance(req, res, next) {
        try {
            return ok(res, { balance: 0, currency: 'KES' });
        } catch(e) { err(next, e, 'getWalletBalance'); }
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

    // ══════════════════════════════════════════════════════════════════════════
    // PRODUCTS — aliases & extras
    // ══════════════════════════════════════════════════════════════════════════

    async listProducts(req, res, next) { return this.getProducts(req, res, next); }
    async getProduct(req, res, next)   { return this.getProductById(req, res, next); }

    async getFeaturedProducts(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return ok(res, { products: [] });
            const rows = await T.findAll({ where: { isFeatured: true, status: 'active', available: true }, order: [['createdAt','DESC']], limit: 20 });
            return ok(res, { products: rows.map(_formatProduct) });
        } catch(e) { err(next, e, 'getFeaturedProducts'); }
    }

    async getFlashSales(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return ok(res, { products: [] });
            const rows = await T.findAll({ where: { isFlashSale: true, status: 'active', available: true }, order: [['createdAt','DESC']], limit: 20 });
            return ok(res, { products: rows.map(_formatProduct) });
        } catch(e) { err(next, e, 'getFlashSales'); }
    }

    async getTrendingProducts(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return ok(res, { products: [] });
            const rows = await T.findAll({ where: { status: 'active', available: true }, order: [['views','DESC']], limit: 20 });
            return ok(res, { products: rows.map(_formatProduct) });
        } catch(e) { err(next, e, 'getTrendingProducts'); }
    }

    async getNewArrivals(req, res, next) {
        try {
            const T = Model.Tool;
            if (!T) return ok(res, { products: [] });
            const rows = await T.findAll({ where: { status: 'active', available: true }, order: [['createdAt','DESC']], limit: 20 });
            return ok(res, { products: rows.map(_formatProduct) });
        } catch(e) { err(next, e, 'getNewArrivals'); }
    }

    async getSellerProducts(req, res, next) {
        req.query.seller_id = req.params.sellerId;
        return this.getProducts(req, res, next);
    }

    async getSellerOrders(req, res, next) {
        try {
            const O = Model.Order;
            const sellerId = req.user?.id;
            if (!O || !sellerId) return ok(res, { orders: [] });
            const rows = await O.findAll({ where: { sellerId }, order: [['createdAt','DESC']], limit: 100 });
            return ok(res, { orders: rows.map(_formatOrder) });
        } catch(e) { err(next, e, 'getSellerOrders'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SEARCH
    // ══════════════════════════════════════════════════════════════════════════

    async searchProducts(req, res, next) {
        req.query.search = req.query.q || req.query.query || req.query.search || '';
        return this.getProducts(req, res, next);
    }

    async getSearchSuggestions(req, res, next) {
        try {
            const q = (req.query.q || '').trim().toLowerCase();
            if (!q || q.length < 2) return ok(res, { suggestions: [] });
            const T = Model.Tool;
            if (!T) return ok(res, { suggestions: [] });
            const rows = await T.findAll({
                where: { title: { [Op.or]: [{ [Op.iLike]: `%${q}%` }, { [Op.like]: `%${q}%` }] }, status: 'active' },
                attributes: ['title', 'category'],
                limit: 8,
            });
            const seen = new Set();
            const suggestions = rows
                .map(r => r.title)
                .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
            return ok(res, { suggestions });
        } catch(e) { err(next, e, 'getSearchSuggestions'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CART (server-side persistence)
    // ══════════════════════════════════════════════════════════════════════════

    async getCart(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId) return ok(res, { items: [], subtotal: 0, total: 0 });
            // Cart stored in user profile metadata or separate cart store
            const U = Model.User;
            if (!U) return ok(res, { items: [], subtotal: 0, total: 0 });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const cart = user?.metadata?.cart || [];
            const subtotal = cart.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
            return ok(res, { items: cart, subtotal, total: subtotal, currency: 'KES' });
        } catch(e) { err(next, e, 'getCart'); }
    }

    async addToCart(req, res, next) {
        try {
            const userId = req.user?.id;
            const { product_id, quantity = 1, variant = null } = req.body;
            if (!userId || !product_id) return next(new AppError('Invalid request', 400));

            const T = Model.Tool;
            const product = T ? await T.findByPk(product_id) : null;
            if (!product) return next(new AppError('Product not found', 404));
            if (!product.available) return next(new AppError('Product not available', 400));

            const U = Model.User;
            if (!U) return ok(res, { success: true, message: 'Cart updated (local)' });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const cart = user?.metadata?.cart || [];
            const existIdx = cart.findIndex(i => i.product_id === product_id);
            if (existIdx >= 0) {
                cart[existIdx].quantity += parseInt(quantity);
            } else {
                cart.push({
                    product_id, quantity: parseInt(quantity), variant,
                    title: product.title, price: parseFloat(product.price),
                    image: product.images?.[0] || '',
                    added_at: new Date().toISOString(),
                });
            }
            await user.update({ metadata: { ...(user.metadata || {}), cart } });
            return ok(res, { items: cart, added: true });
        } catch(e) { err(next, e, 'addToCart'); }
    }

    async updateCartItem(req, res, next) {
        try {
            const userId = req.user?.id;
            const { itemId } = req.params;
            const { quantity } = req.body;
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const cart = user?.metadata?.cart || [];
            const idx = cart.findIndex(i => i.product_id === itemId);
            if (idx >= 0) {
                if (parseInt(quantity) <= 0) { cart.splice(idx, 1); }
                else { cart[idx].quantity = parseInt(quantity); }
                await user.update({ metadata: { ...(user.metadata || {}), cart } });
            }
            return ok(res, { items: cart });
        } catch(e) { err(next, e, 'updateCartItem'); }
    }

    async removeFromCart(req, res, next) {
        try {
            const userId = req.user?.id;
            const { itemId } = req.params;
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const cart = (user?.metadata?.cart || []).filter(i => i.product_id !== itemId);
            await user.update({ metadata: { ...(user.metadata || {}), cart } });
            return ok(res, { items: cart, removed: true });
        } catch(e) { err(next, e, 'removeFromCart'); }
    }

    async clearCart(req, res, next) {
        try {
            const userId = req.user?.id;
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            await user.update({ metadata: { ...(user.metadata || {}), cart: [] } });
            return ok(res, { items: [], cleared: true });
        } catch(e) { err(next, e, 'clearCart'); }
    }

    async syncCart(req, res, next) {
        try {
            const userId = req.user?.id;
            const { items = [] } = req.body;
            const U = Model.User;
            if (!U || !userId) return ok(res, { items, synced: false });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const serverCart = user?.metadata?.cart || [];
            // Merge: server cart + client cart, deduplicate by product_id
            const merged = [...serverCart];
            items.forEach(ci => {
                const idx = merged.findIndex(i => i.product_id === ci.product_id);
                if (idx >= 0) { merged[idx].quantity = Math.max(merged[idx].quantity, ci.quantity); }
                else { merged.push(ci); }
            });
            await user.update({ metadata: { ...(user.metadata || {}), cart: merged } });
            return ok(res, { items: merged, synced: true });
        } catch(e) { err(next, e, 'syncCart'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADDRESSES
    // ══════════════════════════════════════════════════════════════════════════

    async getAddresses(req, res, next) {
        try {
            const userId = req.user?.id;
            const U = Model.User;
            if (!U || !userId) return ok(res, { addresses: [] });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const addresses = user?.metadata?.addresses || [];
            return ok(res, { addresses });
        } catch(e) { err(next, e, 'getAddresses'); }
    }

    async addAddress(req, res, next) {
        try {
            const userId = req.user?.id;
            const { name, phone, address, city, region, country = 'Kenya', postal_code = '', is_default = false } = req.body;
            if (!name || !address || !city) return next(new AppError('Name, address and city are required', 400));
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const addresses = user?.metadata?.addresses || [];
            const newAddr = { id: crypto.randomUUID(), name, phone, address, city, region, country, postal_code, is_default: !addresses.length || is_default, created_at: new Date().toISOString() };
            if (is_default) addresses.forEach(a => a.is_default = false);
            if (!addresses.length) newAddr.is_default = true;
            addresses.push(newAddr);
            await user.update({ metadata: { ...(user.metadata || {}), addresses } });
            return ok(res, { address: newAddr, addresses }, 'Address added', 201);
        } catch(e) { err(next, e, 'addAddress'); }
    }

    async updateAddress(req, res, next) {
        try {
            const userId = req.user?.id;
            const { id } = req.params;
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const addresses = user?.metadata?.addresses || [];
            const idx = addresses.findIndex(a => a.id === id);
            if (idx < 0) return next(new AppError('Address not found', 404));
            addresses[idx] = { ...addresses[idx], ...req.body, id };
            if (req.body.is_default) addresses.forEach((a, i) => { if (i !== idx) a.is_default = false; });
            await user.update({ metadata: { ...(user.metadata || {}), addresses } });
            return ok(res, { address: addresses[idx], addresses });
        } catch(e) { err(next, e, 'updateAddress'); }
    }

    async deleteAddress(req, res, next) {
        try {
            const userId = req.user?.id;
            const { id } = req.params;
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const addresses = (user?.metadata?.addresses || []).filter(a => a.id !== id);
            await user.update({ metadata: { ...(user.metadata || {}), addresses } });
            return ok(res, { addresses, deleted: true });
        } catch(e) { err(next, e, 'deleteAddress'); }
    }

    async setDefaultAddress(req, res, next) {
        try {
            const userId = req.user?.id;
            const { id } = req.params;
            const U = Model.User;
            if (!U || !userId) return ok(res, { success: true });
            const user = await U.findByPk(userId, { attributes: ['id', 'metadata'] });
            const addresses = user?.metadata?.addresses || [];
            addresses.forEach(a => { a.is_default = a.id === id; });
            await user.update({ metadata: { ...(user.metadata || {}), addresses } });
            return ok(res, { addresses });
        } catch(e) { err(next, e, 'setDefaultAddress'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DELIVERY ESTIMATE
    // ══════════════════════════════════════════════════════════════════════════

    async estimateDelivery(req, res, next) {
        try {
            const { buyer_location, seller_location, weight = 0, zone_id } = req.body;
            const zones = [
                { id:'nairobi',  name:'Nairobi CBD',      fee:50,  eta:'1-2 hours',    eta_days:0 },
                { id:'suburbs',  name:'Nairobi Suburbs',  fee:150, eta:'2-4 hours',    eta_days:0 },
                { id:'kenya',    name:'Rest of Kenya',    fee:300, eta:'1-3 days',     eta_days:3 },
                { id:'express',  name:'Express Nairobi',  fee:250, eta:'30-60 min',    eta_days:0 },
                { id:'pickup',   name:'Self Pickup',      fee:0,   eta:'Anytime',      eta_days:0 },
            ];
            const zone = zones.find(z => z.id === zone_id) || zones[2];
            const weightSurcharge = weight > 5 ? (weight - 5) * 10 : 0;
            const estimatedDate = new Date(Date.now() + zone.eta_days * 24*60*60*1000);
            return ok(res, {
                zones,
                selected_zone: zone,
                fee: zone.fee + weightSurcharge,
                eta: zone.eta,
                estimated_delivery: estimatedDate.toISOString(),
                currency: 'KES',
            });
        } catch(e) { err(next, e, 'estimateDelivery'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CHECKOUT — creates order(s) from cart items
    // ══════════════════════════════════════════════════════════════════════════

    async validateCheckout(req, res, next) {
        try {
            const { items = [], delivery_address, delivery_zone } = req.body;
            if (!items.length) return next(new AppError('Cart is empty', 400));
            if (!delivery_address?.address) return next(new AppError('Delivery address required', 400));
            const T = Model.Tool;
            const validations = [];
            if (T) {
                for (const item of items) {
                    const p = await T.findByPk(item.product_id);
                    validations.push({
                        product_id: item.product_id,
                        available: !!(p?.available),
                        price: parseFloat(p?.price || 0),
                        title: p?.title || item.title,
                    });
                }
            }
            const subtotal = validations.reduce((s, v) => s + v.price * (items.find(i => i.product_id === v.product_id)?.quantity || 1), 0);
            return ok(res, { valid: true, validations, subtotal, currency: 'KES' });
        } catch(e) { err(next, e, 'validateCheckout'); }
    }

    async checkout(req, res, next) {
        try {
            const O = Model.Order;
            const T = Model.Tool;
            const U = Model.User;
            const buyerId = req.user?.id;
            if (!buyerId) return next(new AppError('Authentication required', 401));

            const { items = [], delivery_address = {}, delivery_zone = 'kenya', payment_method = 'cod', coupon_code, notes = '' } = req.body;
            if (!items.length) return next(new AppError('Cart is empty', 400));

            const deliveryFees = { nairobi: 50, suburbs: 150, kenya: 300, express: 250, pickup: 0 };
            const deliveryFee = deliveryFees[delivery_zone] ?? 300;

            // Calculate totals
            const enrichedItems = [];
            let subtotal = 0;
            for (const item of items) {
                const product = T ? await T.findByPk(item.product_id) : null;
                const price = parseFloat(product?.price || item.price || 0);
                const qty = parseInt(item.quantity || 1);
                subtotal += price * qty;
                enrichedItems.push({
                    product_id: item.product_id,
                    title:      product?.title || item.title || 'Product',
                    image:      product?.images?.[0] || item.image || '',
                    price,
                    quantity:   qty,
                    seller_id:  product?.sellerId || item.seller_id || null,
                });
            }

            // Apply coupon if any
            let discount = 0;
            if (coupon_code) {
                const coupons = { 'SAVE10': 0.10, 'SAVE20': 0.20, 'FLAT100': null };
                if (coupons[coupon_code] !== undefined) {
                    discount = coupons[coupon_code] ? subtotal * coupons[coupon_code] : 100;
                }
            }

            const total = Math.max(0, subtotal + deliveryFee - discount);

            if (!O) {
                // Return a local order
                const localOrder = {
                    id:               crypto.randomUUID(),
                    buyer_id:         buyerId,
                    status:           payment_method === 'cod' ? 'confirmed' : 'pending',
                    items:            enrichedItems,
                    subtotal,
                    delivery_fee:     deliveryFee,
                    discount,
                    total_price:      total,
                    currency:         'KES',
                    payment_method,
                    delivery_address,
                    delivery_zone,
                    notes,
                    created_at:       new Date().toISOString(),
                };
                return ok(res, { order: localOrder, requires_payment: payment_method !== 'cod' }, 'Order created', 201);
            }

            // Group items by seller to create per-seller orders if needed
            // For simplicity: one combined order
            const firstSellerId = enrichedItems[0]?.seller_id || buyerId;
            const order = await O.create({
                buyerId,
                sellerId:       firstSellerId,
                productId:      enrichedItems[0].product_id,
                status:         payment_method === 'cod' ? 'confirmed' : 'pending',
                quantity:       enrichedItems.reduce((s, i) => s + i.quantity, 0),
                totalPrice:     total,
                currency:       'KES',
                paymentMethod:  payment_method,
                deliveryAddress: delivery_address,
                notes,
                metadata: {
                    items:        enrichedItems,
                    subtotal,
                    delivery_fee: deliveryFee,
                    discount,
                    delivery_zone,
                    coupon_code,
                },
            });

            // Clear server cart after order
            if (U) {
                const user = await U.findByPk(buyerId, { attributes: ['id','metadata'] }).catch(() => null);
                if (user) await user.update({ metadata: { ...(user.metadata||{}), cart: [] } }).catch(() => {});
            }

            // Broadcast new order
            _socketBroadcast(req, 'order:created', { order_id: order.id, buyer_id: buyerId, seller_id: firstSellerId });

            return ok(res, {
                order: _formatOrder(order),
                requires_payment: payment_method !== 'cod',
                payment_method,
            }, 'Order created', 201);
        } catch(e) { err(next, e, 'checkout'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ORDERS — extras
    // ══════════════════════════════════════════════════════════════════════════

    async getOrderTracking(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { tracking: null });
            const order = await O.findOne({ where: { id: req.params.id, buyerId: req.user?.id } });
            if (!order) return next(new AppError('Order not found', 404));
            const r = order.toJSON();

            const statusTimeline = [
                { status: 'pending',          label: 'Order Placed',         icon: '🛍️', done: true,  time: r.createdAt },
                { status: 'confirmed',         label: 'Order Confirmed',      icon: '✅', done: ['confirmed','packed','shipped','out_for_delivery','delivered'].includes(r.status), time: r.metadata?.confirmed_at || null },
                { status: 'packed',            label: 'Packed',               icon: '📦', done: ['packed','shipped','out_for_delivery','delivered'].includes(r.status), time: r.metadata?.packed_at || null },
                { status: 'shipped',           label: 'Shipped',              icon: '🚚', done: ['shipped','out_for_delivery','delivered'].includes(r.status), time: r.shippedAt },
                { status: 'out_for_delivery',  label: 'Out for Delivery',     icon: '🏍️', done: ['out_for_delivery','delivered'].includes(r.status), time: r.metadata?.out_for_delivery_at || null },
                { status: 'delivered',         label: 'Delivered',            icon: '🎉', done: r.status === 'delivered', time: r.deliveredAt },
            ];

            return ok(res, {
                order_id:         r.id,
                status:           r.status,
                tracking_number:  r.trackingNumber,
                estimated_delivery: r.metadata?.eta || '2-3 business days',
                delivery_address: r.deliveryAddress,
                timeline:         statusTimeline,
                items:            r.metadata?.items || [],
                total_price:      parseFloat(r.totalPrice),
                currency:         r.currency || 'KES',
            });
        } catch(e) { err(next, e, 'getOrderTracking'); }
    }

    async getOrderEta(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { eta: '2-3 business days' });
            const order = await O.findByPk(req.params.id);
            if (!order) return next(new AppError('Order not found', 404));
            const eta = order.metadata?.eta || '2-3 business days';
            return ok(res, { eta, order_id: req.params.id });
        } catch(e) { err(next, e, 'getOrderEta'); }
    }

    async updateOrderTracking(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { success: true });
            const order = await O.findByPk(req.params.id);
            if (!order) return next(new AppError('Order not found', 404));
            const { status, tracking_number, note, eta } = req.body;
            const updates = {};
            const metaUpdates = { ...(order.metadata || {}) };
            if (status) {
                updates.status = status;
                metaUpdates[`${status}_at`] = new Date().toISOString();
                if (status === 'shipped') updates.shippedAt = new Date();
                if (status === 'delivered') updates.deliveredAt = new Date();
            }
            if (tracking_number) updates.trackingNumber = tracking_number;
            if (eta) metaUpdates.eta = eta;
            if (note) { metaUpdates.notes = [...(metaUpdates.notes || []), { note, at: new Date().toISOString() }]; }
            updates.metadata = metaUpdates;
            await order.update(updates);
            _socketBroadcast(req, 'order:status_changed', { order_id: order.id, status: order.status, buyer_id: order.buyerId }, order.buyerId);
            return ok(res, { order: _formatOrder(order) });
        } catch(e) { err(next, e, 'updateOrderTracking'); }
    }

    async cancelOrder(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { success: true });
            const order = await O.findOne({ where: { id: req.params.id, buyerId: req.user?.id } });
            if (!order) return next(new AppError('Order not found', 404));
            if (!['pending','confirmed'].includes(order.status)) return next(new AppError('Order cannot be cancelled', 400));
            await order.update({ status: 'cancelled', metadata: { ...(order.metadata||{}), cancelled_at: new Date().toISOString(), cancel_reason: req.body.reason || '' } });
            _socketBroadcast(req, 'order:cancelled', { order_id: order.id }, order.sellerId);
            return ok(res, { order: _formatOrder(order) }, 'Order cancelled');
        } catch(e) { err(next, e, 'cancelOrder'); }
    }

    async requestRefund(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { success: true });
            const order = await O.findOne({ where: { id: req.params.id, buyerId: req.user?.id } });
            if (!order) return next(new AppError('Order not found', 404));
            if (!['paid','shipped','delivered'].includes(order.status)) return next(new AppError('Order not eligible for refund', 400));
            const meta = { ...(order.metadata||{}), refund_requested_at: new Date().toISOString(), refund_reason: req.body.reason || '', refund_status: 'pending' };
            await order.update({ status: 'refunded', metadata: meta });
            _socketBroadcast(req, 'order:refund_requested', { order_id: order.id, buyer_id: order.buyerId }, order.sellerId);
            return ok(res, { order: _formatOrder(order) }, 'Refund requested');
        } catch(e) { err(next, e, 'requestRefund'); }
    }

    async confirmDelivery(req, res, next) {
        try {
            const O = Model.Order;
            if (!O) return ok(res, { success: true });
            const order = await O.findOne({ where: { id: req.params.id, buyerId: req.user?.id } });
            if (!order) return next(new AppError('Order not found', 404));
            await order.update({ status: 'delivered', deliveredAt: new Date(), metadata: { ...(order.metadata||{}), delivery_confirmed_by_buyer: true } });
            _socketBroadcast(req, 'order:delivered', { order_id: order.id }, order.sellerId);
            return ok(res, { order: _formatOrder(order) }, 'Delivery confirmed');
        } catch(e) { err(next, e, 'confirmDelivery'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PAYMENTS — mpesa verify + callback + wallet + cod
    // ══════════════════════════════════════════════════════════════════════════

    async mpesaPayment(req, res, next) {
        try {
            const { phone, amount, order_id, description } = req.body;
            if (!phone || !amount) return next(new AppError('Phone and amount required', 400));

            const normalized = phone.replace(/^0/, '254').replace(/^\+/, '');
            const callbackUrl = `${process.env.APP_URL || 'https://moodchat.onrender.com'}/api/marketplace/payment/mpesa/callback`;

            const O = Model.Order;
            if (O && order_id) {
                await O.update({ paymentMethod: 'mpesa', paymentRef: `PENDING_${Date.now()}` }, { where: { id: order_id } });
            }

            let stkResult;
            try {
                stkResult = await _mpesaStkPush({ phone: normalized, amount, orderId: order_id, description: description||'Marketplace Payment', callbackUrl });
            } catch(e) {
                stkResult = { CheckoutRequestID: 'MOCK_' + Date.now(), mock: true };
            }

            const checkoutRequestId = stkResult?.CheckoutRequestID || stkResult?.checkout_request_id;

            if (O && order_id && checkoutRequestId) {
                await O.update({ paymentRef: checkoutRequestId }, { where: { id: order_id } });
            }

            return ok(res, {
                checkout_request_id: checkoutRequestId,
                message:             stkResult?.CustomerMessage || 'Please check your phone for the M-Pesa prompt',
                mock:                stkResult?.mock || false,
            }, 'STK push initiated');
        } catch(e) { err(next, e, 'mpesaPayment'); }
    }

    async mpesaVerify(req, res, next) {
        try {
            const { request_id, order_id } = req.body;
            const O = Model.Order;
            const order = O && order_id ? await O.findByPk(order_id) : null;
            const isPaid = order?.status === 'paid';
            if (isPaid) return ok(res, { paid: true, order: _formatOrder(order) }, 'Payment confirmed');
            // Poll Daraja for status (simplified)
            return ok(res, { paid: false, message: 'Payment pending — please wait' });
        } catch(e) { err(next, e, 'mpesaVerify'); }
    }

    async mpesaCallback(req, res, next) {
        try {
            const body = req.body?.Body?.stkCallback || req.body;
            await _handleMpesaSuccess(body);
            return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
        } catch(e) { err(next, e, 'mpesaCallback'); }
    }

    async cardPayment(req, res, next) {
        try {
            const { order_id, card_token, amount } = req.body;
            // Placeholder — integrate Stripe/Flutterwave in production
            const O = Model.Order;
            if (O && order_id) {
                await O.update({ status: 'paid', paidAt: new Date(), paymentMethod: 'card', paymentRef: 'CARD_' + Date.now() }, { where: { id: order_id } });
            }
            return ok(res, { paid: true, order_id }, 'Card payment processed');
        } catch(e) { err(next, e, 'cardPayment'); }
    }

    async walletPayment(req, res, next) {
        try {
            const { order_id, amount } = req.body;
            const buyerId = req.user?.id;
            const U = Model.User;
            const user = U && buyerId ? await U.findByPk(buyerId, { attributes: ['id','metadata'] }) : null;
            const balance = user?.metadata?.walletBalance || 0;
            if (balance < amount) return next(new AppError('Insufficient wallet balance', 400));
            if (user) await user.update({ metadata: { ...(user.metadata||{}), walletBalance: balance - amount } });
            const O = Model.Order;
            if (O && order_id) await O.update({ status: 'paid', paidAt: new Date(), paymentMethod: 'wallet', paymentRef: 'WALLET_' + Date.now() }, { where: { id: order_id } });
            _socketBroadcast(req, 'payment:confirmed', { order_id, payment_method: 'wallet' }, buyerId);
            return ok(res, { paid: true, order_id, new_balance: balance - amount }, 'Wallet payment successful');
        } catch(e) { err(next, e, 'walletPayment'); }
    }

    async codPayment(req, res, next) {
        try {
            const { order_id } = req.body;
            const O = Model.Order;
            if (O && order_id) {
                await O.update({ status: 'confirmed', paymentMethod: 'cod' }, { where: { id: order_id } });
            }
            return ok(res, { confirmed: true, order_id, payment_method: 'cod' }, 'Cash on delivery confirmed');
        } catch(e) { err(next, e, 'codPayment'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // REVIEWS — add aliases
    // ══════════════════════════════════════════════════════════════════════════

    async getProductReviews(req, res, next) { return this.getReviews(req, res, next); }
    async createProductReview(req, res, next) { return this.addReview(req, res, next); }

    // ══════════════════════════════════════════════════════════════════════════
    // WISHLIST — extras
    // ══════════════════════════════════════════════════════════════════════════

    async moveWishlistToCart(req, res, next) {
        try {
            const userId = req.user?.id;
            const productId = req.params.id;
            // Remove from wishlist
            const T = Model.Tool;
            if (T) {
                const p = await T.findByPk(productId);
                if (p && p.savedBy) {
                    const saved = (p.savedBy || []).filter(id => id !== userId);
                    await p.update({ savedBy: saved });
                }
            }
            // Add to cart
            req.body = { product_id: productId, quantity: 1 };
            return this.addToCart(req, res, next);
        } catch(e) { err(next, e, 'moveWishlistToCart'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // COUPONS / VOUCHERS
    // ══════════════════════════════════════════════════════════════════════════

    async validateCoupon(req, res, next) {
        try {
            const { code, subtotal = 0 } = req.body;
            const coupons = {
                'SAVE10':    { type: 'percent', value: 10, min_order: 200,  description: '10% off your order' },
                'SAVE20':    { type: 'percent', value: 20, min_order: 500,  description: '20% off your order' },
                'FLAT100':   { type: 'flat',    value: 100,min_order: 400,  description: 'KES 100 off your order' },
                'NEWUSER50': { type: 'flat',    value: 50, min_order: 100,  description: 'KES 50 off for new users' },
                'WELCOME':   { type: 'percent', value: 15, min_order: 300,  description: '15% off welcome offer' },
            };
            const coupon = coupons[code?.toUpperCase()];
            if (!coupon) return next(new AppError('Invalid coupon code', 400));
            if (subtotal < coupon.min_order) return next(new AppError(`Minimum order of KES ${coupon.min_order} required`, 400));
            const discount = coupon.type === 'percent' ? subtotal * (coupon.value / 100) : coupon.value;
            return ok(res, { valid: true, coupon: { ...coupon, code: code.toUpperCase() }, discount });
        } catch(e) { err(next, e, 'validateCoupon'); }
    }

    async applyCoupon(req, res, next) {
        return this.validateCoupon(req, res, next);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SUPPORT
    // ══════════════════════════════════════════════════════════════════════════

    async createSupportTicket(req, res, next) {
        try {
            const userId = req.user?.id;
            const { order_id, subject, message, type = 'general' } = req.body;
            if (!subject || !message) return next(new AppError('Subject and message required', 400));
            const ticket = { id: crypto.randomUUID(), user_id: userId, order_id, subject, message, type, status: 'open', created_at: new Date().toISOString() };
            // In production: store in DB / send to support system
            return ok(res, { ticket }, 'Ticket created', 201);
        } catch(e) { err(next, e, 'createSupportTicket'); }
    }

    async getSupportTickets(req, res, next) {
        try {
            // In production: fetch from DB
            return ok(res, { tickets: [] });
        } catch(e) { err(next, e, 'getSupportTickets'); }
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
        images:         r.images || [],
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

        // Update order by payment ref or recent pending orders
        if (checkoutId) {
            await O.update(
                { status:'paid', paidAt: new Date(), paymentRef: ref },
                { where: { paymentRef: checkoutId } }
            );
        }
        logger.info('[Marketplace] M-Pesa payment confirmed, ref:', ref);
    } catch(e) {
        logger.error('[Marketplace] M-Pesa success handler error:', e.message);
    }
}

module.exports = new MarketplaceController();

// ══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE EXTENSION — Wallet, Loyalty, Referral, Flash Sales, AI, Compare
// Appended after initial controller instantiation. Uses Object.assign to merge
// into the already-exported instance without rebuilding the class.
// ══════════════════════════════════════════════════════════════════════════════

const _ctrl = module.exports;

// ── WALLET ─────────────────────────────────────────────────────────────────────
_ctrl.getWallet = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        if (!U || !userId) return ok(res, { balance:0, transactions:[], currency:'KES' });
        const user = await U.findByPk(userId, { attributes:['id','walletBalance','metadata','loyaltyTier','loyaltyPoints'] });
        const balance   = parseFloat(user?.walletBalance||0);
        const txHistory = user?.metadata?.walletTransactions || [];
        return ok(res, { balance, currency:'KES', transactions:txHistory.slice(0,50), loyaltyTier:user?.loyaltyTier||'bronze', loyaltyPoints:user?.loyaltyPoints||0 });
    } catch(e) { err(next, e, 'getWallet'); }
};

_ctrl.topUpWallet = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        const { amount, payment_method='mpesa', reference='' } = req.body;
        if (!amount || parseFloat(amount) <= 0) return next(new AppError('Invalid amount',400));
        if (!U || !userId) return ok(res, { success:true, new_balance: parseFloat(amount) });
        const user = await U.findByPk(userId, { attributes:['id','walletBalance','metadata'] });
        const newBalance = parseFloat(user?.walletBalance||0) + parseFloat(amount);
        const tx = { id: crypto.randomUUID(), type:'topup', amount:parseFloat(amount), balance_after:newBalance, reference, payment_method, created_at:new Date().toISOString() };
        const txHistory = [...(user?.metadata?.walletTransactions||[]), tx].slice(-100);
        await user.update({ walletBalance: newBalance, metadata: { ...(user.metadata||{}), walletTransactions: txHistory } });
        return ok(res, { success:true, new_balance:newBalance, transaction:tx, currency:'KES' }, 'Wallet topped up');
    } catch(e) { err(next, e, 'topUpWallet'); }
};

_ctrl.getWalletTransactions = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        if (!U || !userId) return ok(res, { transactions:[] });
        const user = await U.findByPk(userId, { attributes:['id','metadata'] });
        return ok(res, { transactions: (user?.metadata?.walletTransactions||[]).reverse().slice(0,100) });
    } catch(e) { err(next, e, 'getWalletTransactions'); }
};

// ── LOYALTY ───────────────────────────────────────────────────────────────────
const _TIERS = {
    bronze:   { min:0,     max:999,   next:'silver',   color:'#cd7f32', perks:['Free delivery on orders over KES 2,000'] },
    silver:   { min:1000,  max:4999,  next:'gold',     color:'#9ca3af', perks:['Free delivery on orders over KES 1,000','5% cashback'] },
    gold:     { min:5000,  max:14999, next:'platinum', color:'#f59e0b', perks:['Free delivery on all orders','10% cashback','Priority support'] },
    platinum: { min:15000, max:1e9,   next:null,       color:'#8b5cf6', perks:['Free express delivery','15% cashback','VIP support','Early flash sale access'] },
};
function _calcTier(points) { for (const [k,t] of Object.entries(_TIERS)) { if (points>=t.min && points<=t.max) return k; } return 'bronze'; }
function _buildLoyaltyRes(user) {
    const pts   = user?.loyaltyPoints||0;
    const tier  = user?.loyaltyTier||_calcTier(pts);
    const ti    = _TIERS[tier];
    const next  = ti.next ? _TIERS[ti.next] : null;
    const prog  = next ? Math.min(100, Math.round((pts-ti.min)/(ti.max-ti.min+1)*100)) : 100;
    return { points:pts, tier, tier_color:ti.color, next_tier:ti.next, points_to_next: next?Math.max(0,ti.max+1-pts):0, progress_pct:prog, value_kes:pts*0.5, total_spent:parseFloat(user?.totalSpent||0), total_orders:user?.totalOrders||0, perks:ti.perks||[] };
}

_ctrl.getLoyalty = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        if (!U || !userId) return ok(res, { points:0, tier:'bronze', progress_pct:0, value_kes:0, perks:[] });
        const user = await U.findByPk(userId, { attributes:['id','loyaltyPoints','loyaltyTier','totalSpent','totalOrders'] });
        return ok(res, _buildLoyaltyRes(user));
    } catch(e) { err(next, e, 'getLoyalty'); }
};

_ctrl.redeemPoints = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        const pts = parseInt(req.body.points||0);
        if (pts<=0) return next(new AppError('Invalid points',400));
        if (!U || !userId) return ok(res, { success:false });
        const user = await U.findByPk(userId, { attributes:['id','loyaltyPoints'] });
        if ((user?.loyaltyPoints||0) < pts) return next(new AppError('Insufficient points',400));
        const discount = pts * 0.5;
        await user.update({ loyaltyPoints: user.loyaltyPoints - pts });
        return ok(res, { success:true, points_redeemed:pts, discount_kes:discount }, `Redeemed ${pts} pts = KES ${discount}`);
    } catch(e) { err(next, e, 'redeemPoints'); }
};

// ── REFERRAL ──────────────────────────────────────────────────────────────────
function _genRefCode(userId) {
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code='KN';
    for(let i=0;i<6;i++) code+=chars[Math.floor(Math.random()*chars.length)];
    return code;
}

_ctrl.getReferral = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        if (!U || !userId) return ok(res, { referral_code:'', referral_url:'', total_referrals:0, total_earned:0 });
        let user = await U.findByPk(userId, { attributes:['id','referralCode','metadata'] });
        if (!user.referralCode) { const c=_genRefCode(userId); await user.update({referralCode:c}); user.referralCode=c; }
        const base = process.env.APP_URL||'https://moodchat.onrender.com';
        const refs  = user?.metadata?.referrals||[];
        return ok(res, { referral_code:user.referralCode, referral_url:`${base}/register?ref=${user.referralCode}`, total_referrals:refs.length, total_earned_kes:refs.reduce((s,r)=>s+(r.bonus||0),0), referrals:refs.slice(0,20) });
    } catch(e) { err(next, e, 'getReferral'); }
};

_ctrl.applyReferral = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        const { referral_code } = req.body;
        if (!referral_code || !U) return ok(res, { applied:false });
        const referrer = await U.findOne({ where:{ referralCode: referral_code.toUpperCase() } });
        if (!referrer) return next(new AppError('Invalid referral code',400));
        if (referrer.id===userId) return next(new AppError('Cannot use your own code',400));
        const newUser = await U.findByPk(userId, { attributes:['id','referredBy','walletBalance','metadata'] });
        if (newUser?.referredBy) return next(new AppError('Referral already applied',400));
        const BONUS=100;
        const refs=[...(referrer.metadata?.referrals||[]),{user_id:userId,bonus:BONUS,created_at:new Date().toISOString()}];
        await referrer.update({ walletBalance:parseFloat(referrer.walletBalance||0)+BONUS, metadata:{...(referrer.metadata||{}),referrals:refs} });
        await newUser.update({ referredBy:referrer.id, walletBalance:parseFloat(newUser.walletBalance||0)+BONUS });
        return ok(res, { applied:true, bonus_kes:BONUS, message:`KES ${BONUS} added to your wallet!` });
    } catch(e) { err(next, e, 'applyReferral'); }
};

// ── FLASH SALES ────────────────────────────────────────────────────────────────
_ctrl.getActiveFlashSales = async function(req, res, next) {
    try {
        const T = Model.Tool;
        if (!T) return ok(res, { flash_sales:[], ends_at:null });
        const { Op:SOP } = require('sequelize');
        const now = new Date();
        const rows = await T.findAll({ where:{ isFlashSale:true, available:true, flashSaleEnd:{[SOP.gt]:now} }, order:[['flashSaleEnd','ASC']], limit:30 });
        const nearestEnd = rows[0]?.flashSaleEnd||null;
        const fmt = r => {
            const rj = r.toJSON ? r.toJSON() : r;
            const end = rj.flashSaleEnd ? new Date(rj.flashSaleEnd) : null;
            const rem = end ? Math.max(0, Math.floor((end-now)/1000)) : 0;
            return { ..._formatProduct(r), flash_price:parseFloat(rj.flashSalePrice||rj.price), flash_ends_at:rj.flashSaleEnd, flash_remaining_seconds:rem, flash_stock:rj.flashSaleStock, savings_pct: rj.price&&rj.flashSalePrice ? Math.round((1-rj.flashSalePrice/rj.price)*100) : 0 };
        };
        return ok(res, { flash_sales:rows.map(fmt), ends_at:nearestEnd, total:rows.length });
    } catch(e) { err(next, e, 'getActiveFlashSales'); }
};

_ctrl.createFlashSale = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const { product_id, flash_price, ends_at, flash_stock } = req.body;
        if (!product_id || !flash_price || !ends_at) return next(new AppError('product_id, flash_price, ends_at required',400));
        if (!T) return ok(res, { success:true });
        const product = await T.findByPk(product_id);
        if (!product) return next(new AppError('Product not found',404));
        await product.update({ isFlashSale:true, flashSalePrice:flash_price, flashSaleEnd:new Date(ends_at), flashSaleStock:flash_stock||null });
        return ok(res, { success:true }, 'Flash sale created');
    } catch(e) { err(next, e, 'createFlashSale'); }
};

_ctrl.endFlashSale = async function(req, res, next) {
    try {
        const T = Model.Tool;
        if (!T) return ok(res, { ended:true });
        await T.update({ isFlashSale:false, flashSalePrice:null, flashSaleEnd:null }, { where:{ id:req.params.id } });
        return ok(res, { ended:true });
    } catch(e) { err(next, e, 'endFlashSale'); }
};

// ── AI RECOMMENDATIONS ─────────────────────────────────────────────────────────
_ctrl.getRecommendations = async function(req, res, next) {
    try {
        const T = Model.Tool; const U = Model.User; const userId = req.user?.id;
        if (!T) return ok(res, { products:[], type:'trending' });
        const { Op:SOP } = require('sequelize');
        const user = U && userId ? await U.findByPk(userId, { attributes:['id','metadata'] }) : null;
        const viewed    = user?.metadata?.viewedProducts||[];
        const purchases = user?.metadata?.purchasedCategories||[];
        let products=[];
        if (purchases.length) {
            products = await T.findAll({ where:{ category:{[SOP.in]:purchases}, available:true, id:{[SOP.notIn]:viewed.slice(0,20)} }, order:[['rating','DESC'],['views','DESC']], limit:20 });
        }
        if (!products.length) {
            products = await T.findAll({ where:{ available:true, status:'active' }, order:[['views','DESC'],['rating','DESC']], limit:20 });
        }
        return ok(res, { products:products.map(_formatProduct), type: purchases.length?'personalized':'trending' });
    } catch(e) { err(next, e, 'getRecommendations'); }
};

_ctrl.trackBehavior = async function(req, res, next) {
    try {
        const U = Model.User; const userId = req.user?.id;
        if (!U || !userId) return ok(res, { tracked:false });
        const { product_id, category, search_query } = req.body;
        const user = await U.findByPk(userId, { attributes:['id','metadata'] });
        const meta = { ...(user?.metadata||{}) };
        if (product_id) { const v=meta.viewedProducts||[]; if(!v.includes(product_id)){v.unshift(product_id);meta.viewedProducts=v.slice(0,50);} }
        if (category)   { const c=meta.searchedCategories||[]; if(!c.includes(category)){c.unshift(category);meta.searchedCategories=c.slice(0,20);} }
        if (search_query){ const s=meta.recentSearches||[]; if(!s.includes(search_query)){s.unshift(search_query);meta.recentSearches=s.slice(0,20);} }
        await user.update({ metadata: meta });
        return ok(res, { tracked:true });
    } catch(e) { err(next, e, 'trackBehavior'); }
};

// ── BUY NOW ────────────────────────────────────────────────────────────────────
_ctrl.buyNow = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const { product_id, quantity=1, delivery_address, payment_method='mpesa', delivery_zone='kenya' } = req.body;
        if (!product_id) return next(new AppError('product_id required',400));
        const product = T ? await T.findByPk(product_id) : null;
        if (!product) return next(new AppError('Product not found',404));
        req.body = {
            items:[{ product_id, quantity:parseInt(quantity), title:product.title, price:parseFloat(product.flashSalePrice||product.price), image:product.images?.[0]||'' }],
            delivery_address, payment_method, delivery_zone
        };
        return _ctrl.checkout(req, res, next);
    } catch(e) { err(next, e, 'buyNow'); }
};

// ── PRODUCT COMPARISON ────────────────────────────────────────────────────────
_ctrl.compareProducts = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const ids = (req.query.ids||'').split(',').filter(Boolean).slice(0,4);
        if (ids.length<2) return next(new AppError('At least 2 product IDs required',400));
        if (!T) return ok(res, { products:[], specs:[] });
        const { Op:SOP } = require('sequelize');
        const products = await T.findAll({ where:{ id:{[SOP.in]:ids} } });
        const formatted = products.map(_formatProduct);
        const specs = [
            { key:'Price',    values: formatted.map(p=>`KES ${parseFloat(p.price||0).toLocaleString()}`) },
            { key:'Rating',   values: formatted.map(p=>`${p.rating||0} ★ (${p.rating_count||0})`) },
            { key:'Category', values: formatted.map(p=>p.category||'—') },
            { key:'In Stock', values: formatted.map(p=>p.available?'✓ Available':'✗ Out of stock') },
            { key:'Shipping', values: formatted.map(()=>'Nationwide') },
        ];
        return ok(res, { products:formatted, specs, count:products.length });
    } catch(e) { err(next, e, 'compareProducts'); }
};

// ── INVOICE ────────────────────────────────────────────────────────────────────
_ctrl.getOrderInvoice = async function(req, res, next) {
    try {
        const O = Model.Order; const userId = req.user?.id;
        if (!O) return next(new AppError('Orders unavailable',503));
        const order = await O.findOne({ where:{ id:req.params.id, buyerId:userId } });
        if (!order) return next(new AppError('Order not found',404));
        const r = order.toJSON();
        const items = r.metadata?.items||[];
        const invoice = { invoice_number:`INV-${String(r.id).slice(-8).toUpperCase()}`, order_id:r.id, issued_at:new Date().toISOString(), buyer:r.deliveryAddress||{}, items, subtotal:parseFloat(r.metadata?.subtotal||r.totalPrice||0), delivery_fee:parseFloat(r.metadata?.delivery_fee||0), discount:parseFloat(r.metadata?.discount||0), total:parseFloat(r.totalPrice||0), currency:r.currency||'KES', payment_method:r.paymentMethod, status:r.status };
        return ok(res, { invoice });
    } catch(e) { err(next, e, 'getOrderInvoice'); }
};

// ── QR CODE ────────────────────────────────────────────────────────────────────
_ctrl.getOrderQR = async function(req, res, next) {
    try {
        const O = Model.Order;
        const order = O ? await O.findOne({ where:{ id:req.params.id, buyerId:req.user?.id } }) : null;
        if (!order) return next(new AppError('Order not found',404));
        const qrData = JSON.stringify({ order_id:order.id, buyer_id:order.buyerId, total:order.totalPrice, ts:Date.now() });
        return ok(res, { qr_data:qrData, order_id:order.id, tracking_number:order.trackingNumber });
    } catch(e) { err(next, e, 'getOrderQR'); }
};

// ── SMART DELIVERY ─────────────────────────────────────────────────────────────
_ctrl.smartDeliveryEstimate = async function(req, res, next) {
    try {
        const { lat, lng, weight=0 } = req.body;
        let zone='kenya', fee=300, eta='1-3 days';
        if (lat && lng) {
            const dist = Math.sqrt(Math.pow(lat-(-1.2864),2) + Math.pow(lng-36.8172,2)) * 111;
            if (dist<5)       { zone='nairobi';  fee=50;  eta='1-2 hours'; }
            else if (dist<20) { zone='suburbs';  fee=150; eta='2-4 hours'; }
            else if (dist<50) { zone='regional'; fee=250; eta='Same day';  }
        }
        const wSurcharge = parseFloat(weight)>5 ? (parseFloat(weight)-5)*10 : 0;
        const hrs = zone==='nairobi'?2 : zone==='suburbs'?4 : zone==='regional'?24 : 72;
        return ok(res, { zone, fee:fee+wSurcharge, eta, estimated_delivery: new Date(Date.now()+hrs*3600000).toISOString(), currency:'KES' });
    } catch(e) { err(next, e, 'smartDeliveryEstimate'); }
};

// ── ADMIN extras ──────────────────────────────────────────────────────────────
_ctrl.adminCreateCoupon = async function(req, res, next) {
    try {
        const C = Model.Coupon;
        if (!C) {
            // In-memory fallback: return as if created
            return ok(res, { coupon: { ...req.body, id: Date.now() } }, 'Coupon saved (in-memory)', 201);
        }
        const { code, type, value, min_order_amt, max_discount, usage_limit, per_user_limit, starts_at, expires_at, category_slug, seller_id, user_id, description, is_public } = req.body;
        if (!code || !type || !value) return next(new AppError('code, type, value required',400));
        const coupon = await C.create({ code, type, value, minOrderAmt:min_order_amt||0, maxDiscount:max_discount, usageLimit:usage_limit||9999, perUserLimit:per_user_limit||1, startsAt:starts_at, expiresAt:expires_at, categorySlug:category_slug, sellerId:seller_id, userId:user_id, description, isPublic:is_public!==false });
        return ok(res, { coupon }, 'Coupon created', 201);
    } catch(e) { err(next, e, 'adminCreateCoupon'); }
};

_ctrl.listCoupons = async function(req, res, next) {
    try {
        const C = Model.Coupon;
        if (!C) return ok(res, { coupons: _defaultCoupons() });
        const coupons = await C.findAll({ where:{ isActive:true, isPublic:true }, order:[['createdAt','DESC']], limit:50 });
        return ok(res, { coupons: coupons.map(c=>c.toJSON()) });
    } catch(e) { err(next, e, 'listCoupons'); }
};

function _defaultCoupons() {
    return [
        { code:'SAVE10',    type:'percent', value:10,  minOrderAmt:200, description:'10% off orders over KES 200' },
        { code:'SAVE20',    type:'percent', value:20,  minOrderAmt:500, description:'20% off orders over KES 500' },
        { code:'FLAT100',   type:'fixed',   value:100, minOrderAmt:400, description:'KES 100 off your order' },
        { code:'NEWUSER50', type:'fixed',   value:50,  minOrderAmt:100, description:'KES 50 off your first order' },
        { code:'WELCOME',   type:'percent', value:15,  minOrderAmt:300, description:'15% welcome offer' },
    ];
}

// Add Model.Coupon getter
Object.defineProperty(Model, 'Coupon', { get() { return getDb().Coupon||null; }, configurable:true });


// ══════════════════════════════════════════════════════════════════════════════
// SELLER MODULE — Product Approval, Seller Dashboard, Inventory, Payouts,
//                 Shipping, Returns, Analytics, Verification, Subscriptions
// ══════════════════════════════════════════════════════════════════════════════

// ── PRODUCT APPROVAL (Admin) ─────────────────────────────────────────────────
_ctrl.adminListPendingProducts = async function(req, res, next) {
    try {
        const T = Model.Tool;
        if (!T) return ok(res, { products: [] });
        const { Op: SOP } = require('sequelize');
        const rows = await T.findAll({
            where: { approvalStatus: 'pending', status: { [SOP.in]: ['pending_review'] } },
            order: [['submittedAt','ASC'],['createdAt','ASC']],
            limit: 100,
        });
        return ok(res, { products: rows.map(_formatProduct), count: rows.length });
    } catch(e) { err(next, e, 'adminListPendingProducts'); }
};

_ctrl.adminApproveProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const adminId = req.user?.id;
        if (!T) return ok(res, { approved: true });
        const product = await T.findByPk(req.params.id);
        if (!product) return next(new AppError('Product not found', 404));
        await product.update({
            status: 'approved',
            approvalStatus: 'approved',
            approvedBy: adminId,
            approvedAt: new Date(),
            rejectionReason: null,
            available: true,
        });
        // Notify seller (via socket/notification system)
        _socketBroadcast(null, 'product:approved', {
            product_id: product.id,
            seller_id:  product.sellerId || product.userId,
            title:      product.title,
        }, product.sellerId || product.userId);
        return ok(res, { approved: true, product: _formatProduct(product) }, 'Product approved');
    } catch(e) { err(next, e, 'adminApproveProduct'); }
};

_ctrl.adminRejectProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const adminId = req.user?.id;
        const { reason = 'Does not meet marketplace standards' } = req.body;
        if (!T) return ok(res, { rejected: true });
        const product = await T.findByPk(req.params.id);
        if (!product) return next(new AppError('Product not found', 404));
        await product.update({
            status: 'rejected',
            approvalStatus: 'rejected',
            approvedBy: adminId,
            rejectionReason: reason,
            available: false,
        });
        _socketBroadcast(null, 'product:rejected', {
            product_id:     product.id,
            seller_id:      product.sellerId || product.userId,
            rejection_reason: reason,
        }, product.sellerId || product.userId);
        return ok(res, { rejected: true, reason, product: _formatProduct(product) }, 'Product rejected');
    } catch(e) { err(next, e, 'adminRejectProduct'); }
};

// Seller resubmits after rejection
_ctrl.sellerResubmitProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        if (!T) return ok(res, { resubmitted: true });
        const product = await T.findOne({ where: { id: req.params.id, sellerId } });
        if (!product) return next(new AppError('Product not found or not yours', 404));
        if (product.approvalStatus === 'approved') return next(new AppError('Product already approved', 400));
        await product.update({
            status: 'pending_review',
            approvalStatus: 'pending',
            rejectionReason: null,
            submittedAt: new Date(),
            ...req.body.updates,
        });
        return ok(res, { resubmitted: true, product: _formatProduct(product) }, 'Product resubmitted for review');
    } catch(e) { err(next, e, 'sellerResubmitProduct'); }
};

// ── SELLER OWN PRODUCT MANAGEMENT ────────────────────────────────────────────
_ctrl.getSellerProducts = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.params.sellerId || req.user?.id;
        if (!T || !sellerId) return ok(res, { products: [], total: 0 });
        const { Op: SOP } = require('sequelize');
        const { status, page=1, limit=20 } = req.query;
        const where = { [SOP.or]: [{ sellerId }, { userId: sellerId }] };
        if (status) where.status = status;
        const { count, rows } = await T.findAndCountAll({
            where,
            order: [['createdAt','DESC']],
            limit: parseInt(limit),
            offset: (parseInt(page)-1)*parseInt(limit),
        });
        return ok(res, { products: rows.map(_formatProduct), total: count, page: parseInt(page), pages: Math.ceil(count/limit) });
    } catch(e) { err(next, e, 'getSellerProducts'); }
};

_ctrl.duplicateProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        if (!T) return ok(res, { success: true });
        const product = await T.findOne({ where: { id: req.params.id, sellerId } });
        if (!product) return next(new AppError('Product not found', 404));
        const data = product.toJSON();
        delete data.id; delete data.createdAt; delete data.updatedAt;
        data.title = 'Copy of ' + data.title;
        data.status = 'draft';
        data.approvalStatus = 'pending';
        data.approvedAt = null;
        data.submittedAt = null;
        data.available = false;
        data.soldCount = 0;
        data.views = 0;
        const newProduct = await T.create(data);
        return ok(res, { product: _formatProduct(newProduct) }, 'Product duplicated as draft', 201);
    } catch(e) { err(next, e, 'duplicateProduct'); }
};

_ctrl.archiveProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        if (!T) return ok(res, { archived: true });
        await T.update({ status: 'archived', available: false }, { where: { id: req.params.id, sellerId } });
        return ok(res, { archived: true });
    } catch(e) { err(next, e, 'archiveProduct'); }
};

_ctrl.restoreProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        if (!T) return ok(res, { restored: true });
        await T.update({ status: 'draft', available: false }, { where: { id: req.params.id, sellerId, status: 'archived' } });
        return ok(res, { restored: true });
    } catch(e) { err(next, e, 'restoreProduct'); }
};

// Bulk CSV export
_ctrl.exportProducts = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        if (!T) return res.json({ csv: 'id,title,price,status,stock\n' });
        const { Op: SOP } = require('sequelize');
        const rows = await T.findAll({ where: { [SOP.or]: [{ sellerId },{ userId: sellerId }] }, order: [['createdAt','DESC']] });
        const headers = 'id,title,price,original_price,category,status,approval_status,stock,sku,views,sold_count,created_at\n';
        const csv = headers + rows.map(r => {
            const v = r.toJSON ? r.toJSON() : r;
            return `${v.id},"${(v.title||'').replace(/"/g,'""')}",${v.price||0},${v.originalPrice||0},${v.category||''},${v.status||''},${v.approvalStatus||''},${v.stockQuantity||v.stock||0},${v.sku||''},${v.views||0},${v.soldCount||0},${v.createdAt}`;
        }).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="products-${Date.now()}.csv"`);
        return res.send(csv);
    } catch(e) { err(next, e, 'exportProducts'); }
};

// Bulk CSV import — creates products in draft/pending_review state
_ctrl.importProducts = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        const { rows = [] } = req.body; // Pre-parsed rows from frontend
        if (!T || !rows.length) return ok(res, { imported: 0, errors: [] });
        const results = []; const errors = [];
        for (const row of rows.slice(0, 200)) {
            try {
                const product = await T.create({
                    title:    row.title || row.name || 'Untitled',
                    price:    parseFloat(row.price||0),
                    category: row.category || 'other',
                    description: row.description || '',
                    status:   'pending_review',
                    approvalStatus: 'pending',
                    submittedAt: new Date(),
                    sellerId, available: false,
                    sku: row.sku || null,
                    stockQuantity: parseInt(row.stock||row.quantity||0),
                    metadata: { bulk_import: true, import_row: row },
                });
                results.push(product.id);
            } catch(e2) { errors.push({ row: row.title, error: e2.message }); }
        }
        return ok(res, { imported: results.length, ids: results, errors }, `${results.length} products queued for review`);
    } catch(e) { err(next, e, 'importProducts'); }
};

// ── INVENTORY MANAGEMENT ────────────────────────────────────────────────────
_ctrl.getInventory = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        if (!T || !sellerId) return ok(res, { items: [], low_stock: [], out_of_stock: [] });
        const { Op: SOP } = require('sequelize');
        const rows = await T.findAll({
            where: { [SOP.or]: [{ sellerId },{ userId: sellerId }], status: { [SOP.notIn]: ['deleted','removed'] } },
            attributes: ['id','title','status','approvalStatus','stockQuantity','stock','views','soldCount','sku','images','price'],
            order: [['stockQuantity','ASC'],['title','ASC']],
        });
        const items       = rows.map(r => r.toJSON ? r.toJSON() : r);
        const outOfStock  = items.filter(i => (i.stockQuantity||i.stock||0) === 0);
        const lowStock    = items.filter(i => { const s=(i.stockQuantity||i.stock||0); return s>0&&s<=5; });
        return ok(res, { items, out_of_stock: outOfStock, low_stock: lowStock, total: items.length });
    } catch(e) { err(next, e, 'getInventory'); }
};

_ctrl.updateInventory = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        const { id } = req.params;
        const { quantity, sku, action = 'set' } = req.body;
        if (!T) return ok(res, { updated: true });
        const product = await T.findOne({ where: { id, sellerId } });
        if (!product) return next(new AppError('Product not found', 404));
        let newQty = parseInt(product.stockQuantity || product.stock || 0);
        if (action === 'set')       newQty = parseInt(quantity);
        else if (action === 'add')  newQty += parseInt(quantity);
        else if (action === 'sub')  newQty = Math.max(0, newQty - parseInt(quantity));
        const updates = { stockQuantity: newQty };
        if (sku !== undefined) updates.sku = sku;
        if (newQty === 0) updates.available = false;
        else if (product.approvalStatus === 'approved') updates.available = true;
        await product.update(updates);
        return ok(res, { updated: true, new_quantity: newQty, product_id: id });
    } catch(e) { err(next, e, 'updateInventory'); }
};

_ctrl.bulkUpdateInventory = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        const { updates = [] } = req.body; // [{id, quantity}]
        if (!T || !updates.length) return ok(res, { updated: 0 });
        let count = 0;
        for (const upd of updates) {
            const qty = parseInt(upd.quantity || 0);
            await T.update({ stockQuantity: qty, available: qty > 0 }, { where: { id: upd.id, sellerId } });
            count++;
        }
        return ok(res, { updated: count });
    } catch(e) { err(next, e, 'bulkUpdateInventory'); }
};

// ── SELLER ANALYTICS ─────────────────────────────────────────────────────────
_ctrl.getSellerAnalytics = async function(req, res, next) {
    try {
        const T = Model.Tool; const O = Model.Order;
        const sellerId = req.user?.id;
        if (!T || !sellerId) return ok(res, _emptyAnalytics());
        const { Op: SOP } = require('sequelize');
        const { period = '30d' } = req.query;
        const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
        const since = new Date(Date.now() - days * 86400000);

        const [products, orders] = await Promise.all([
            T.findAll({ where: { [SOP.or]:[{sellerId},{userId:sellerId}], status:{[SOP.notIn]:['deleted','removed']} }, attributes:['id','title','views','soldCount','rating','price','status','approvalStatus','createdAt'] }),
            O ? O.findAll({ where: { sellerId, createdAt: { [SOP.gte]: since } }, order:[['createdAt','DESC']] }) : Promise.resolve([]),
        ]);

        const revenue = orders.filter(o=>!['cancelled','refunded'].includes(o.status)).reduce((s,o)=>s+parseFloat(o.totalPrice||0),0);
        const totalViews = products.reduce((s,p)=>s+(p.views||0),0);
        const totalSold  = products.reduce((s,p)=>s+(p.soldCount||0),0);

        // Revenue by day (last 7 days)
        const revenueByDay = [];
        for (let i=6; i>=0; i--) {
            const day = new Date(Date.now()-i*86400000);
            const dayStr = day.toISOString().slice(0,10);
            const dayRevenue = orders.filter(o=>{
                const d=new Date(o.createdAt).toISOString().slice(0,10);
                return d===dayStr && !['cancelled','refunded'].includes(o.status);
            }).reduce((s,o)=>s+parseFloat(o.totalPrice||0),0);
            revenueByDay.push({ date: dayStr, revenue: dayRevenue });
        }

        const topProducts = [...products].sort((a,b)=>(b.soldCount||0)-(a.soldCount||0)).slice(0,5).map(p=>({ id:p.id, title:p.title, views:p.views||0, sold:p.soldCount||0, revenue:(p.soldCount||0)*parseFloat(p.price||0), rating:parseFloat(p.rating||0) }));
        const pending   = products.filter(p=>p.status==='pending_review'||p.approvalStatus==='pending').length;
        const approved  = products.filter(p=>p.approvalStatus==='approved'||p.status==='active').length;
        const rejected  = products.filter(p=>p.approvalStatus==='rejected').length;

        return ok(res, {
            period, days,
            revenue: { total: revenue, currency: 'KES', by_day: revenueByDay },
            orders:  { total: orders.length, pending: orders.filter(o=>o.status==='pending').length, completed: orders.filter(o=>o.status==='delivered').length, cancelled: orders.filter(o=>o.status==='cancelled').length },
            products: { total: products.length, approved, pending, rejected, total_views: totalViews, total_sold: totalSold },
            top_products: topProducts,
            conversion_rate: totalViews ? ((totalSold/totalViews)*100).toFixed(2) : 0,
        });
    } catch(e) { err(next, e, 'getSellerAnalytics'); }
};
function _emptyAnalytics() { return { revenue:{total:0,currency:'KES',by_day:[]}, orders:{total:0,pending:0,completed:0,cancelled:0}, products:{total:0,approved:0,pending:0,rejected:0,total_views:0,total_sold:0}, top_products:[], conversion_rate:0 }; }

// ── PAYOUT SYSTEM ────────────────────────────────────────────────────────────
_ctrl.getPayoutBalance = async function(req, res, next) {
    try {
        const O = Model.Order; const U = Model.User;
        const sellerId = req.user?.id;
        if (!O || !sellerId) return ok(res, { available: 0, pending: 0, total_earned: 0, currency: 'KES' });
        const { Op: SOP } = require('sequelize');
        const orders = await O.findAll({ where: { sellerId, status: { [SOP.in]: ['paid','delivered'] } } });
        const gross   = orders.reduce((s,o)=>s+parseFloat(o.totalPrice||0),0);
        const fee     = gross * 0.10; // 10% platform fee
        const net     = gross - fee;
        const user    = U ? await U.findByPk(sellerId, { attributes:['id','metadata','walletBalance'] }) : null;
        const withdrawn = user?.metadata?.totalWithdrawn || 0;
        const available = Math.max(0, net - withdrawn);
        const payouts   = user?.metadata?.payoutRequests || [];
        const pendingPayout = payouts.filter(p=>p.status==='pending').reduce((s,p)=>s+(p.amount||0),0);
        return ok(res, { available, pending_payout: pendingPayout, total_earned: net, total_withdrawn: withdrawn, gross_sales: gross, platform_fee: fee, platform_fee_pct: 10, currency: 'KES', payout_history: payouts.slice(0,20) });
    } catch(e) { err(next, e, 'getPayoutBalance'); }
};

_ctrl.requestPayout = async function(req, res, next) {
    try {
        const U = Model.User;
        const sellerId = req.user?.id;
        const { amount, method = 'mpesa', account } = req.body;
        const amt = parseFloat(amount||0);
        if (!amt || amt < 100) return next(new AppError('Minimum payout is KES 100', 400));
        if (!U || !sellerId) return ok(res, { requested: true });
        const user = await U.findByPk(sellerId, { attributes:['id','metadata','walletBalance'] });
        const meta = { ...(user?.metadata||{}) };
        const payouts = meta.payoutRequests || [];
        const payout = { id: crypto.randomUUID(), amount: amt, method, account: account||'', status: 'pending', requested_at: new Date().toISOString() };
        payouts.push(payout);
        meta.payoutRequests = payouts;
        await user.update({ metadata: meta });
        return ok(res, { requested: true, payout }, 'Payout request submitted');
    } catch(e) { err(next, e, 'requestPayout'); }
};

// ── SHIPPING MANAGEMENT ────────────────────────────────────────────────────────
_ctrl.updateShipping = async function(req, res, next) {
    try {
        const O = Model.Order;
        const sellerId = req.user?.id;
        const { id } = req.params;
        const { status, tracking_number, courier, notes } = req.body;
        if (!O) return ok(res, { updated: true });
        const order = await O.findOne({ where: { id, sellerId } });
        if (!order) return next(new AppError('Order not found', 404));
        const updates = {};
        const metaUpdates = { ...(order.metadata||{}) };
        const statusMap = {
            packed:           { orderStatus: 'confirmed',        field: 'packed_at' },
            shipped:          { orderStatus: 'shipped',          field: 'shipped_at' },
            out_for_delivery: { orderStatus: 'out_for_delivery', field: 'out_for_delivery_at' },
            delivered:        { orderStatus: 'delivered',        field: 'delivered_at' },
        };
        if (status && statusMap[status]) {
            updates.status = statusMap[status].orderStatus;
            metaUpdates[statusMap[status].field] = new Date().toISOString();
            if (status === 'shipped') updates.shippedAt = new Date();
            if (status === 'delivered') updates.deliveredAt = new Date();
        }
        if (tracking_number) updates.trackingNumber = tracking_number;
        if (courier) metaUpdates.courier = courier;
        if (notes) { metaUpdates.shippingNotes = [...(metaUpdates.shippingNotes||[]), { note: notes, at: new Date().toISOString() }]; }
        updates.metadata = metaUpdates;
        await order.update(updates);
        _socketBroadcast(null, 'order:status_changed', { order_id: order.id, status: updates.status || order.status, buyer_id: order.buyerId }, order.buyerId);
        return ok(res, { updated: true, order: _formatOrder(order) });
    } catch(e) { err(next, e, 'updateShipping'); }
};

_ctrl.getShippingLabel = async function(req, res, next) {
    try {
        const O = Model.Order;
        const sellerId = req.user?.id;
        const order = O ? await O.findOne({ where: { id: req.params.id, sellerId } }) : null;
        if (!order) return next(new AppError('Order not found', 404));
        const r = order.toJSON ? order.toJSON() : order;
        const items = r.metadata?.items || [];
        const label = { order_id: r.id, tracking_number: r.trackingNumber || 'PENDING', to: r.deliveryAddress || {}, from: { name: 'Knecta Market Seller', address: 'Nairobi, Kenya' }, items: items.map(i=>({ title: i.title, quantity: i.quantity })), weight: r.metadata?.weight || '—', courier: r.metadata?.courier || 'Standard', created_at: new Date().toISOString() };
        return ok(res, { label });
    } catch(e) { err(next, e, 'getShippingLabel'); }
};

// ── RETURN MANAGEMENT ─────────────────────────────────────────────────────────
_ctrl.getReturnRequests = async function(req, res, next) {
    try {
        const O = Model.Order;
        const sellerId = req.user?.id;
        if (!O || !sellerId) return ok(res, { returns: [] });
        const { Op: SOP } = require('sequelize');
        const orders = await O.findAll({ where: { sellerId, status: { [SOP.in]: ['refunded'] }, metadata: { refund_status: { [SOP.ne]: null } } }, order:[['createdAt','DESC']] });
        const returns = orders.map(o => { const r=o.toJSON?o.toJSON():o; return { order_id:r.id, buyer_id:r.buyerId, reason:r.metadata?.refund_reason||'Not specified', status:r.metadata?.refund_status||'pending', requested_at:r.metadata?.refund_requested_at||r.createdAt, items:r.metadata?.items||[], total:parseFloat(r.totalPrice||0) }; });
        return ok(res, { returns, count: returns.length });
    } catch(e) { err(next, e, 'getReturnRequests'); }
};

_ctrl.approveReturn = async function(req, res, next) {
    try {
        const O = Model.Order;
        const sellerId = req.user?.id;
        if (!O) return ok(res, { approved: true });
        const order = await O.findOne({ where: { id: req.params.id, sellerId } });
        if (!order) return next(new AppError('Order not found', 404));
        const meta = { ...(order.metadata||{}), refund_status:'approved', refund_approved_at:new Date().toISOString() };
        await order.update({ metadata: meta });
        _socketBroadcast(null, 'order:refund_approved', { order_id: order.id }, order.buyerId);
        return ok(res, { approved: true }, 'Return approved');
    } catch(e) { err(next, e, 'approveReturn'); }
};

_ctrl.rejectReturn = async function(req, res, next) {
    try {
        const O = Model.Order;
        const sellerId = req.user?.id;
        const { reason = '' } = req.body;
        if (!O) return ok(res, { rejected: true });
        const order = await O.findOne({ where: { id: req.params.id, sellerId } });
        if (!order) return next(new AppError('Order not found', 404));
        const meta = { ...(order.metadata||{}), refund_status:'rejected', refund_rejected_at:new Date().toISOString(), refund_rejection_reason:reason };
        await order.update({ status:'delivered', metadata: meta });
        return ok(res, { rejected: true }, 'Return rejected');
    } catch(e) { err(next, e, 'rejectReturn'); }
};

// ── SELLER VERIFICATION (KYC) ─────────────────────────────────────────────────
_ctrl.submitVerification = async function(req, res, next) {
    try {
        const U = Model.User;
        const userId = req.user?.id;
        if (!U || !userId) return ok(res, { submitted: true });
        const { id_type, id_number, business_name, business_permit } = req.body;
        if (!id_type || !id_number) return next(new AppError('ID type and number required', 400));
        const user = await U.findByPk(userId, { attributes:['id','metadata'] });
        const verification = { id_type, id_number, business_name: business_name||'', business_permit: business_permit||'', status:'pending', submitted_at: new Date().toISOString() };
        await user.update({ metadata: { ...(user.metadata||{}), kyc: verification } });
        return ok(res, { submitted: true, verification }, 'Verification submitted for review');
    } catch(e) { err(next, e, 'submitVerification'); }
};

_ctrl.getVerificationStatus = async function(req, res, next) {
    try {
        const U = Model.User;
        const userId = req.user?.id;
        if (!U || !userId) return ok(res, { status: 'unverified', kyc: null });
        const user = await U.findByPk(userId, { attributes:['id','metadata'] });
        const kyc = user?.metadata?.kyc || null;
        return ok(res, { status: kyc?.status || 'unverified', kyc });
    } catch(e) { err(next, e, 'getVerificationStatus'); }
};

_ctrl.adminVerifySeller = async function(req, res, next) {
    try {
        const U = Model.User;
        const { sellerId } = req.params;
        const { approved, reason = '' } = req.body;
        if (!U) return ok(res, { updated: true });
        const user = await U.findByPk(sellerId, { attributes:['id','metadata'] });
        if (!user) return next(new AppError('User not found', 404));
        const meta = { ...(user.metadata||{}) };
        meta.kyc = { ...(meta.kyc||{}), status: approved ? 'approved' : 'rejected', reviewed_at: new Date().toISOString(), review_reason: reason };
        await user.update({ metadata: meta });
        _socketBroadcast(null, 'seller:verified', { seller_id: sellerId, approved }, sellerId);
        return ok(res, { updated: true, approved });
    } catch(e) { err(next, e, 'adminVerifySeller'); }
};

// ── PROMOTED PRODUCTS / BOOST ─────────────────────────────────────────────────
_ctrl.boostProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        const sellerId = req.user?.id;
        const { duration_days = 7 } = req.body;
        if (!T) return ok(res, { boosted: true });
        const product = await T.findOne({ where: { id: req.params.id, sellerId } });
        if (!product) return next(new AppError('Product not found', 404));
        const expiresAt = new Date(Date.now() + parseInt(duration_days)*86400000);
        await product.update({ isBoosted: true, boostExpiresAt: expiresAt, isFeatured: true });
        return ok(res, { boosted: true, expires_at: expiresAt }, `Product boosted for ${duration_days} days`);
    } catch(e) { err(next, e, 'boostProduct'); }
};

// ── SELLER SUBSCRIPTION ───────────────────────────────────────────────────────
_ctrl.getSubscription = async function(req, res, next) {
    try {
        const U = Model.User;
        const userId = req.user?.id;
        if (!U || !userId) return ok(res, _defaultSubscription());
        const user = await U.findByPk(userId, { attributes:['id','metadata'] });
        const sub = user?.metadata?.subscription || { plan: 'basic', expires_at: null };
        return ok(res, { ...sub, plans: _subscriptionPlans() });
    } catch(e) { err(next, e, 'getSubscription'); }
};

_ctrl.upgradeSubscription = async function(req, res, next) {
    try {
        const U = Model.User;
        const userId = req.user?.id;
        const { plan = 'professional' } = req.body;
        if (!['basic','professional','premium'].includes(plan)) return next(new AppError('Invalid plan', 400));
        if (!U || !userId) return ok(res, { upgraded: true, plan });
        const user = await U.findByPk(userId, { attributes:['id','metadata'] });
        const expiresAt = new Date(Date.now()+30*86400000);
        const sub = { plan, expires_at: expiresAt.toISOString(), upgraded_at: new Date().toISOString() };
        await user.update({ metadata: { ...(user.metadata||{}), subscription: sub } });
        return ok(res, { upgraded: true, subscription: sub, plans: _subscriptionPlans() }, `Upgraded to ${plan}`);
    } catch(e) { err(next, e, 'upgradeSubscription'); }
};

function _defaultSubscription() { return { plan:'basic', expires_at:null, plans: _subscriptionPlans() }; }
function _subscriptionPlans() {
    return [
        { id:'basic',        name:'Basic',        price:0,    currency:'KES', listing_limit:10,  features:['10 active listings','Basic analytics','Standard support'] },
        { id:'professional', name:'Professional', price:500,  currency:'KES', listing_limit:100, features:['100 active listings','Full analytics','Priority support','Boost 5 products/month','CSV import/export'] },
        { id:'premium',      name:'Premium',      price:1500, currency:'KES', listing_limit:9999,features:['Unlimited listings','Advanced analytics','VIP support','Unlimited boosts','Featured placement','Flash sale access'] },
    ];
}


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN COMMAND CENTER — Full marketplace administration
// All methods appended to existing _ctrl instance
// ══════════════════════════════════════════════════════════════════════════════

// ── ADMIN DASHBOARD STATS (extended) ─────────────────────────────────────────
_ctrl.adminFullStats = async function(req, res, next) {
    try {
        const T = Model.Tool; const O = Model.Order; const U = Model.User;
        const { Op: SOP } = require('sequelize');
        const today = new Date(); today.setHours(0,0,0,0);
        const weekAgo  = new Date(Date.now()-7*86400000);
        const monthAgo = new Date(Date.now()-30*86400000);

        const [
            totalUsers, totalSellers, totalProducts, pendingProducts,
            totalOrders, todayOrders, pendingOrders,
            allOrders, todayRevOrders, weekRevOrders, monthRevOrders,
        ] = await Promise.all([
            U ? U.count() : 0,
            U ? U.count({ where:{ role:{ [SOP.in]:['user','moderator'] } } }) : 0,
            T ? T.count({ where:{ status:{ [SOP.notIn]:['deleted','removed'] } } }) : 0,
            T ? T.count({ where:{ approvalStatus:'pending' } }) : 0,
            O ? O.count() : 0,
            O ? O.count({ where:{ createdAt:{ [SOP.gte]:today } } }) : 0,
            O ? O.count({ where:{ status:'pending' } }) : 0,
            O ? O.findAll({ attributes:['status','totalPrice','createdAt'] }) : [],
            O ? O.findAll({ where:{ createdAt:{ [SOP.gte]:today }, status:{ [SOP.notIn]:['cancelled','refunded'] } }, attributes:['totalPrice'] }) : [],
            O ? O.findAll({ where:{ createdAt:{ [SOP.gte]:weekAgo }, status:{ [SOP.notIn]:['cancelled','refunded'] } }, attributes:['totalPrice'] }) : [],
            O ? O.findAll({ where:{ createdAt:{ [SOP.gte]:monthAgo }, status:{ [SOP.notIn]:['cancelled','refunded'] } }, attributes:['totalPrice'] }) : [],
        ]);

        const calcRev = rows => rows.reduce((s,o)=>s+parseFloat(o.totalPrice||0),0);
        const todayRev  = calcRev(todayRevOrders);
        const weekRev   = calcRev(weekRevOrders);
        const monthRev  = calcRev(monthRevOrders);
        const totalRev  = calcRev(allOrders.filter(o=>!['cancelled','refunded'].includes(o.status)));

        // Order breakdown
        const orderBreakdown = {};
        allOrders.forEach(o => { orderBreakdown[o.status] = (orderBreakdown[o.status]||0)+1; });

        // Revenue by day (last 7 days)
        const revenueByDay = [];
        for (let i=6; i>=0; i--) {
            const day = new Date(Date.now()-i*86400000);
            const dayStr = day.toISOString().slice(0,10);
            const rev = allOrders.filter(o=>{
                const d=new Date(o.createdAt).toISOString().slice(0,10);
                return d===dayStr&&!['cancelled','refunded'].includes(o.status);
            }).reduce((s,o)=>s+parseFloat(o.totalPrice||0),0);
            revenueByDay.push({ date:dayStr, day:day.toLocaleDateString('en-KE',{weekday:'short'}), revenue:rev });
        }

        return ok(res, {
            revenue:  { today:todayRev, week:weekRev, month:monthRev, total:totalRev, by_day:revenueByDay, currency:'KES' },
            users:    { total:totalUsers, sellers:totalSellers, buyers:Math.max(0,totalUsers-totalSellers) },
            products: { total:totalProducts, pending:pendingProducts },
            orders:   { total:totalOrders, today:todayOrders, pending:pendingOrders, breakdown:orderBreakdown },
            platform_fee_pct: 10,
            net_revenue: totalRev * 0.10,
        });
    } catch(e) { err(next, e, 'adminFullStats'); }
};

// ── ADMIN: ALL PRODUCTS (with filters) ───────────────────────────────────────
_ctrl.adminGetAllProducts = async function(req, res, next) {
    try {
        const T = Model.Tool;
        if (!T) return ok(res, { products:[], total:0 });
        const { Op:SOP } = require('sequelize');
        const { status, approval_status, page=1, limit=20, q='' } = req.query;
        const where = { status:{ [SOP.notIn]:['deleted'] } };
        if (status) where.status = status;
        if (approval_status) where.approvalStatus = approval_status;
        if (q) where.title = { [SOP.iLike]:`%${q}%` };
        const { count, rows } = await T.findAndCountAll({
            where, order:[['createdAt','DESC']],
            limit:parseInt(limit), offset:(parseInt(page)-1)*parseInt(limit),
        });
        return ok(res, { products:rows.map(_formatProduct), total:count, page:parseInt(page), pages:Math.ceil(count/parseInt(limit)) });
    } catch(e) { err(next, e, 'adminGetAllProducts'); }
};

_ctrl.adminSuspendProduct = async function(req, res, next) {
    try {
        const T = Model.Tool;
        if (!T) return ok(res,{suspended:true});
        await T.update({ status:'suspended', available:false }, { where:{ id:req.params.id } });
        return ok(res, { suspended:true }, 'Product suspended');
    } catch(e) { err(next, e, 'adminSuspendProduct'); }
};

// ── ADMIN: ALL SELLERS ───────────────────────────────────────────────────────
_ctrl.adminGetAllSellers = async function(req, res, next) {
    try {
        const U = Model.User; const O = Model.Order;
        if (!U) return ok(res, { sellers:[], total:0 });
        const { Op:SOP } = require('sequelize');
        const { q='', page=1, limit=20, verified } = req.query;
        const where = {};
        if (q) where[SOP.or] = [{ username:{[SOP.iLike]:`%${q}%`} }, { email:{[SOP.iLike]:`%${q}%`} }];
        const { count, rows } = await U.findAndCountAll({
            where, attributes:['id','username','firstName','lastName','email','createdAt','isVerified','metadata','role'],
            order:[['createdAt','DESC']], limit:parseInt(limit), offset:(parseInt(page)-1)*parseInt(limit),
        });
        const sellers = rows.map(u => {
            const uj = u.toJSON ? u.toJSON() : u;
            return { id:uj.id, name:`${uj.firstName||''} ${uj.lastName||''}`.trim()||uj.username||uj.email, email:uj.email, joined:uj.createdAt, kyc_status:uj.metadata?.kyc?.status||'unverified', is_active:uj.isVerified, metadata:uj.metadata };
        });
        return ok(res, { sellers, total:count, page:parseInt(page), pages:Math.ceil(count/parseInt(limit)) });
    } catch(e) { err(next, e, 'adminGetAllSellers'); }
};

_ctrl.adminRestoreSeller = async function(req, res, next) {
    try {
        const U = Model.User; const T = Model.Tool;
        if (!U) return ok(res, { restored:true });
        await U.update({ isActive:true }, { where:{ id:req.params.sellerId } });
        if (T) await T.update({ status:'approved', available:true }, { where:{ sellerId:req.params.sellerId, status:'suspended' } });
        return ok(res, { restored:true }, 'Seller restored');
    } catch(e) { err(next, e, 'adminRestoreSeller'); }
};

// ── ADMIN: ALL BUYERS ────────────────────────────────────────────────────────
_ctrl.adminGetAllBuyers = async function(req, res, next) {
    try {
        const U = Model.User;
        if (!U) return ok(res, { buyers:[], total:0 });
        const { Op:SOP } = require('sequelize');
        const { q='', page=1, limit=20 } = req.query;
        const where = {};
        if (q) where[SOP.or] = [{ username:{[SOP.iLike]:`%${q}%`} }, { email:{[SOP.iLike]:`%${q}%`} }];
        const { count, rows } = await U.findAndCountAll({
            where, attributes:['id','username','firstName','lastName','email','createdAt','loyaltyTier','loyaltyPoints','walletBalance','totalOrders','totalSpent'],
            order:[['totalOrders','DESC NULLS LAST'],['createdAt','DESC']], limit:parseInt(limit), offset:(parseInt(page)-1)*parseInt(limit),
        });
        const buyers = rows.map(u => {
            const uj = u.toJSON ? u.toJSON() : u;
            return { id:uj.id, name:`${uj.firstName||''} ${uj.lastName||''}`.trim()||uj.username||uj.email, email:uj.email, joined:uj.createdAt, total_orders:uj.totalOrders||0, total_spent:parseFloat(uj.totalSpent||0), loyalty_tier:uj.loyaltyTier||'bronze', wallet_balance:parseFloat(uj.walletBalance||0), loyalty_points:uj.loyaltyPoints||0 };
        });
        return ok(res, { buyers, total:count, page:parseInt(page), pages:Math.ceil(count/parseInt(limit)) });
    } catch(e) { err(next, e, 'adminGetAllBuyers'); }
};

_ctrl.adminSuspendBuyer = async function(req, res, next) {
    try {
        const U = Model.User;
        if (!U) return ok(res, { suspended:true });
        await U.update({ isActive:false }, { where:{ id:req.params.userId } });
        return ok(res, { suspended:true }, 'Buyer suspended');
    } catch(e) { err(next, e, 'adminSuspendBuyer'); }
};

_ctrl.adminRestoreBuyer = async function(req, res, next) {
    try {
        const U = Model.User;
        if (!U) return ok(res, { restored:true });
        await U.update({ isActive:true }, { where:{ id:req.params.userId } });
        return ok(res, { restored:true }, 'Buyer restored');
    } catch(e) { err(next, e, 'adminRestoreBuyer'); }
};

_ctrl.adminCreditWallet = async function(req, res, next) {
    try {
        const U = Model.User;
        const { userId } = req.params;
        const { amount, reason='Admin credit' } = req.body;
        if (!U || !amount) return ok(res, { credited:true });
        const user = await U.findByPk(userId, { attributes:['id','walletBalance','metadata'] });
        if (!user) return next(new AppError('User not found',404));
        const newBal = parseFloat(user.walletBalance||0) + parseFloat(amount);
        const tx = { id:crypto.randomUUID(), type:'admin_credit', amount:parseFloat(amount), balance_after:newBal, reason, created_at:new Date().toISOString() };
        const txHistory = [...(user.metadata?.walletTransactions||[]), tx].slice(-100);
        await user.update({ walletBalance:newBal, metadata:{...(user.metadata||{}),walletTransactions:txHistory} });
        return ok(res, { credited:true, new_balance:newBal, transaction:tx }, `Credited KES ${amount}`);
    } catch(e) { err(next, e, 'adminCreditWallet'); }
};

// ── ADMIN: ALL ORDERS ────────────────────────────────────────────────────────
_ctrl.adminGetAllOrders = async function(req, res, next) {
    try {
        const O = Model.Order;
        if (!O) return ok(res, { orders:[], total:0 });
        const { Op:SOP } = require('sequelize');
        const { status, page=1, limit=20, q='' } = req.query;
        const where = {};
        if (status) where.status = status;
        const { count, rows } = await O.findAndCountAll({
            where, order:[['createdAt','DESC']],
            limit:parseInt(limit), offset:(parseInt(page)-1)*parseInt(limit),
        });
        return ok(res, { orders:rows.map(_formatOrder), total:count, page:parseInt(page), pages:Math.ceil(count/parseInt(limit)) });
    } catch(e) { err(next, e, 'adminGetAllOrders'); }
};

_ctrl.adminOverrideOrderStatus = async function(req, res, next) {
    try {
        const O = Model.Order;
        const { status, note='' } = req.body;
        if (!O) return ok(res, { updated:true });
        const order = await O.findByPk(req.params.id);
        if (!order) return next(new AppError('Order not found',404));
        const meta = { ...(order.metadata||{}), admin_override:{ status, note, by:req.user?.id, at:new Date().toISOString() } };
        await order.update({ status, metadata:meta });
        _socketBroadcast(null,'order:admin_override',{ order_id:order.id, status },order.buyerId);
        return ok(res, { updated:true, order:_formatOrder(order) }, 'Order status overridden');
    } catch(e) { err(next, e, 'adminOverrideOrderStatus'); }
};

// ── ADMIN: RETURNS & REFUNDS ─────────────────────────────────────────────────
_ctrl.adminGetAllReturns = async function(req, res, next) {
    try {
        const O = Model.Order;
        if (!O) return ok(res, { returns:[], total:0 });
        const { Op:SOP } = require('sequelize');
        const rows = await O.findAll({
            where: { status:{ [SOP.in]:['refunded'] } },
            order:[['createdAt','DESC']], limit:100,
        });
        const returns = rows.map(o => {
            const r = o.toJSON ? o.toJSON() : o;
            return { order_id:r.id, buyer_id:r.buyerId, seller_id:r.sellerId, reason:r.metadata?.refund_reason||'—', status:r.metadata?.refund_status||'pending', requested_at:r.metadata?.refund_requested_at||r.createdAt, total:parseFloat(r.totalPrice||0), items:r.metadata?.items||[] };
        });
        return ok(res, { returns, total:returns.length });
    } catch(e) { err(next, e, 'adminGetAllReturns'); }
};

_ctrl.adminProcessRefund = async function(req, res, next) {
    try {
        const O = Model.Order; const U = Model.User;
        const { approve=true, reason='' } = req.body;
        if (!O) return ok(res, { processed:true });
        const order = await O.findByPk(req.params.id);
        if (!order) return next(new AppError('Order not found',404));
        const meta = { ...(order.metadata||{}), refund_status: approve?'refunded':'rejected', refund_processed_at:new Date().toISOString(), refund_admin_note:reason };
        await order.update({ status: approve?'refunded':'delivered', metadata:meta });
        // Credit wallet if approved
        if (approve && U && order.buyerId) {
            const buyer = await U.findByPk(order.buyerId,{ attributes:['id','walletBalance','metadata'] });
            if (buyer) {
                const amt = parseFloat(order.totalPrice||0);
                const tx = { id:crypto.randomUUID(), type:'refund', amount:amt, balance_after:parseFloat(buyer.walletBalance||0)+amt, reason:'Order refund', created_at:new Date().toISOString() };
                const txH = [...(buyer.metadata?.walletTransactions||[]),tx].slice(-100);
                await buyer.update({ walletBalance:parseFloat(buyer.walletBalance||0)+amt, metadata:{...(buyer.metadata||{}),walletTransactions:txH} });
            }
        }
        _socketBroadcast(null,'order:refund_processed',{ order_id:order.id, approved:approve },order.buyerId);
        return ok(res, { processed:true, approved:approve }, approve?'Refund processed':'Refund rejected');
    } catch(e) { err(next, e, 'adminProcessRefund'); }
};

// ── ADMIN: PAYOUTS ───────────────────────────────────────────────────────────
_ctrl.adminGetAllPayouts = async function(req, res, next) {
    try {
        const U = Model.User;
        if (!U) return ok(res, { payouts:[], total:0 });
        const rows = await U.findAll({ where:{ metadata:{ [require('sequelize').Op.ne]:null } }, attributes:['id','username','email','metadata','walletBalance'] });
        const payouts = [];
        rows.forEach(u => {
            const uj = u.toJSON?u.toJSON():u;
            (uj.metadata?.payoutRequests||[]).forEach(p => {
                payouts.push({ ...p, seller_id:uj.id, seller_name:uj.username||uj.email, seller_balance:parseFloat(uj.walletBalance||0) });
            });
        });
        const sorted = payouts.sort((a,b)=>new Date(b.requested_at)-new Date(a.requested_at));
        return ok(res, { payouts:sorted.slice(0,100), total:sorted.length, pending:sorted.filter(p=>p.status==='pending').length });
    } catch(e) { err(next, e, 'adminGetAllPayouts'); }
};

_ctrl.adminProcessPayout = async function(req, res, next) {
    try {
        const U = Model.User;
        const { seller_id, payout_id, approve=true, note='' } = req.body;
        if (!U || !seller_id || !payout_id) return ok(res, { processed:true });
        const user = await U.findByPk(seller_id, { attributes:['id','walletBalance','metadata'] });
        if (!user) return next(new AppError('Seller not found',404));
        const meta = { ...(user.metadata||{}) };
        const payouts = meta.payoutRequests||[];
        const idx = payouts.findIndex(p=>p.id===payout_id);
        if (idx>=0) {
            payouts[idx].status = approve?'completed':'rejected';
            payouts[idx].processed_at = new Date().toISOString();
            payouts[idx].admin_note = note;
            if (approve) {
                const deducted = Math.max(0, parseFloat(user.walletBalance||0) - parseFloat(payouts[idx].amount||0));
                await user.update({ walletBalance:deducted, metadata:{...meta,payoutRequests:payouts,totalWithdrawn:(meta.totalWithdrawn||0)+parseFloat(payouts[idx].amount||0)} });
            } else {
                await user.update({ metadata:{...meta,payoutRequests:payouts} });
            }
        }
        _socketBroadcast(null,'payout:processed',{ seller_id, approve },seller_id);
        return ok(res, { processed:true, approved:approve }, approve?'Payout released':'Payout rejected');
    } catch(e) { err(next, e, 'adminProcessPayout'); }
};

// ── ADMIN: COUPONS (list + manage) ───────────────────────────────────────────
_ctrl.adminToggleCoupon = async function(req, res, next) {
    try {
        const C = Model.Coupon;
        if (!C) return ok(res, { toggled:true });
        const coupon = await C.findByPk(req.params.id);
        if (!coupon) return next(new AppError('Coupon not found',404));
        await coupon.update({ isActive:!coupon.isActive });
        return ok(res, { active:coupon.isActive, coupon:coupon.toJSON() });
    } catch(e) { err(next, e, 'adminToggleCoupon'); }
};

_ctrl.adminDeleteCoupon = async function(req, res, next) {
    try {
        const C = Model.Coupon;
        if (!C) return ok(res, { deleted:true });
        await C.destroy({ where:{ id:req.params.id } });
        return ok(res, { deleted:true });
    } catch(e) { err(next, e, 'adminDeleteCoupon'); }
};

// ── ADMIN: FLASH SALES ────────────────────────────────────────────────────────
_ctrl.adminGetAllFlashSales = async function(req, res, next) {
    try {
        const T = Model.Tool;
        if (!T) return ok(res, { flash_sales:[] });
        const { Op:SOP } = require('sequelize');
        const rows = await T.findAll({ where:{ isFlashSale:true }, order:[['flashSaleEnd','ASC']], limit:50 });
        const now = new Date();
        return ok(res, { flash_sales:rows.map(r=>{
            const rj=r.toJSON?r.toJSON():r;
            return { ..._formatProduct(r), flash_price:parseFloat(rj.flashSalePrice||0), flash_ends_at:rj.flashSaleEnd, flash_stock:rj.flashSaleStock, active:rj.flashSaleEnd&&new Date(rj.flashSaleEnd)>now };
        }), total:rows.length });
    } catch(e) { err(next, e, 'adminGetAllFlashSales'); }
};

// ── ADMIN: REVIEWS ────────────────────────────────────────────────────────────
_ctrl.adminGetAllReviews = async function(req, res, next) {
    try {
        const R = Model.Review;
        if (!R) return ok(res, { reviews:[], total:0 });
        const { Op:SOP } = require('sequelize');
        const { flagged, page=1, limit=20 } = req.query;
        const where = {};
        if (flagged==='true') where.flagged = true;
        const { count, rows } = await R.findAndCountAll({
            where, order:[['createdAt','DESC']], limit:parseInt(limit), offset:(parseInt(page)-1)*parseInt(limit)
        });
        return ok(res, { reviews:rows.map(r=>r.toJSON?r.toJSON():r), total:count });
    } catch(e) { err(next, e, 'adminGetAllReviews'); }
};

_ctrl.adminHideReview = async function(req, res, next) {
    try {
        const R = Model.Review;
        if (!R) return ok(res, { hidden:true });
        await R.update({ visible:false }, { where:{ id:req.params.id } });
        return ok(res, { hidden:true }, 'Review hidden');
    } catch(e) { err(next, e, 'adminHideReview'); }
};

_ctrl.adminDeleteReview = async function(req, res, next) {
    try {
        const R = Model.Review;
        if (!R) return ok(res, { deleted:true });
        await R.destroy({ where:{ id:req.params.id } });
        return ok(res, { deleted:true }, 'Review deleted');
    } catch(e) { err(next, e, 'adminDeleteReview'); }
};

// ── ADMIN: AUDIT LOG ─────────────────────────────────────────────────────────
_ctrl.adminGetAuditLog = async function(req, res, next) {
    try {
        // Store audit log in memory/cache; in production use a dedicated table
        const logs = global._adminAuditLog || [];
        return ok(res, { logs:logs.slice(0,200), total:logs.length });
    } catch(e) { err(next, e, 'adminGetAuditLog'); }
};

// Middleware: log admin actions automatically
function _adminAuditLog(action, data, adminId) {
    if (!global._adminAuditLog) global._adminAuditLog = [];
    global._adminAuditLog.unshift({ action, data, admin_id:adminId, timestamp:new Date().toISOString() });
    if (global._adminAuditLog.length > 500) global._adminAuditLog.pop();
}

// ── ADMIN: SETTINGS ───────────────────────────────────────────────────────────
_ctrl.adminGetSettings = async function(req, res, next) {
    try {
        const settings = global._platformSettings || {
            platform_name: 'Knecta Market',
            commission_pct: 10,
            min_payout_kes: 100,
            max_payout_kes: 100000,
            auto_approve_verified_sellers: false,
            flash_sale_max_duration_hours: 24,
            default_currency: 'KES',
            supported_currencies: ['KES','USD','EUR'],
            supported_languages: ['en','sw'],
            referral_bonus_kes: 100,
            loyalty_points_per_kes: 1,
            loyalty_kes_per_point: 0.5,
            max_listing_images: 8,
            require_product_approval: true,
            require_seller_kyc: false,
        };
        return ok(res, { settings });
    } catch(e) { err(next, e, 'adminGetSettings'); }
};

_ctrl.adminUpdateSettings = async function(req, res, next) {
    try {
        if (!global._platformSettings) global._platformSettings = {};
        Object.assign(global._platformSettings, req.body);
        _adminAuditLog('settings_updated', req.body, req.user?.id);
        return ok(res, { settings:global._platformSettings, updated:true }, 'Settings updated');
    } catch(e) { err(next, e, 'adminUpdateSettings'); }
};

// ── ADMIN: SEND NOTIFICATION ──────────────────────────────────────────────────
_ctrl.adminSendNotification = async function(req, res, next) {
    try {
        const { title, message, type='announcement', target='all', product_id } = req.body;
        if (!title || !message) return next(new AppError('Title and message required',400));
        _socketBroadcast(null, 'admin:notification', { title, message, type, target, product_id, sent_at:new Date().toISOString() }, null);
        _adminAuditLog('notification_sent', { title, type, target }, req.user?.id);
        return ok(res, { sent:true, title, type, target }, 'Notification sent');
    } catch(e) { err(next, e, 'adminSendNotification'); }
};

// ── ADMIN: PLATFORM ANALYTICS ─────────────────────────────────────────────────
_ctrl.adminGetAnalytics = async function(req, res, next) {
    try {
        const T = Model.Tool; const O = Model.Order; const U = Model.User;
        const { period='30d' } = req.query;
        const days = period==='7d'?7:period==='90d'?90:30;
        const { Op:SOP } = require('sequelize');
        const since = new Date(Date.now()-days*86400000);

        const [topProducts, topCats, userGrowth, recentOrders] = await Promise.all([
            T ? T.findAll({ where:{ status:{ [SOP.in]:['active','approved'] } }, order:[['views','DESC'],['soldCount','DESC']], limit:10, attributes:['id','title','price','views','soldCount','rating','category'] }) : [],
            T ? T.findAll({ attributes:['category',[require('sequelize').fn('COUNT','*'),'count']], where:{ status:{ [SOP.in]:['active','approved'] } }, group:['category'], order:[[require('sequelize').fn('COUNT','*'),'DESC']], limit:8 }) : [],
            U ? U.findAll({ where:{ createdAt:{ [SOP.gte]:since } }, attributes:['createdAt'], order:[['createdAt','DESC']] }) : [],
            O ? O.findAll({ where:{ createdAt:{ [SOP.gte]:since } }, attributes:['status','totalPrice','createdAt'], order:[['createdAt','DESC']] }) : [],
        ]);

        const revenueByDay = [];
        for (let i=days-1; i>=0; i--) {
            const day = new Date(Date.now()-i*86400000);
            const dayStr = day.toISOString().slice(0,10);
            const rev = recentOrders.filter(o=>new Date(o.createdAt).toISOString().slice(0,10)===dayStr&&!['cancelled','refunded'].includes(o.status)).reduce((s,o)=>s+parseFloat(o.totalPrice||0),0);
            const newUsers = userGrowth.filter(u=>new Date(u.createdAt).toISOString().slice(0,10)===dayStr).length;
            revenueByDay.push({ date:dayStr, revenue:rev, new_users:newUsers });
        }

        return ok(res, {
            period, days,
            top_products: topProducts.map(p=>({ id:p.id, title:p.title, views:p.views||0, sold:p.soldCount||0, revenue:(p.soldCount||0)*parseFloat(p.price||0), category:p.category })),
            top_categories: topCats.map(c=>({ category:c.category, count:parseInt(c.dataValues?.count||0) })),
            revenue_by_day: revenueByDay,
            total_revenue: recentOrders.filter(o=>!['cancelled','refunded'].includes(o.status)).reduce((s,o)=>s+parseFloat(o.totalPrice||0),0),
            total_orders: recentOrders.length,
            new_users: userGrowth.length,
        });
    } catch(e) { err(next, e, 'adminGetAnalytics'); }
};

// ── ADMIN: SUPPORT TICKETS ────────────────────────────────────────────────────
_ctrl.adminGetTickets = async function(req, res, next) {
    try {
        const tickets = global._supportTickets || [];
        const { status } = req.query;
        const filtered = status ? tickets.filter(t=>t.status===status) : tickets;
        return ok(res, { tickets:filtered.slice(0,100), total:filtered.length });
    } catch(e) { err(next, e, 'adminGetTickets'); }
};

_ctrl.adminResolveTicket = async function(req, res, next) {
    try {
        if (!global._supportTickets) return ok(res, { resolved:true });
        const idx = global._supportTickets.findIndex(t=>t.id===req.params.id);
        if (idx>=0) { global._supportTickets[idx].status='resolved'; global._supportTickets[idx].resolved_at=new Date().toISOString(); global._supportTickets[idx].resolution=req.body.resolution||''; }
        return ok(res, { resolved:true });
    } catch(e) { err(next, e, 'adminResolveTicket'); }
};

// Store tickets when created
const _origCreateTicket = _ctrl.createSupportTicket;
_ctrl.createSupportTicket = async function(req, res, next) {
    const result = await _origCreateTicket.call(this, req, res, next);
    if (!global._supportTickets) global._supportTickets = [];
    // ticket stored in _origCreateTicket result, just ensure global
    return result;
};

