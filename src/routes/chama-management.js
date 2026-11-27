'use strict';
/* Isolated Chama governance API. Existing /money, wallet, STK and group-buy routes are not overridden. */
const express=require('express'),jwt=require('jsonwebtoken');
const {requireAdult}=require('../middleware/requireAdult');
const router=express.Router(),db=()=>require('../models');
const uid=r=>Number(r.user?.id||r.user?.userId||r.user?.sub||r.userId);
const err=(status,message,code)=>Object.assign(new Error(message),{status,code});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('[chama-management]',e.message);if(!res.headersSent)res.status(e.status||500).json({success:false,message:e.message||'Chama error',errorCode:e.code||'CHAMA_ERROR'});});
const clean=(v,n=240)=>String(v||'').trim().replace(/\s+/g,' ').slice(0,n);
const amount=v=>{const n=Number(v);if(!Number.isFinite(n)||n<=0||n>100000000)throw err(400,'Enter a valid positive amount.');return Math.round(n*100)/100;};
const q=async(sql,replacements={},transaction)=>{const d=db();return d.sequelize.query(sql,{replacements,type:d.Sequelize.QueryTypes.SELECT,transaction});};
const w=async(sql,replacements={},transaction)=>db().sequelize.query(sql,{replacements,transaction});
const step=(req,id)=>{const secret=process.env.JWT_ACCESS_SECRET||process.env.JWT_SECRET||'';try{const p=jwt.verify(String(req.get('X-Money-Step-Up')||''),secret);return !!secret&&p.type==='money_step_up'&&Number(p.userId)===Number(id);}catch(_){return false;}};
const verify=(req,id)=>{if(!step(req,id))throw err(401,'Fresh account verification is required for this financial action.','MONEY_STEP_UP_REQUIRED');};
async function circle(id,user,t){const d=db(),c=await d.MoneyCircle.findByPk(id,{transaction:t});if(!c||c.status==='cancelled')throw err(404,'Chama not found.');const m=await d.MoneyCircleMember.findOne({where:{circleId:id,userId:user,status:'active'},transaction:t});if(!m)throw err(403,'You are not an active member of this Chama.');const r=await q("SELECT role FROM chama_member_roles WHERE circle_id=:id AND user_id=:user LIMIT 1",{id,user},t);return {c,role:Number(c.ownerId)===Number(user)?'owner':(r[0]?.role||'member')};}
const allow=(c,roles)=>{if(!roles.includes(c.role))throw err(403,'Your Chama role cannot perform this action.','CHAMA_PERMISSION_DENIED');};
const audit=(id,actor,action,type,entity,details={},t)=>w("INSERT INTO chama_audit_events(circle_id,actor_id,action,entity_type,entity_id,details,created_at) VALUES(:id,:actor,:action,:type,:entity,CAST(:details AS JSONB),NOW())",{id,actor,action,type,entity:String(entity||''),details:JSON.stringify(details)},t);
const threshold=n=>Math.max(1,Math.floor(Number(n)/2)+1);
async function tally(type,id,t){const r=await q("SELECT vote,COUNT(*)::int AS count FROM chama_governance_votes WHERE request_type=:type AND request_id=:id GROUP BY vote",{type,id},t);return {approve:Number(r.find(x=>x.vote==='approve')?.count||0),reject:Number(r.find(x=>x.vote==='reject')?.count||0)};}
router.use((req,res,next)=>['GET','HEAD','OPTIONS'].includes(req.method)?next():requireAdult(req,res,next));

