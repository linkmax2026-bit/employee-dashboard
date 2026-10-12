import express from 'express';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');
const app = express();
app.use(express.json());
app.use(session({secret: process.env.SESSION_SECRET || 'change-this-secret', resave:false, saveUninitialized:false, cookie:{httpOnly:true, sameSite:'lax'}}));

function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password,stored){
  if(!stored) return false;
  if(!stored.startsWith('scrypt:')) return stored===password;
  const [,salt,hash]=stored.split(':');
  const derived=crypto.scryptSync(String(password),salt,64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(derived,'hex'));
}
function ensurePasswordHashes(d){
  let changed=false;
  for(const u of d.users){ if(!String(u.password||'').startsWith('scrypt:')){ u.password=hashPassword(u.password); changed=true; } }
  if(changed) write(d);
}

function seed(){
  if(fs.existsSync(DATA_FILE)) return;
  const now=new Date().toISOString();
  const employees=[
    {id:1,name:'سالي',username:'sally',group:'المجموعة الأولى',salary:2000},
    {id:2,name:'هادي',username:'hadi',group:'المجموعة الأولى',salary:2000},
    {id:3,name:'بدر',username:'badr',group:'المجموعة الثانية',salary:1800},
    {id:4,name:'رغد',username:'raghad',group:'المجموعة الثانية',salary:1800}
  ];
  const data={users:[{id:1,username:'admin',password:'admin123',role:'admin'},{id:2,username:'sally',password:'123456',role:'employee',employee_id:1},{id:3,username:'hadi',password:'123456',role:'employee',employee_id:2},{id:4,username:'badr',password:'123456',role:'employee',employee_id:3},{id:5,username:'raghad',password:'123456',role:'employee',employee_id:4}],employees,attendance:[],expenses:[],payments:[],createdAt:now};
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2));
}
seed();
const read=()=>{const d=JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); ensurePasswordHashes(d); return d;};
const write=d=>fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2));
const auth=(req,res,next)=>{if(!req.session.user)return res.status(401).json({error:'غير مسجل الدخول'});next()};
const admin=(req,res,next)=>{if(req.session.user?.role!=='admin')return res.status(403).json({error:'صلاحية المشرف فقط'});next()};
const canAccess=(req,id)=>req.session.user.role==='admin'||Number(req.session.user.employee_id)===Number(id);

app.post('/api/login',(req,res)=>{const {username,password}=req.body||{};const d=read();const u=d.users.find(x=>x.username===username&&verifyPassword(password,x.password));if(!u)return res.status(401).json({error:'اسم المستخدم أو كلمة المرور غير صحيحة'});req.session.user={id:u.id,username:u.username,role:u.role,employee_id:u.employee_id||null};res.json({user:req.session.user});});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',auth,(req,res)=>res.json({user:req.session.user}));

app.post('/api/password/change',auth,(req,res)=>{
  const {currentPassword,newPassword}=req.body||{};
  if(!newPassword || String(newPassword).length<6) return res.status(400).json({error:'كلمة السر الجديدة يجب أن تكون 6 أحرف أو أرقام على الأقل'});
  const d=read(); const u=d.users.find(x=>x.id===req.session.user.id);
  if(!u || !verifyPassword(currentPassword,u.password)) return res.status(400).json({error:'كلمة السر الحالية غير صحيحة'});
  u.password=hashPassword(newPassword); write(d); res.json({ok:true});
});
app.post('/api/admin/password/:userId',auth,admin,(req,res)=>{
  const {newPassword}=req.body||{};
  if(!newPassword || String(newPassword).length<6) return res.status(400).json({error:'كلمة السر يجب أن تكون 6 أحرف أو أرقام على الأقل'});
  const d=read(); const u=d.users.find(x=>x.id===Number(req.params.userId));
  if(!u) return res.status(404).json({error:'المستخدم غير موجود'});
  u.password=hashPassword(newPassword); write(d); res.json({ok:true});
});
app.get('/api/admin/users',auth,admin,(req,res)=>{
  const d=read(); res.json(d.users.map(u=>({id:u.id,username:u.username,role:u.role,employee_id:u.employee_id||null})));
});

