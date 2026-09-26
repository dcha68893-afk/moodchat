'use strict';

const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const { Tool } = require('../models');
const marketplaceController = require('../controllers/marketplace.controller');

const CATEGORY_TREE = [
  { id:'electronics', name:'Electronics', type:'physical', children:[
    {id:'phones',name:'Phones',children:[
      {id:'samsung',name:'Samsung',children:[{id:'samsung-a10s',name:'Galaxy A10s',query:'Samsung A10s'},{id:'samsung-a-series',name:'Galaxy A Series',query:'Samsung Galaxy A'}]},
      {id:'iphone',name:'iPhone',query:'iPhone'}, {id:'tecno',name:'Tecno',query:'Tecno'}, {id:'infinix',name:'Infinix',query:'Infinix'}, {id:'xiaomi',name:'Xiaomi',query:'Xiaomi'}
    ]},
    {id:'computing',name:'Computers & Laptops'}, {id:'gaming',name:'Gaming'}, {id:'appliances',name:'Appliances'}
  ]},
  { id:'home', name:'Home & Garden', type:'physical', children:[{id:'furniture',name:'Furniture'},{id:'garden',name:'Garden'},{id:'gas-cylinders',name:'Gas Cylinders',children:[{id:'6kg-gas',name:'6kg Gas Cylinders'},{id:'13kg-gas',name:'13kg Gas Cylinders'},{id:'35kg-gas',name:'35kg Gas Cylinders'},{id:'gas-refill',name:'Gas Refill & Delivery'}]}]},
  { id:'fashion', name:'Fashion', type:'physical' },
  { id:'food', name:'Food & Groceries', type:'physical' },
  { id:'automotive', name:'Automotive', type:'physical' },
  { id:'construction', name:'Building & Construction', type:'physical' },
  { id:'services', name:'Services', type:'service', children:[{id:'repair',name:'Repair'},{id:'cleaning',name:'Cleaning'},{id:'transport',name:'Transport'},{id:'design',name:'Design'},{id:'tutoring',name:'Tutoring'},{id:'beauty',name:'Beauty'},{id:'events',name:'Events'},{id:'tech',name:'Technology'}]},
  { id:'digital', name:'Digital Products', type:'digital', children:[{id:'ebooks',name:'eBooks'},{id:'courses',name:'Courses'},{id:'software',name:'Software'},{id:'audio',name:'Audio'},{id:'templates',name:'Templates'},{id:'notes',name:'Notes'}] },
];

function flatten(nodes,out=[]){for(const n of nodes){out.push(n);if(n.children)flatten(n.children,out)}return out;}
const flat=flatten(CATEGORY_TREE);

router.get('/categories', async (req,res,next)=>{
  try {
    let categories=[];
    if(typeof marketplaceController.getCategories==='function'){
      const originalJson=res.json.bind(res); let payload;
      res.json=(v)=>{payload=v;return res;};
      await marketplaceController.getCategories(req,res,next);
      res.json=originalJson;
      const base=payload?.data||payload?.categories||[];
      categories=Array.isArray(base)?base:[];
    }
    const byId=new Map(categories.map(c=>[String(c.id||c.key||c.slug),c]));
    const merged=CATEGORY_TREE.map(c=>({...c,...(byId.get(c.id)||{}),children:c.children}));
    return res.json({success:true,data:merged,flat:flat.map(({children,...c})=>c)});
  }catch(e){next(e)}
});

router.get('/brands', async (req,res,next)=>{
  try{
    const rows=await Tool.findAll({attributes:['brand'],where:{status:'active',available:true,brand:{[Op.ne]:null}},group:['brand'],order:[['brand','ASC']],limit:Math.min(Number(req.query.limit)||200,500)});
    return res.json({success:true,data:rows.map(r=>r.brand).filter(Boolean)});
  }catch(e){next(e)}
});

function orderFor(sort){
  return ({newest:[['createdAt','DESC']],oldest:[['createdAt','ASC']],price_asc:[['price','ASC']],price_desc:[['price','DESC']],popular:[['views','DESC']],rating:[['rating','DESC']]}[sort]||[['createdAt','DESC']]);
}

