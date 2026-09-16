'use strict';

const express = require('express');
const router = express.Router();
const { optionalAuthenticateToken } = require('../middleware/auth');
const db = require('../models');
const Tool = db.Tool;
const sequelize = db.sequelize;

const KENYA_REGIONS = {
  Nairobi: ['Nairobi'],
  Coast: ['Mombasa','Kwale','Kilifi','Tana River','Lamu','Taita Taveta'],
  'Rift Valley': ['Turkana','West Pokot','Samburu','Trans-Nzoia','Uasin Gishu','Elgeyo-Marakwet','Nandi','Baringo','Laikipia','Nakuru','Narok','Kajiado','Kericho','Bomet'],
  Eastern: ['Marsabit','Isiolo','Meru','Tharaka-Nithi','Embu','Kitui','Machakos','Makueni'],
  'North Eastern': ['Garissa','Wajir','Mandera'],
  Nyanza: ['Siaya','Kisumu','Homa Bay','Migori','Kisii','Nyamira'],
  Western: ['Kakamega','Vihiga','Bungoma','Busia'],
  Central: ['Nyandarua','Nyeri','Kirinyaga','Muranga','Kiambu']
};

const userId = req => Number(req.user?.userId ?? req.user?.id);
const accommodationOf = row => row?.metadata?.accommodation || row?.metadata?.accommodationDetails || null;
// FIX: GET /listings used to spread row.toJSON() wholesale into the public
// response, which leaked the whole metadata blob — including the
// admin-only seller_contact field — to any anonymous visitor. Build an
// explicit public-safe shape instead, and only include seller_contact for
// the listing's own seller or an admin.
const publicListing = (row, req) => {
  const r = row.toJSON ? row.toJSON() : row;
  const viewer = req.user;
  const isOwner = viewer && Number(viewer.id ?? viewer.userId) === Number(r.sellerId ?? r.seller_id);
  const isAdmin = viewer?.role === 'admin';
  const a = accommodationOf(r) || {};
  return {
    id: r.id, sellerId: r.sellerId, title: r.title, description: r.description,
    price: r.price, currency: r.currency, images: r.images, stock: r.stock,
    status: r.status, available: r.available, createdAt: r.createdAt, updatedAt: r.updatedAt,
    accommodation: a,
    ...((isOwner || isAdmin) ? { seller_contact: r.metadata?.seller_contact || '' } : {}),
  };
};

router.get('/regions', (req,res) => res.json({success:true,data:KENYA_REGIONS}));

// GET /drilldown — cascades region → location → village → estate using
// only values sellers have actually entered on live listings, so buyers
// can never pick a combination that has zero matching listings.
router.get('/drilldown', async (req,res,next) => {
  try {
    const region = String(req.query.region || '').trim();
    const location = String(req.query.location || '').trim();
    const village = String(req.query.village || '').trim();
    const where = { status:'active', available:true, type:'service', category:'accommodation' };
    const rows = await Tool.findAll({ where, attributes:['id','metadata'] });
    const seen = new Set();
    for (const row of rows) {
      const a = accommodationOf(row) || {};
      if (region && String(a.region||'').toLowerCase() !== region.toLowerCase()) continue;
      if (location && String(a.location||'').toLowerCase() !== location.toLowerCase()) continue;
      if (village) {
        if (String(a.village||'').toLowerCase() !== village.toLowerCase()) continue;
        if (a.estate) seen.add(a.estate);
      } else if (a.village) {
        seen.add(a.village);
      }
    }
    res.json({success:true,data:Array.from(seen).sort(), level: village ? 'estate' : 'village'});
  } catch(e){ next(e); }
});