app.get('/api/employees',auth,(req,res)=>{const d=read();res.json(req.session.user.role==='admin'?d.employees:d.employees.filter(e=>e.id===req.session.user.employee_id));});
app.put('/api/employees/:id',auth,admin,(req,res)=>{const d=read();const e=d.employees.find(x=>x.id===Number(req.params.id));if(!e)return res.status(404).json({error:'الموظف غير موجود'});for(const k of ['name','group','salary'])if(req.body[k]!==undefined)e[k]=k==='salary'?Number(req.body[k])||0:req.body[k];write(d);res.json(e);});

app.get('/api/payments',auth,(req,res)=>{const d=read();let rows=d.payments;if(req.query.employee_id) {const id=Number(req.query.employee_id);if(!canAccess(req,id))return res.status(403).json({error:'ممنوع'});rows=rows.filter(x=>x.employee_id===id);} else if(req.session.user.role!=='admin') rows=rows.filter(x=>x.employee_id===req.session.user.employee_id);if(req.query.month)rows=rows.filter(x=>x.date?.startsWith(req.query.month));res.json(rows.sort((a,b)=>String(b.date).localeCompare(String(a.date))));});
app.post('/api/payments',auth,(req,res)=>{const d=read();const employee_id=req.session.user.role==='admin'?Number(req.body.employee_id):Number(req.session.user.employee_id);if(!employee_id||!d.employees.some(e=>e.id===employee_id))return res.status(400).json({error:'الموظف غير صحيح'});const amount=Number(req.body.amount);if(!(amount>0))return res.status(400).json({error:'أدخل مبلغاً صحيحاً'});const row={id:Date.now(),employee_id,amount,date:req.body.date||new Date().toISOString().slice(0,10),type:req.body.type||'دفعة',note:req.body.note||'',added_by:req.session.user.username,created_at:new Date().toISOString()};d.payments.push(row);write(d);res.json(row);});
app.put('/api/payments/:id',auth,(req,res)=>{const d=read();const p=d.payments.find(x=>x.id===Number(req.params.id));if(!p)return res.status(404).json({error:'الدفعة غير موجودة'});if(!canAccess(req,p.employee_id))return res.status(403).json({error:'ممنوع'});if(req.session.user.role!=='admin'&&req.body.amount===undefined&&req.body.date===undefined&&req.body.note===undefined&&req.body.type===undefined)return res.status(403).json({error:'ممنوع'});if(req.session.user.role!=='admin'&&req.body.amount!==undefined)return res.status(403).json({error:'تعديل المبلغ من صلاحية المشرف فقط'});if(req.body.amount!==undefined)p.amount=Number(req.body.amount);if(req.body.date!==undefined)p.date=req.body.date;if(req.body.note!==undefined)p.note=req.body.note;if(req.body.type!==undefined)p.type=req.body.type;p.edited_by=req.session.user.username;p.edited_at=new Date().toISOString();write(d);res.json(p);});
app.delete('/api/payments/:id',auth,admin,(req,res)=>{const d=read();d.payments=d.payments.filter(x=>x.id!==Number(req.params.id));write(d);res.json({ok:true});});

app.get('/api/attendance',auth,(req,res)=>{const d=read();let rows=d.attendance;if(req.query.employee_id){const id=Number(req.query.employee_id);if(!canAccess(req,id))return res.status(403).json({error:'ممنوع'});rows=rows.filter(x=>x.employee_id===id);}else if(req.session.user.role!=='admin')rows=rows.filter(x=>x.employee_id===req.session.user.employee_id);if(req.query.month)rows=rows.filter(x=>x.date.startsWith(req.query.month));res.json(rows);});
app.post('/api/attendance',auth,(req,res)=>{const d=read();const employee_id=req.session.user.role==='admin'?Number(req.body.employee_id):Number(req.session.user.employee_id);const row={id:Date.now(),employee_id,date:req.body.date,status:req.body.status||'حضور',hours:Number(req.body.hours)||0,note:req.body.note||'',added_by:req.session.user.username};d.attendance.push(row);write(d);res.json(row);});
app.delete('/api/attendance/:id',auth,admin,(req,res)=>{const d=read();d.attendance=d.attendance.filter(x=>x.id!==Number(req.params.id));write(d);res.json({ok:true});});