function sellerInclude(){
  return (Tool.associations && Tool.associations.seller)
    ? [{ association: Tool.associations.seller, attributes:['id','username','avatar','displayName'], required:false }]
    : [];
}

// FIX (category → subcategory drilldown always "No products found", even
// though the seller's listing is right there): the Tool model has no
// dedicated subcategory/original_price/delivery_fee/location/weight/
// short_description columns — Create Listing (marketplace-seller.js) saves
// all of them inside the single JSONB `metadata` column instead (see
// createProduct in marketplace.controller.js). This endpoint used to hand
// back the raw row as-is, so those fields only ever existed nested under
// `metadata.*`. The frontend's subcategory filter (_renderProductsPage in
// Tool-ui.js) and its product normalizer (_normalizeProduct in
// marketplace-ecommerce.js) both read `p.subcategory` at the TOP level with
// no metadata fallback for it — so it was always empty/undefined and every
// subcategory click filtered every listing out, category browsing was
// otherwise unaffected (no subcategory filter), which is why the listing
// still showed on Home/recent but never under its actual subcategory. Lift
// the same fields marketplace.controller.js's _formatProduct() already
// surfaces, so both response shapes agree and a listing is findable
// wherever its category/subcategory says it should be.
// Listing photos are stored exactly as uploaded: often "/uploads/..." paths, sometimes a JSON
// string. A relative path is a 404 for the app (it resolves against the app's own origin), which
// the UI then replaces with stock category art. Always return absolute image URLs.
function absoluteImages(r){
  let imgs=r.images;
  if(typeof imgs==='string'){try{imgs=JSON.parse(imgs)}catch(_){imgs=imgs?[imgs]:[]}}
  if(!Array.isArray(imgs))imgs=[];
  const base=(process.env.RENDER_EXTERNAL_URL||process.env.BACKEND_URL||require('../utils/requestContext').getRequestBaseUrl()||'').replace(/\/+$/,'');
  return imgs.map(u=>{
    if(u&&typeof u==='object')u=u.url||u.src||'';
    if(!u||typeof u!=='string')return '';
    if(/^(https?:|data:)/i.test(u))return u;
    return base?base+(u.startsWith('/')?'':'/')+u:u;
  }).filter(Boolean);
}

function normalizeRows(rows){
  return rows.map(row=>{
    const r=row.toJSON?row.toJSON():{...row};
    r.images=absoluteImages(r);
    if(!r.image&&r.images.length)r.image=r.images[0];
    const meta=r.metadata||{};
    r.userId=r.sellerId;
    if(!r.user&&r.seller)r.user={id:r.seller.id,displayName:r.seller.displayName||r.seller.username||'User',photoURL:r.seller.avatar||''};
    else if(!r.user)r.user={id:r.sellerId,displayName:'User',photoURL:''};
    if(r.subcategory==null||r.subcategory==='')r.subcategory=meta.subcategory||'';
    if(r.original_price==null)r.original_price=meta.original_price!=null?parseFloat(meta.original_price)||0:0;
    if(r.delivery_fee==null)r.delivery_fee=meta.delivery_fee!=null?parseFloat(meta.delivery_fee)||0:0;
    if(r.location==null||r.location==='')r.location=meta.location||'';
    if(r.weight==null)r.weight=meta.weight!=null?parseFloat(meta.weight)||0:0;
    if(r.short_description==null||r.short_description==='')r.short_description=meta.short_description||'';
    return r;
  });
}