const userModel=()=>{const m=db();return m.User||m.Users||(m.sequelize&&m.sequelize.models&&(m.sequelize.models.Users||m.sequelize.models.User))||null;};
async function names(ids){const out={name:k=>'Member #'+k,avatar:()=>null};try{const U=userModel(),list=[...new Set(ids.map(Number).filter(Boolean))];if(!U||!list.length)return out;const us=await U.findAll({where:{id:list},attributes:['id','username','firstName','lastName','avatar']});const nm=new Map(us.map(u=>[Number(u.id),[u.firstName,u.lastName].filter(Boolean).join(' ')||u.username||('Member #'+u.id)])),av=new Map(us.map(u=>[Number(u.id),u.avatar||null]));return{name:k=>nm.get(Number(k))||('Member #'+k),avatar:k=>av.get(Number(k))||null};}catch(e){console.error('[chama-management] names:',e.message);return out;}}
router.get('/circles/:id/dashboard',wrap(async(req,res)=>{
 const id=req.params.id,c=await circle(id,uid(req));
 const [members,totals,funds,goals,loans,requests,meetings]=await Promise.all([
 q("SELECT m.user_id AS \"userId\",COALESCE(r.role,m.role) AS role,m.status FROM money_circle_members m LEFT JOIN chama_member_roles r ON r.circle_id=m.circle_id AND r.user_id=m.user_id WHERE m.circle_id=:id AND m.status='active' ORDER BY m.\"createdAt\"",{id}),
 q("SELECT (COALESCE((SELECT SUM(amount) FROM money_contributions WHERE circle_id=:id AND status='paid'),0)+COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0))::numeric(15,2) AS balance,COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0)::numeric(15,2) AS expenses FROM chama_ledger_entries WHERE circle_id=:id AND status='posted'",{id}),
 q("SELECT f.id,f.name,f.fund_type AS type,f.target_amount AS \"targetAmount\",COALESCE(SUM(CASE WHEN l.direction='in' THEN l.amount ELSE -l.amount END),0)::numeric(15,2) AS balance FROM chama_funds f LEFT JOIN chama_ledger_entries l ON l.fund_id=f.id AND l.status='posted' WHERE f.circle_id=:id AND f.status='active' GROUP BY f.id ORDER BY f.created_at",{id}),
 q("SELECT g.id,g.title,g.target_amount AS \"targetAmount\",g.deadline,g.status,COALESCE(SUM(a.amount),0)::numeric(15,2) AS allocated FROM chama_savings_goals g LEFT JOIN chama_goal_allocations a ON a.goal_id=g.id WHERE g.circle_id=:id GROUP BY g.id ORDER BY g.created_at DESC",{id}),
 q("SELECT id,borrower_id AS \"borrowerId\",principal,interest_rate AS \"interestRate\",term_months AS \"termMonths\",balance_due AS \"balanceDue\",purpose,status FROM chama_loans WHERE circle_id=:id ORDER BY created_at DESC LIMIT 50",{id}),
 q("SELECT r.id,r.request_type AS type,r.amount,r.description,r.status,r.requested_by AS \"requestedBy\",r.created_at AS \"createdAt\",COALESCE(v.approve,0)::int AS approvals,COALESCE(v.reject,0)::int AS rejections FROM chama_governance_requests r LEFT JOIN (SELECT request_id,SUM(CASE WHEN vote='approve' THEN 1 ELSE 0 END) approve,SUM(CASE WHEN vote='reject' THEN 1 ELSE 0 END) reject FROM chama_governance_votes WHERE request_type='request' GROUP BY request_id) v ON v.request_id=r.id WHERE r.circle_id=:id ORDER BY r.created_at DESC LIMIT 50",{id}),
 q("SELECT id,title,notes,starts_at AS \"startsAt\",status FROM chama_meetings WHERE circle_id=:id ORDER BY starts_at DESC LIMIT 20",{id})
 ]);
 const me=uid(req),nm=await names([...members.map(x=>x.userId),...requests.map(x=>x.requestedBy),...loans.map(x=>x.borrowerId)]);
 res.json({success:true,me,circle:{id:c.c.id,name:c.c.name,targetAmount:Number(c.c.targetAmount||0)},role:c.role,summary:{members:members.length,balance:Number(totals[0]?.balance||0),expenses:Number(totals[0]?.expenses||0)},
  members:members.map(x=>({...x,name:nm.name(x.userId),avatar:nm.avatar(x.userId),isYou:Number(x.userId)===me})),funds,goals,
  loans:loans.map(x=>({...x,borrowerName:nm.name(x.borrowerId),isYou:Number(x.borrowerId)===me})),
  requests:requests.map(x=>({...x,requestedByName:nm.name(x.requestedBy),isYou:Number(x.requestedBy)===me})),meetings});
}));

router.put('/circles/:id/members/:userId/role',wrap(async(req,res)=>{
 const d=db(),actor=uid(req),id=req.params.id,target=Number(req.params.userId),c=await circle(id,actor),role=clean(req.body?.role,24);
 if(c.role!=='owner')throw err(403,'Only the owner can assign leadership roles.');
 if(!['chairperson','treasurer','secretary','member'].includes(role)||target===Number(c.c.ownerId))throw err(400,'Choose chairperson, treasurer, secretary or member.');
 if(!await d.MoneyCircleMember.findOne({where:{circleId:id,userId:target,status:'active'}}))throw err(404,'Active member not found.');
 await w("INSERT INTO chama_member_roles(circle_id,user_id,role,assigned_by,updated_at) VALUES(:id,:target,:role,:actor,NOW()) ON CONFLICT(circle_id,user_id) DO UPDATE SET role=EXCLUDED.role,assigned_by=EXCLUDED.assigned_by,updated_at=NOW()",{id,target,role,actor});
 await audit(id,actor,'member.role.updated','member',target,{role});res.json({success:true,userId:target,role});
}));

router.post('/circles/:id/funds',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','treasurer']);
 const name=clean(req.body?.name,80),type=clean(req.body?.type||'general',24),target=Number(req.body?.targetAmount||0);
 if(!name||!['general','welfare','emergency','investment','project','other'].includes(type)||!Number.isFinite(target)||target<0)throw err(400,'Enter a fund name, category and valid target.');
 const r=await q("INSERT INTO chama_funds(circle_id,name,fund_type,target_amount,created_by,status,created_at,updated_at) VALUES(:id,:name,:type,:target,:actor,'active',NOW(),NOW()) RETURNING id,name,fund_type AS type,target_amount AS \"targetAmount\"",{id,name,type,target,actor});
 await audit(id,actor,'fund.created','fund',r[0].id,{name,type});res.status(201).json({success:true,fund:r[0]});
}));

router.post('/circles/:id/requests',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id;await circle(id,actor);
 const type=clean(req.body?.type,20),sum=type==='decision'?0:amount(req.body?.amount),description=clean(req.body?.description);
 if(!['expense','withdrawal','investment','decision'].includes(type)||!description)throw err(400,'Select a decision, expense, withdrawal or investment and describe its purpose.');
 const r=await q("INSERT INTO chama_governance_requests(circle_id,request_type,amount,description,requested_by,status,created_at,updated_at) VALUES(:id,:type,:sum,:description,:actor,'voting',NOW(),NOW()) RETURNING id,request_type AS type,amount,description,status,created_at AS \"createdAt\"",{id,type,sum,description,actor});
 await audit(id,actor,'request.created','request',r[0].id,{type,amount:sum});res.status(201).json({success:true,request:r[0]});
}));