app.get('/api/expenses',auth,(req,res)=>{const d=read();let rows=d.expenses||[];if(req.query.employee_id){const id=Number(req.query.employee_id);if(!canAccess(req,id))return res.status(403).json({error:'ممنوع'});rows=rows.filter(x=>x.employee_id===id);} else if(req.session.user.role!=='admin'){rows=rows.filter(x=>x.employee_id===req.session.user.employee_id);}if(req.query.month)rows=rows.filter(x=>String(x.date).startsWith(req.query.month));res.json(rows.sort((a,b)=>String(b.date).localeCompare(String(a.date))));});
app.post('/api/expenses',auth,(req,res)=>{const d=read();const employee_id=req.session.user.role==='admin'?Number(req.body.employee_id):Number(req.session.user.employee_id);if(!employee_id||!d.employees.some(e=>e.id===employee_id))return res.status(400).json({error:'الموظف غير صحيح'});const amount=Number(req.body.amount);if(!(amount>0))return res.status(400).json({error:'أدخل مبلغاً صحيحاً'});const row={id:Date.now(),employee_id,amount,date:req.body.date||new Date().toISOString().slice(0,10),category:req.body.category||'عام',note:req.body.note||'',added_by:req.session.user.username,created_at:new Date().toISOString()};d.expenses.push(row);write(d);res.json(row);});
app.put('/api/expenses/:id',auth,admin,(req,res)=>{const d=read();const x=d.expenses.find(x=>x.id===Number(req.params.id));if(!x)return res.status(404).json({error:'المصروف غير موجود'});if(req.body.employee_id!==undefined)x.employee_id=Number(req.body.employee_id);if(req.body.amount!==undefined)x.amount=Number(req.body.amount);if(req.body.date!==undefined)x.date=req.body.date;if(req.body.category!==undefined)x.category=req.body.category;if(req.body.note!==undefined)x.note=req.body.note;x.edited_by=req.session.user.username;x.edited_at=new Date().toISOString();write(d);res.json(x);});
app.delete('/api/expenses/:id',auth,admin,(req,res)=>{const d=read();d.expenses=d.expenses.filter(x=>x.id!==Number(req.params.id));write(d);res.json({ok:true});});

app.get('/api/report',auth,(req,res)=>{const d=read();const month=req.query.month||new Date().toISOString().slice(0,7);const emps=req.session.user.role==='admin'?d.employees:d.employees.filter(e=>e.id===req.session.user.employee_id);const result=emps.map(e=>{const pays=d.payments.filter(p=>p.employee_id===e.id&&p.date.startsWith(month));const exp=(d.expenses||[]).filter(x=>x.employee_id===e.id&&x.date.startsWith(month));const att=d.attendance.filter(a=>a.employee_id===e.id&&a.date.startsWith(month));const received=pays.reduce((s,p)=>s+p.amount,0);const expenses=exp.reduce((s,x)=>s+x.amount,0);return {...e,received,balance:e.salary-received,payments:pays,expenses:exp,expense_total:expenses,attendance:att,days:att.filter(a=>a.status==='حضور').length,absences:att.filter(a=>a.status==='غياب').length,hours:att.reduce((s,a)=>s+(a.hours||0),0)};});res.json({month,employees:result,expenses:req.session.user.role==='admin'?(d.expenses||[]).filter(x=>x.date.startsWith(month)):result[0]?.expenses||[]});});
app.get('/api/backup',auth,admin,(req,res)=>{res.download(DATA_FILE,'employee-dashboard-backup.json');});
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(process.env.PORT||3000,()=>console.log(`Employee dashboard running on http://localhost:${process.env.PORT||3000}`));