async function searchListings(req){
  const q=String(req.query.q||req.query.search||'').trim();
  const page=Math.max(Number(req.query.page)||1,1),limit=Math.min(Number(req.query.limit)||24,100);
  const where={status:'active',available:true};
  if(req.query.category)where.category=req.query.category;
  // ROOT-CAUSE FIX ("No products found" on every leaf category, e.g. Fridges,
  // Cookers, Irons -- even though the seller's listing is approved and right
  // there): the category tree shown to buyers (Physical > Appliances >
  // Cooling & Heating > Fridges) is 3-4 levels deep, but Tool.category only
  // ever holds the broad top-level value ('appliances') -- it's validated
  // against MARKETPLACE_CATEGORIES, a flat one-level vocabulary with no
  // 'fridges', 'cookers', 'irons', etc. at all. The leaf value a seller
  // actually picks lives only in metadata.subcategory (lifted to the
  // top-level `subcategory` field on the way OUT, in normalizeRows() below)
  // but was never accepted as a filter on the way IN here -- so every
  // leaf-category click silently matched zero rows, in every vertical.
  if(req.query.subcategory)where['metadata.subcategory']=req.query.subcategory;
  if(req.query.type)where.type=req.query.type;
  if(req.query.minPrice!==undefined||req.query.maxPrice!==undefined){where.price={};if(req.query.minPrice!==undefined)where.price[Op.gte]=req.query.minPrice;if(req.query.maxPrice!==undefined)where.price[Op.lte]=req.query.maxPrice;}
  if(q){
    // Search each word across the actual seller listing fields, not just the
    // title. This makes direct searches such as "Samsung A10s" find listings
    // whose brand/model was stored separately from the title.
    const tokens=q.split(/\s+/).filter(Boolean).slice(0,8);
    where[Op.and]=tokens.map(token=>({[Op.or]:[
      {title:{[Op.iLike]:`%${token}%`}},{description:{[Op.iLike]:`%${token}%`}},{brand:{[Op.iLike]:`%${token}%`}},{sku:{[Op.iLike]:`%${token}%`}}
    ]}));
  }
  const {count,rows}=await Tool.findAndCountAll({where,order:orderFor(String(req.query.sort||'newest')),limit,offset:(page-1)*limit,include:sellerInclude()});
  return {listings:normalizeRows(rows),total:count,page,limit,totalPages:Math.ceil(count/limit)};
}

async function listings(req,res,next){try{return res.json({success:true,data:(await searchListings(req)).listings,total:(await searchListings(req)).total,page:(await searchListings(req)).page,limit:(await searchListings(req)).limit,totalPages:(await searchListings(req)).totalPages});}catch(e){next(e)}}

// Avoid executing the database query multiple times for one request.
async function listingsOnce(req,res,next){try{const result=await searchListings(req);return res.json({success:true,data:result.listings,total:result.total,page:result.page,limit:result.limit,totalPages:result.totalPages});}catch(e){next(e)}}
router.get('/listings',listingsOnce);
router.get('/search',listingsOnce);
router.get('/products',listingsOnce);
router.get('/products/:id',async(req,res,next)=>{try{const row=await Tool.findByPk(req.params.id);if(!row)return res.status(404).json({success:false,message:'Listing not found'});return res.json({success:true,data:normalizeRows([row])[0]});}catch(e){next(e)}});

router.post('/listings',async(req,res,next)=>{try{const row=await Tool.create({...req.body,sellerId:req.user?.userId||req.user?.id});return res.status(201).json({success:true,data:row});}catch(e){next(e)}});
router.patch('/listings/:id',async(req,res,next)=>{try{const row=await Tool.findByPk(req.params.id);if(!row)return res.status(404).json({success:false,message:'Listing not found'});if(Number(row.sellerId)!==Number(req.user?.userId||req.user?.id))return res.status(403).json({success:false,message:'Seller access required'});await row.update(req.body);return res.json({success:true,data:row});}catch(e){next(e)}});
router.delete('/listings/:id',async(req,res,next)=>{try{const row=await Tool.findByPk(req.params.id);if(!row)return res.status(404).json({success:false,message:'Listing not found'});if(Number(row.sellerId)!==Number(req.user?.userId||req.user?.id))return res.status(403).json({success:false,message:'Seller access required'});await row.update({status:'deleted',available:false});return res.json({success:true});}catch(e){next(e)}});

module.exports=router;