router.post('/circles/:id/requests/:rid/vote',wrap(async(req,res)=>{
 const d=db(),actor=uid(req),id=req.params.id;await circle(id,actor);const vote=clean(req.body?.vote,10);
 if(!['approve','reject'].includes(vote))throw err(400,'Vote approve or reject.');
 const out=await d.sequelize.transaction(async t=>{
  const rows=await q("SELECT * FROM chama_governance_requests WHERE id=:rid AND circle_id=:id FOR UPDATE",{rid:req.params.rid,id},t),r=rows[0];
  if(!r)throw err(404,'Request not found.');if(Number(r.requested_by)===actor)throw err(403,'You cannot vote on your own request.');if(r.status!=='voting')throw err(409,'Voting has closed.');
  await w("INSERT INTO chama_governance_votes(circle_id,request_type,request_id,user_id,vote,created_at) VALUES(:id,'request',:rid,:actor,:vote,NOW()) ON CONFLICT(circle_id,request_type,request_id,user_id) DO UPDATE SET vote=EXCLUDED.vote,created_at=NOW()",{id,rid:r.id,actor,vote},t);
  const v=await tally('request',r.id,t),n=await d.MoneyCircleMember.count({where:{circleId:id,status:'active'},transaction:t}),limit=threshold(n),status=v.approve>=limit?'approved':v.reject>=limit?'rejected':'voting';
  if(status!=='voting')await w("UPDATE chama_governance_requests SET status=:status,decided_at=NOW(),updated_at=NOW() WHERE id=:rid",{status,rid:r.id},t);
  await audit(id,actor,'request.vote','request',r.id,{vote,tally:v,status},t);return {status,tally:v,threshold:limit};
 });res.json({success:true,...out});
}));

router.post('/circles/:id/requests/:rid/settle',wrap(async(req,res)=>{
 const d=db(),actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','treasurer']);verify(req,actor);
 const reference=clean(req.body?.reference,100);if(!reference)throw err(400,'Enter the external payment/receipt reference.');
 await d.sequelize.transaction(async t=>{
  const rows=await q("SELECT * FROM chama_governance_requests WHERE id=:rid AND circle_id=:id FOR UPDATE",{rid:req.params.rid,id},t),r=rows[0];if(!r||r.status!=='approved'||r.request_type==='decision')throw err(409,'Only an approved financial request can be settled.');
  await w("INSERT INTO chama_ledger_entries(circle_id,entry_type,direction,amount,description,reference,fund_id,created_by,status,metadata,created_at) VALUES(:id,:type,'out',:sum,:description,:reference,:fund,:actor,'posted',CAST(:meta AS JSONB),NOW())",{id,type:r.request_type,sum:r.amount,description:r.description,reference,fund:req.body?.fundId||null,actor,meta:JSON.stringify({requestId:r.id,manualSettlement:true,notProviderVerified:true})},t);
  await w("UPDATE chama_governance_requests SET status='settled',settled_by=:actor,settlement_reference=:reference,settled_at=NOW(),updated_at=NOW() WHERE id=:rid",{actor,reference,rid:r.id},t);
  await audit(id,actor,'request.settlement.recorded','request',r.id,{reference,manual:true},t);
 });res.json({success:true,message:'Settlement recorded. This does not initiate or verify a bank/M-PESA transfer.'});
}));

router.post('/circles/:id/loans',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id;await circle(id,actor);
 const principal=amount(req.body?.principal),rate=Number(req.body?.interestRate||0),months=Number(req.body?.termMonths||1),purpose=clean(req.body?.purpose);
 if(!purpose||!Number.isFinite(rate)||rate<0||rate>100||!Number.isInteger(months)||months<1||months>60)throw err(400,'Provide purpose, interest rate (0–100%) and term (1–60 months).');
 const r=await q("INSERT INTO chama_loans(circle_id,borrower_id,principal,interest_rate,term_months,purpose,status,applied_at,created_at,updated_at) VALUES(:id,:actor,:principal,:rate,:months,:purpose,'voting',NOW(),NOW(),NOW()) RETURNING id,principal,interest_rate AS \"interestRate\",term_months AS \"termMonths\",purpose,status",{id,actor,principal,rate,months,purpose});
 await audit(id,actor,'loan.applied','loan',r[0].id,{principal,rate,months});res.status(201).json({success:true,loan:r[0]});
}));

router.post('/circles/:id/loans/:lid/vote',wrap(async(req,res)=>{
 const d=db(),actor=uid(req),id=req.params.id;await circle(id,actor);const vote=clean(req.body?.vote,10);if(!['approve','reject'].includes(vote))throw err(400,'Vote approve or reject.');
 const out=await d.sequelize.transaction(async t=>{
  const rows=await q("SELECT * FROM chama_loans WHERE id=:lid AND circle_id=:id FOR UPDATE",{lid:req.params.lid,id},t),l=rows[0];
  if(!l)throw err(404,'Loan not found.');if(Number(l.borrower_id)===actor)throw err(403,'You cannot vote on your own loan.');if(l.status!=='voting')throw err(409,'Loan voting has closed.');
  await w("INSERT INTO chama_governance_votes(circle_id,request_type,request_id,user_id,vote,created_at) VALUES(:id,'loan',:lid,:actor,:vote,NOW()) ON CONFLICT(circle_id,request_type,request_id,user_id) DO UPDATE SET vote=EXCLUDED.vote,created_at=NOW()",{id,lid:l.id,actor,vote},t);
  const v=await tally('loan',l.id,t),n=await d.MoneyCircleMember.count({where:{circleId:id,status:'active'},transaction:t}),limit=threshold(n),status=v.approve>=limit?'approved':v.reject>=limit?'rejected':'voting';
  if(status!=='voting')await w("UPDATE chama_loans SET status=:status,decided_at=NOW(),updated_at=NOW() WHERE id=:lid",{status,lid:l.id},t);
  await audit(id,actor,'loan.vote','loan',l.id,{vote,tally:v,status},t);return {status,tally:v,threshold:limit};
 });res.json({success:true,...out});
}));

