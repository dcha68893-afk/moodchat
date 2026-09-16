'use strict';

const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const { Tool, Users } = require('../models');
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

async function listings(req,res,next){
  try{
    const q=String(req.query.q||req.query.search||'').trim();
    const result=await Tool.getListings({page:Number(req.query.page)||1,limit:Math.min(Number(req.query.limit)||24,100),category:req.query.category,type:req.query.type,search:q||undefined,minPrice:req.query.minPrice,maxPrice:req.query.maxPrice,sort:req.query.sort||'newest'});
    return res.json({success:true,data:result.listings,total:result.total,page:result.page,limit:result.limit,totalPages:result.totalPages});
  }catch(e){next(e)}
}
router.get('/listings',listings);
router.get('/search',listings);
router.get('/products',listings);
router.get('/products/:id',async(req,res,next)=>{try{const row=await Tool.findByPk(req.params.id);if(!row)return res.status(404).json({success:false,message:'Listing not found'});return res.json({success:true,data:row});}catch(e){next(e)}});

router.post('/listings',async(req,res,next)=>{try{const row=await Tool.create({...req.body,sellerId:req.user?.userId||req.user?.id});return res.status(201).json({success:true,data:row});}catch(e){next(e)}});
router.patch('/listings/:id',async(req,res,next)=>{try{const row=await Tool.findByPk(req.params.id);if(!row)return res.status(404).json({success:false,message:'Listing not found'});if(Number(row.sellerId)!==Number(req.user?.userId||req.user?.id))return res.status(403).json({success:false,message:'Seller access required'});await row.update(req.body);return res.json({success:true,data:row});}catch(e){next(e)}});
router.delete('/listings/:id',async(req,res,next)=>{try{const row=await Tool.findByPk(req.params.id);if(!row)return res.status(404).json({success:false,message:'Listing not found'});if(Number(row.sellerId)!==Number(req.user?.userId||req.user?.id))return res.status(403).json({success:false,message:'Seller access required'});await row.update({status:'deleted',available:false});return res.json({success:true});}catch(e){next(e)}});

module.exports=router;