router.get('/listings', optionalAuthenticateToken, async (req,res,next) => {
  try {
    const region = String(req.query.region || '').trim();
    const location = String(req.query.location || '').trim();
    const village = String(req.query.village || '').trim();
    const estate = String(req.query.estate || '').trim();
    const q = String(req.query.q || '').trim();
    const where = { status:'active', available:true, type:'service', category:'accommodation' };
    const rows = await Tool.findAll({where, order:[['createdAt','DESC']], limit:Math.min(Number(req.query.limit)||50,100)});
    const data = rows.filter(row => {
      const a = accommodationOf(row) || {};
      if (region && String(a.region||'').toLowerCase() !== region.toLowerCase()) return false;
      if (location && !String(a.location||'').toLowerCase().includes(location.toLowerCase())) return false;
      if (village && String(a.village||'').toLowerCase() !== village.toLowerCase()) return false;
      if (estate && String(a.estate||'').toLowerCase() !== estate.toLowerCase()) return false;
      if (q && !`${row.title} ${row.description||''} ${a.location||''} ${a.region||''} ${a.village||''} ${a.estate||''}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    }).map(row => publicListing(row, req));
    res.json({success:true,data,regions:KENYA_REGIONS});
  } catch(e){ next(e); }
});
router.get('/listings/:id/availability', async (req,res,next) => {
  try {
    const [rows] = await sequelize.query(`SELECT check_in, check_out, rooms, status FROM marketplace_accommodation_bookings WHERE listing_id=:id AND status IN ('pending','confirmed') AND check_out >= CURRENT_DATE ORDER BY check_in`, {replacements:{id:req.params.id}});
    const listing = await Tool.findByPk(req.params.id);
    if (!listing) return res.status(404).json({success:false,message:'Accommodation not found'});
    const a=accommodationOf(listing)||{};
    res.json({success:true,data:{rooms:Number(a.rooms||listing.stock||1),bookings:rows}});
  } catch(e){ next(e); }
});
router.post('/listings/:id/book', async (req,res,next) => {
  const transaction = await sequelize.transaction();
  try {
    const guest = userId(req);
    if (!guest) { await transaction.rollback(); return res.status(401).json({success:false,message:'Login required'}); }
    const checkIn = String(req.body.checkIn||''); const checkOut = String(req.body.checkOut||'');
    const rooms = Math.max(Number(req.body.rooms)||1,1); const guests = Math.max(Number(req.body.guests)||1,1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) {
      await transaction.rollback(); return res.status(400).json({success:false,message:'Choose a valid check-in and check-out date.'});
    }
    const listing = await Tool.findByPk(req.params.id,{transaction,lock:transaction.LOCK.UPDATE});
    if (!listing || listing.status!=='active' || listing.type!=='service' || listing.category!=='accommodation') {
      await transaction.rollback(); return res.status(404).json({success:false,message:'Accommodation not available'});
    }
    const a=accommodationOf(listing)||{}; const capacity=Math.max(Number(a.rooms||listing.stock||1),1);
    const [bookedRows] = await sequelize.query(`SELECT COALESCE(SUM(rooms),0)::int AS booked FROM marketplace_accommodation_bookings WHERE listing_id=:id AND status IN ('pending','confirmed') AND check_in < :checkOut AND check_out > :checkIn`,{replacements:{id:listing.id,checkIn,checkOut},transaction});
    const booked=Number(bookedRows[0]?.booked||0);
    if (booked + rooms > capacity) { await transaction.rollback(); return res.status(409).json({success:false,message:`Only ${Math.max(capacity-booked,0)} room(s) are available for those dates.`}); }
    const nights=Math.max((new Date(`${checkOut}T00:00:00Z`)-new Date(`${checkIn}T00:00:00Z`))/86400000,1);
    const total=Number(listing.price||0)*nights*rooms;
    const [created] = await sequelize.query(`INSERT INTO marketplace_accommodation_bookings (listing_id,guest_id,check_in,check_out,rooms,guests,status,total_price,currency,guest_note) VALUES (:listingId,:guestId,:checkIn,:checkOut,:rooms,:guests,'confirmed',:total,:currency,:note) RETURNING *`,{replacements:{listingId:listing.id,guestId:guest,checkIn,checkOut,rooms,guests,total,currency:listing.currency||'KES',note:String(req.body.note||'').slice(0,1000)},transaction});
    await transaction.commit(); res.status(201).json({success:true,data:created[0]});
  } catch(e){ try{await transaction.rollback();}catch(_){} next(e); }
});
router.get('/bookings/mine', async(req,res,next)=>{try{const guest=userId(req);if(!guest)return res.status(401).json({success:false,message:'Login required'});const [rows]=await sequelize.query(`SELECT b.*,t.title,t.images,t.price,t.currency,t.metadata FROM marketplace_accommodation_bookings b JOIN tools t ON t.id=b.listing_id WHERE b.guest_id=:guest ORDER BY b.check_in DESC`,{replacements:{guest}});res.json({success:true,data:rows});}catch(e){next(e)}});
router.patch('/bookings/:id/cancel', async(req,res,next)=>{try{const guest=userId(req);const [rows]=await sequelize.query(`UPDATE marketplace_accommodation_bookings SET status='cancelled',updated_at=NOW() WHERE id=:id AND guest_id=:guest AND status IN ('pending','confirmed') RETURNING *`,{replacements:{id:req.params.id,guest}});if(!rows[0])return res.status(404).json({success:false,message:'Booking not found or already closed'});res.json({success:true,data:rows[0]});}catch(e){next(e)}});
router.get('/seller/bookings', async(req,res,next)=>{try{const seller=userId(req);const [rows]=await sequelize.query(`SELECT b.*,t.title,t.images,t.price,t.currency,t.metadata FROM marketplace_accommodation_bookings b JOIN tools t ON t.id=b.listing_id WHERE t.seller_id=:seller ORDER BY b.check_in DESC`,{replacements:{seller}});res.json({success:true,data:rows});}catch(e){next(e)}});
module.exports=router;