router.post('/circles/:id/loans/:lid/disburse',wrap(async(req,res)=>{
 const d=db(),actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','treasurer']);verify(req,actor);
 const reference=clean(req.body?.reference,100);if(!reference)throw err(400,'Enter an external payout reference.');
 await d.sequelize.transaction(async t=>{
  const rows=await q("SELECT * FROM chama_loans WHERE id=:lid AND circle_id=:id FOR UPDATE",{lid:req.params.lid,id},t),l=rows[0];if(!l||l.status!=='approved')throw err(409,'Only an approved loan can be disbursed.');
  const total=Number(l.principal)*(1+Number(l.interest_rate)/100);
  await w("UPDATE chama_loans SET status='active',disbursed_by=:actor,disbursement_reference=:reference,disbursed_at=NOW(),total_due=:total,balance_due=:total,updated_at=NOW() WHERE id=:lid",{actor,reference,total,lid:l.id},t);
  await w("INSERT INTO chama_ledger_entries(circle_id,entry_type,direction,amount,description,reference,created_by,status,metadata,created_at) VALUES(:id,'loan_disbursement','out',:sum,:description,:reference,:actor,'posted',CAST(:meta AS JSONB),NOW())",{id,sum:l.principal,description:'Loan to member '+l.borrower_id,reference,actor,meta:JSON.stringify({loanId:l.id,manualSettlement:true})},t);
  await audit(id,actor,'loan.disbursement.recorded','loan',l.id,{reference,totalDue:total,manual:true},t);
 });res.json({success:true,message:'Loan disbursement recorded; NECPRA has not transferred the funds.'});
}));

router.post('/circles/:id/loans/:lid/repayments',wrap(async(req,res)=>{
 const d=db(),actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','treasurer']);verify(req,actor);
 const sum=amount(req.body?.amount),reference=clean(req.body?.reference,100);if(!reference)throw err(400,'Enter a receipt/reference.');
 await d.sequelize.transaction(async t=>{
  const rows=await q("SELECT * FROM chama_loans WHERE id=:lid AND circle_id=:id FOR UPDATE",{lid:req.params.lid,id},t),l=rows[0];if(!l||l.status!=='active')throw err(404,'Active loan not found.');
  if(sum>Number(l.balance_due))throw err(400,'Repayment exceeds the outstanding balance.');
  const balance=Math.round((Number(l.balance_due)-sum)*100)/100;
  await w("INSERT INTO chama_loan_repayments(loan_id,amount,reference,recorded_by,created_at) VALUES(:lid,:sum,:reference,:actor,NOW())",{lid:l.id,sum,reference,actor},t);
  await w("UPDATE chama_loans SET balance_due=:balance,status=:status,updated_at=NOW() WHERE id=:lid",{balance,status:balance<=0?'repaid':'active',lid:l.id},t);
  await w("INSERT INTO chama_ledger_entries(circle_id,entry_type,direction,amount,description,reference,created_by,status,metadata,created_at) VALUES(:id,'loan_repayment','in',:sum,'Loan repayment',:reference,:actor,'posted',CAST(:meta AS JSONB),NOW())",{id,sum,reference,actor,meta:JSON.stringify({loanId:l.id})},t);
  await audit(id,actor,'loan.repayment.recorded','loan',l.id,{sum,reference,balance},t);
 });res.json({success:true,message:'Repayment recorded against the Chama ledger.'});
}));
router.get('/circles/:id/loans',wrap(async(req,res)=>{await circle(req.params.id,uid(req));const loans=await q("SELECT id,borrower_id AS \"borrowerId\",principal,interest_rate AS \"interestRate\",term_months AS \"termMonths\",total_due AS \"totalDue\",balance_due AS \"balanceDue\",purpose,status FROM chama_loans WHERE circle_id=:id ORDER BY created_at DESC LIMIT 100",{id:req.params.id});res.json({success:true,loans});}));

router.post('/circles/:id/goals',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','chairperson','treasurer']);
 const title=clean(req.body?.title,100),target=amount(req.body?.targetAmount),deadline=req.body?.deadline||null;if(!title||(deadline&&!/^\d{4}-\d{2}-\d{2}$/.test(deadline)))throw err(400,'Enter a goal title and valid optional deadline.');
 const r=await q("INSERT INTO chama_savings_goals(circle_id,title,target_amount,deadline,created_by,status,created_at,updated_at) VALUES(:id,:title,:target,:deadline,:actor,'active',NOW(),NOW()) RETURNING id,title,target_amount AS \"targetAmount\",deadline,status",{id,title,target,deadline,actor});
 await audit(id,actor,'goal.created','goal',r[0].id,{title,target});res.status(201).json({success:true,goal:r[0]});
}));
router.post('/circles/:id/goals/:gid/allocations',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','treasurer']);verify(req,actor);
 const sum=amount(req.body?.amount),reference=clean(req.body?.reference,100);if(!reference)throw err(400,'Enter an allocation reference.');
 const g=await q("SELECT id FROM chama_savings_goals WHERE id=:gid AND circle_id=:id AND status='active'",{gid:req.params.gid,id});if(!g.length)throw err(404,'Savings goal not found.');
 await w("INSERT INTO chama_goal_allocations(circle_id,goal_id,amount,reference,recorded_by,created_at) VALUES(:id,:gid,:sum,:reference,:actor,NOW())",{id,gid:req.params.gid,sum,reference,actor});
 await audit(id,actor,'goal.allocation.recorded','goal',req.params.gid,{sum,reference});res.json({success:true,message:'Internal allocation recorded; this is not a new payment.'});
}));

