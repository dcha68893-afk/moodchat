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
module.exports=router;