router.post('/circles/:id/meetings',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id,c=await circle(id,actor);allow(c,['owner','chairperson','secretary']);
 const title=clean(req.body?.title,120),notes=clean(req.body?.notes,5000),starts=req.body?.startsAt?new Date(req.body.startsAt):null;if(!title||!starts||Number.isNaN(starts.getTime()))throw err(400,'Enter a meeting title and valid date/time.');
 const r=await q("INSERT INTO chama_meetings(circle_id,title,notes,starts_at,created_by,status,created_at,updated_at) VALUES(:id,:title,:notes,:starts,:actor,'scheduled',NOW(),NOW()) RETURNING id,title,notes,starts_at AS \"startsAt\",status",{id,title,notes,starts,actor});
 await audit(id,actor,'meeting.created','meeting',r[0].id,{title});res.status(201).json({success:true,meeting:r[0]});
}));
router.get('/circles/:id/meetings',wrap(async(req,res)=>{await circle(req.params.id,uid(req));const meetings=await q("SELECT id,title,notes,starts_at AS \"startsAt\",status FROM chama_meetings WHERE circle_id=:id ORDER BY starts_at DESC LIMIT 100",{id:req.params.id});res.json({success:true,meetings});}));
router.get('/circles/:id/report',wrap(async(req,res)=>{
 await circle(req.params.id,uid(req));const id=req.params.id;
 const [totals,byType,monthly,members,loans]=await Promise.all([
 q("SELECT (COALESCE((SELECT SUM(amount) FROM money_contributions WHERE circle_id=:id AND status='paid'),0)+COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0))::numeric(15,2) AS income,COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0)::numeric(15,2) AS expenditure,(COALESCE((SELECT SUM(amount) FROM money_contributions WHERE circle_id=:id AND status='paid'),0)+COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0))::numeric(15,2) AS balance FROM chama_ledger_entries WHERE circle_id=:id AND status='posted'",{id}),
 q("SELECT entry_type AS type,direction,COUNT(*)::int AS transactions,SUM(amount)::numeric(15,2) AS total FROM chama_ledger_entries WHERE circle_id=:id AND status='posted' GROUP BY entry_type,direction ORDER BY entry_type",{id}),
 q("SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') AS month,SUM(CASE WHEN direction='in' THEN amount ELSE 0 END)::numeric(15,2) AS income,SUM(CASE WHEN direction='out' THEN amount ELSE 0 END)::numeric(15,2) AS expenditure FROM chama_ledger_entries WHERE circle_id=:id AND status='posted' AND created_at>=NOW()-INTERVAL '12 months' GROUP BY DATE_TRUNC('month',created_at) ORDER BY DATE_TRUNC('month',created_at)",{id}),
 q("SELECT m.user_id AS \"userId\",COALESCE(SUM(c.amount) FILTER(WHERE c.status='paid'),0)::numeric(15,2) AS contributions FROM money_circle_members m LEFT JOIN money_contributions c ON c.circle_id=m.circle_id AND c.contributor_id=m.user_id WHERE m.circle_id=:id AND m.status='active' GROUP BY m.user_id ORDER BY contributions DESC",{id}),
 q("SELECT status,COUNT(*)::int AS count,SUM(principal)::numeric(15,2) AS principal,SUM(balance_due)::numeric(15,2) AS outstanding FROM chama_loans WHERE circle_id=:id GROUP BY status",{id})
 ]);
 res.json({success:true,currency:'KES',generatedAt:new Date().toISOString(),totals:totals[0],byType,monthly,members,loans});
}));
router.get('/circles/:id/audit',wrap(async(req,res)=>{const c=await circle(req.params.id,uid(req));allow(c,['owner','chairperson','treasurer','secretary']);const events=await q("SELECT id,actor_id AS \"actorId\",action,entity_type AS \"entityType\",entity_id AS \"entityId\",details,created_at AS \"createdAt\" FROM chama_audit_events WHERE circle_id=:id ORDER BY created_at DESC LIMIT 200",{id:req.params.id});res.json({success:true,events});}));

/* ---------- Extended Chama operations ---------- */
const ensureExtendedSchema=async()=>{
 await w("CREATE TABLE IF NOT EXISTS chama_extended_records(id BIGSERIAL PRIMARY KEY,circle_id UUID NOT NULL,kind VARCHAR(32) NOT NULL,title VARCHAR(160) NOT NULL,amount NUMERIC(15,2),reference VARCHAR(120),due_at TIMESTAMPTZ,status VARCHAR(24) NOT NULL DEFAULT 'open',details JSONB NOT NULL DEFAULT '{}'::jsonb,created_by INTEGER NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await w("CREATE INDEX IF NOT EXISTS chama_extended_circle_kind_idx ON chama_extended_records(circle_id,kind,created_at DESC)");
 await w("CREATE UNIQUE INDEX IF NOT EXISTS chama_extended_reference_uq ON chama_extended_records(circle_id,kind,reference) WHERE reference IS NOT NULL AND reference<>''");
 await w("CREATE UNIQUE INDEX IF NOT EXISTS chama_election_ballot_uq ON chama_extended_records(circle_id,created_by,(details->>'electionId')) WHERE kind='election-vote'");
};
router.use(wrap(async(req,res,next)=>{await ensureExtendedSchema();next()}));
const extendedKinds=new Set(['contribution-schedule','payment-reconciliation','investment-distribution','attendance','election','election-vote','dispute','member-exit','document','reminder','contribution-policy']);
router.get('/circles/:id/extended',wrap(async(req,res)=>{const c=await circle(req.params.id,uid(req)),actor=uid(req);const kind=clean(req.query.kind,32);let rows=await q("SELECT id,kind,title,amount,reference,due_at AS \"dueAt\",status,details,created_by AS \"createdBy\",created_at AS \"createdAt\" FROM chama_extended_records WHERE circle_id=:id AND kind<>'election-vote' AND (:kind='' OR kind=:kind) ORDER BY created_at DESC LIMIT 250",{id:req.params.id,kind});const ballots=await q("SELECT details->>'electionId' AS election_id,details->>'candidate' AS candidate,COUNT(*)::int AS votes FROM chama_extended_records WHERE circle_id=:id AND kind='election-vote' GROUP BY details->>'electionId',details->>'candidate'",{id:req.params.id});rows=rows.map(x=>x.kind==='election'&&x.status==='closed'?({...x,results:ballots.filter(v=>String(v.election_id)===String(x.id)).map(v=>({candidate:v.candidate,votes:v.votes}))}):x);if(!['owner','chairperson','treasurer','secretary'].includes(c.role))rows=rows.filter(x=>!['dispute','member-exit'].includes(x.kind)||Number(x.createdBy)===actor).filter(x=>x.kind!=='payment-reconciliation'||Number(x.details.memberId)===actor);res.json({success:true,records:rows,role:c.role});}));
router.post('/circles/:id/extended/:kind',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id,c=await circle(req.params.id,actor),kind=clean(req.params.kind,32);if(!extendedKinds.has(kind))throw err(400,'Unsupported Chama operation.');
 const b=req.body||{};let title=clean(b.title||b.message||b.description,160),sum=null,reference=clean(b.reference,120)||null,due=b.dueAt||b.dueDate||null,status='open',details={};
 if(kind==='contribution-schedule'||kind==='contribution-policy'){
  allow(c,['owner','chairperson','treasurer']);sum=amount(b.amount);const frequency=clean(b.frequency||'monthly',16);if(!['weekly','fortnightly','monthly','quarterly'].includes(frequency))throw err(400,'Choose weekly, fortnightly, monthly or quarterly.');
  title=kind==='contribution-policy'?'Contribution policy':'Recurring contribution schedule';details={frequency,lateFee:Number(b.lateFee||0),graceDays:Number(b.graceDays||0),remindersEnabled:b.remindersEnabled!==false};if(details.lateFee<0||details.graceDays<0||details.graceDays>60)throw err(400,'Enter valid late-fee and grace-period values.');if(!due||Number.isNaN(new Date(due).getTime()))throw err(400,'Choose the next contribution due date.');status='active';
 }else if(kind==='payment-reconciliation'){
  sum=amount(b.amount);title='Contribution awaiting payment verification';if(!reference)throw err(400,'Enter the M-PESA receipt/reference.');details={memberId:Number(b.memberId||actor),phone:clean(b.phone,24),source:'manual_receipt_submission',providerVerified:false,submittedBy:actor};status='pending_verification';
 }else if(kind==='investment-distribution'){
  allow(c,['owner','treasurer']);sum=amount(b.amount);title=clean(b.title||'Investment return distribution',160);details={method:clean(b.method||'equal',24),notes:clean(b.notes,500),stage:'proposal'};status='pending_approval';
 }else if(kind==='attendance'){
  allow(c,['owner','chairperson','secretary']);const meetingId=Number(b.meetingId),attendees=Array.isArray(b.attendees)?b.attendees.map(Number).filter(x=>Number.isInteger(x)&&x>0):[],absent=Array.isArray(b.absent)?b.absent.map(Number).filter(x=>Number.isInteger(x)&&x>0):[];if(!meetingId||!attendees.length)throw err(400,'Choose a meeting and provide at least one attendee member ID.');
  const m=await q("SELECT id,title FROM chama_meetings WHERE id=:meetingId AND circle_id=:id",{meetingId,id});if(!m.length)throw err(404,'Meeting not found.');const roster=await q("SELECT user_id FROM money_circle_members WHERE circle_id=:id AND status='active' AND user_id IN (:ids)",{id,ids:[...new Set([...attendees,...absent])]});if(roster.length!==new Set([...attendees,...absent]).size)throw err(400,'Attendance can only include active Chama members.');title='Attendance: '+m[0].title;details={meetingId,attendees:[...new Set(attendees)],absent:[...new Set(absent)],recordedBy:actor};status='recorded';
 }else if(kind==='election'){
  allow(c,['owner','chairperson','secretary']);const candidates=Array.isArray(b.candidates)?b.candidates.map(x=>clean(x,100)).filter(Boolean):[];if(candidates.length<2)throw err(400,'An election needs at least two candidate names.');title=clean(b.title||'Leadership election',160);details={position:clean(b.position,60),candidates,votingEndsAt:b.votingEndsAt||null};status='nominations';
 }else if(kind==='election-vote'){
  const electionId=Number(b.electionId),candidate=clean(b.candidate,100);if(!electionId||!candidate)throw err(400,'Select an election and candidate.');
  const e=await q("SELECT id,details,status FROM chama_extended_records WHERE id=:electionId AND circle_id=:id AND kind='election'",{electionId,id});if(!e.length||e[0].status!=='open'||!(e[0].details.candidates||[]).includes(candidate))throw err(409,'This election or candidate is not available.');
  const existing=await q("SELECT id FROM chama_extended_records WHERE circle_id=:id AND kind='election-vote' AND details->>'electionId'=:eid AND created_by=:actor LIMIT 1",{id,eid:String(electionId),actor});if(existing.length)throw err(409,'You have already voted in this election.');title='Election ballot';details={electionId,candidate};status='cast';
 }else if(kind==='dispute'){
  title=clean(b.title||'Member dispute',160);details={category:clean(b.category||'general',40),description:clean(b.description,3000),againstMemberId:Number(b.againstMemberId)||null,confidential:true};if(!details.description)throw err(400,'Describe the issue you want reviewed.');status='open';
 }else if(kind==='member-exit'){title='Member exit request';details={reason:clean(b.reason,1000),settlementPreference:clean(b.settlementPreference||'review',40),requestedBy:actor};status='submitted';
 }else if(kind==='document'){
  title=clean(b.title,160);const url=clean(b.url,1000);if(!title||!/^https?:\/\//i.test(url))throw err(400,'Enter a document title and a valid document URL.');details={url,documentType:clean(b.documentType||'other',40),description:clean(b.description,500)};status='available';
 }else if(kind==='reminder'){title=clean(b.title||b.message,160);if(!title||!due||Number.isNaN(new Date(due).getTime()))throw err(400,'Enter a reminder and due date/time.');details={message:clean(b.message||title,500),audience:clean(b.audience||'all-members',40),delivery:'in-app-queue'};status='scheduled';}
 const r=await q("INSERT INTO chama_extended_records(circle_id,kind,title,amount,reference,due_at,status,details,created_by,created_at,updated_at) VALUES(:id,:kind,:title,:sum,:reference,:due,:status,CAST(:details AS JSONB),:actor,NOW(),NOW()) RETURNING id,kind,title,amount,reference,due_at AS \"dueAt\",status,details,created_at AS \"createdAt\"",{id,kind,title:title||kind,sum,reference,due:due?new Date(due):null,status,details:JSON.stringify(details),actor});
 await audit(id,actor,'extended.'+kind+'.created',kind,r[0].id,{status,amount:sum,reference});res.status(201).json({success:true,record:r[0],message:kind==='payment-reconciliation'?'Receipt saved as pending verification. It has not been treated as paid.':kind==='reminder'?'Reminder saved. Delivery requires a configured notification worker.':'Chama record saved.'});
}));
router.post('/circles/:id/extended/:recordId/action',wrap(async(req,res)=>{
 const actor=uid(req),id=req.params.id,c=await circle(req.params.id,actor),rid=Number(req.params.recordId),action=clean(req.body?.action,32);const rows=await q("SELECT * FROM chama_extended_records WHERE id=:rid AND circle_id=:id FOR UPDATE",{rid,id}),r=rows[0];if(!r)throw err(404,'Chama record not found.');
 if(action==='verify-receipt'){
  allow(c,['owner','treasurer']);verify(req,actor);if(r.kind!=='payment-reconciliation'||r.status!=='pending_verification')throw err(409,'This receipt is not awaiting verification.');const ref=clean(req.body?.reference||r.reference,120);if(!ref)throw err(400,'A receipt reference is required.');
  await w("UPDATE chama_extended_records SET status='manually-verified',reference=:ref,updated_at=NOW() WHERE id=:rid",{ref,rid});await w("INSERT INTO chama_ledger_entries(circle_id,entry_type,direction,amount,description,reference,created_by,status,metadata,created_at) VALUES(:id,'contribution','in',:sum,'Manually verified Chama contribution',:ref,:actor,'posted',CAST(:meta AS JSONB),NOW())",{id,sum:r.amount,ref,actor,meta:JSON.stringify({extendedRecordId:rid,providerVerified:false,manualVerification:true,memberId:r.details.memberId})});await audit(id,actor,'contribution.receipt.manually_verified','payment',rid,{reference:ref,providerVerified:false});res.json({success:true,message:'Receipt manually verified and posted. This is not automated Safaricom verification.'});return;
 }
 if(action==='resolve-dispute'){allow(c,['owner','chairperson','secretary']);if(r.kind!=='dispute'||r.status!=='open')throw err(409,'Dispute is not open.');await w("UPDATE chama_extended_records SET status='resolved',details=details||CAST(:extra AS JSONB),updated_at=NOW() WHERE id=:rid",{rid,extra:JSON.stringify({resolution:clean(req.body?.resolution,2000),resolvedBy:actor,resolvedAt:new Date().toISOString()})});}
 else if(action==='decide-exit'){allow(c,['owner','chairperson','treasurer']);if(r.kind!=='member-exit'||r.status!=='submitted')throw err(409,'Exit request is not awaiting a decision.');const decision=req.body?.decision==='approve'?'approved':'rejected';await w("UPDATE chama_extended_records SET status=:status,details=details||CAST(:extra AS JSONB),updated_at=NOW() WHERE id=:rid",{rid,status:decision,extra:JSON.stringify({decisionBy:actor,decisionNote:clean(req.body?.note,1000)})});}
 else if(action==='open-election'||action==='close-election'){allow(c,['owner','chairperson','secretary']);if(r.kind!=='election')throw err(409,'Record is not an election.');const status=action==='open-election'?'open':'closed';await w("UPDATE chama_extended_records SET status=:status,updated_at=NOW() WHERE id=:rid",{rid,status});}
 else if(action==='approve-distribution'){allow(c,['owner','chairperson']);if(r.kind!=='investment-distribution'||r.status!=='pending_approval')throw err(409,'Distribution proposal is not awaiting approval.');await w("UPDATE chama_extended_records SET status='approved',details=details||CAST(:extra AS JSONB),updated_at=NOW() WHERE id=:rid",{rid,extra:JSON.stringify({approvedBy:actor,approvedAt:new Date().toISOString()})});}
 else if(action==='mark-distribution-paid'){allow(c,['owner','treasurer']);verify(req,actor);if(r.kind!=='investment-distribution'||r.status!=='approved')throw err(409,'Distribution proposal must be approved before settlement.');const ref=clean(req.body?.reference,120);if(!ref)throw err(400,'Enter the external payout reference.');await w("INSERT INTO chama_ledger_entries(circle_id,entry_type,direction,amount,description,reference,created_by,status,metadata,created_at) VALUES(:id,'investment_distribution','out',:sum,:title,:ref,:actor,'posted',CAST(:meta AS JSONB),NOW())",{id,sum:r.amount,title:r.title,ref,actor,meta:JSON.stringify({extendedRecordId:rid,manualSettlement:true,providerVerified:false})});await w("UPDATE chama_extended_records SET status='recorded-paid',reference=:ref,updated_at=NOW() WHERE id=:rid",{rid,ref});}
 else if(action==='pause-schedule'){allow(c,['owner','chairperson','treasurer']);if(!['contribution-schedule','contribution-policy','reminder'].includes(r.kind))throw err(409,'This record cannot be paused.');await w("UPDATE chama_extended_records SET status='paused',updated_at=NOW() WHERE id=:rid",{rid});}
 else throw err(400,'Unsupported action.');
 await audit(id,actor,'extended.'+r.kind+'.'+action,r.kind,rid,{action});res.json({success:true,message:'Chama record updated.'});
}));
router.get('/circles/:id/insights',wrap(async(req,res)=>{
 const id=req.params.id,c=await circle(id,uid(req)),actor=uid(req);
 const [memberRows,repayments,loans,totals,schedules]=await Promise.all([
 q("SELECT m.user_id AS user_id,COUNT(c.id)::int AS paid_count,COALESCE(SUM(c.amount),0)::numeric(15,2) AS paid_total FROM money_circle_members m LEFT JOIN money_contributions c ON c.circle_id=m.circle_id AND c.contributor_id=m.user_id AND c.status='paid' WHERE m.circle_id=:id AND m.status='active' GROUP BY m.user_id",{id}),
 q("SELECT l.borrower_id,COUNT(r.id)::int AS repayments,COALESCE(SUM(r.amount),0)::numeric(15,2) AS repaid FROM chama_loans l LEFT JOIN chama_loan_repayments r ON r.loan_id=l.id WHERE l.circle_id=:id GROUP BY l.borrower_id",{id}),
 q("SELECT COUNT(*)::int AS count,COALESCE(SUM(balance_due),0)::numeric(15,2) AS outstanding FROM chama_loans WHERE circle_id=:id AND status='active'",{id}),
 q("SELECT (COALESCE((SELECT SUM(amount) FROM money_contributions WHERE circle_id=:id AND status='paid'),0)+COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0))::numeric(15,2) AS balance FROM chama_ledger_entries WHERE circle_id=:id AND status='posted'",{id}),
 q("SELECT amount,details->>'frequency' AS frequency FROM chama_extended_records WHERE circle_id=:id AND kind='contribution-schedule' AND status='active'",{id})
 ]);
 const rep=new Map(repayments.map(x=>[Number(x.borrower_id),x]));let credit=memberRows.map(x=>{const rr=rep.get(Number(x.user_id))||{repayments:0,repaid:0};const score=Math.max(300,Math.min(850,300+Math.min(350,Number(x.paid_count)*25)+Math.min(200,Number(rr.repayments)*30)));return{memberId:Number(x.user_id),contributions:Number(x.paid_total),contributionCount:Number(x.paid_count),repayments:Number(rr.repayments),repaid:Number(rr.repaid),indicativeScore:score,band:score>=700?'strong':score>=550?'developing':'limited-history'};});
 if(!['owner','chairperson','treasurer'].includes(c.role))credit=credit.filter(x=>x.memberId===actor);const monthly=schedules.reduce((n,x)=>n+Number(x.amount||0)*(x.frequency==='weekly'?4.33:x.frequency==='fortnightly'?2:x.frequency==='quarterly'?1/3:1),0)*memberRows.length;
 res.json({success:true,currency:'KES',balance:Number(totals[0]?.balance||0),activeLoans:Number(loans[0]?.count||0),loanExposure:Number(loans[0]?.outstanding||0),estimatedMonthlyContributions:Math.round(monthly*100)/100,threeMonthContributionProjection:Math.round(monthly*3*100)/100,credit,disclaimer:'Indicative internal participation indicators only; not a regulated credit score or lending decision.'});
}));
router.get('/circles/:id/loans/:loanId/schedule',wrap(async(req,res)=>{
 await circle(req.params.id,uid(req));const rows=await q("SELECT id,principal,total_due,balance_due,term_months,status,disbursed_at FROM chama_loans WHERE id=:loanId AND circle_id=:id",{loanId:req.params.loanId,id:req.params.id});const l=rows[0];if(!l)throw err(404,'Loan not found.');
 const pays=await q("SELECT amount,created_at FROM chama_loan_repayments WHERE loan_id=:loanId ORDER BY created_at",{loanId:l.id});const total=Number(l.total_due||l.principal),term=Math.max(1,Number(l.term_months||1)),installment=Math.round(total/term*100)/100;let paid=0;
 const schedule=Array.from({length:term},(_,i)=>{const due=Math.round((i===term-1?total-installment*(term-1):installment)*100)/100;const received=Number(pays.reduce((n,p)=>n+Number(p.amount),0));const got=Math.min(due,Math.max(0,received-paid));paid+=got;const base=l.disbursed_at?new Date(l.disbursed_at):new Date();const date=new Date(base);date.setMonth(date.getMonth()+i+1);return{installment:i+1,dueDate:date.toISOString(),due,paid:got,balance:Math.max(0,due-got)}});
 res.json({success:true,loanId:l.id,totalDue:total,outstanding:Number(l.balance_due||0),schedule,repayments:pays});
}));

module.exports=router;
