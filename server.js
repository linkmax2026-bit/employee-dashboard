import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Render runs behind a reverse proxy. Trust its HTTPS forwarding headers so
// express-session can keep secure cookies working after login.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const hasDatabase = Boolean(process.env.DATABASE_URL);

app.use(express.json({ limit: '1mb' }));
app.use((req,res,next)=>{if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');next();});
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 12 }
}));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt:')) return stored === password;
  const [, salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

let pool = null;
if (hasDatabase) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
}

const localFile = path.join(__dirname, 'data.json');
function localSeed() {
  if (fs.existsSync(localFile)) return;
  const employees = [
    { id: 1, name: 'سالي', username: 'sally', group: 'المجموعة الأولى', salary: 2000 },
    { id: 2, name: 'هادي', username: 'hadi', group: 'المجموعة الأولى', salary: 2000 },
    { id: 3, name: 'بدر', username: 'badr', group: 'المجموعة الثانية', salary: 1800 },
    { id: 4, name: 'رغد', username: 'raghad', group: 'المجموعة الثانية', salary: 1800 }
  ];
  fs.writeFileSync(localFile, JSON.stringify({
    users: [
      { id: 1, username: 'admin', password: hashPassword('admin123'), role: 'admin' },
      { id: 2, username: 'sally', password: hashPassword('123456'), role: 'employee', employee_id: 1 },
      { id: 3, username: 'hadi', password: hashPassword('123456'), role: 'employee', employee_id: 2 },
      { id: 4, username: 'badr', password: hashPassword('123456'), role: 'employee', employee_id: 3 },
      { id: 5, username: 'raghad', password: hashPassword('123456'), role: 'employee', employee_id: 4 }
    ], employees, attendance: [], expenses: [], payments: [], incomes: [], createdAt: now()
  }, null, 2));
}
if (!hasDatabase) {
  if (isProduction) throw new Error('DATABASE_URL is required in production.');
  localSeed();
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      employee_group TEXT NOT NULL,
      salary NUMERIC(12,2) NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','employee')),
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'حضور',
      hours NUMERIC(8,2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      added_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      date DATE NOT NULL,
      type TEXT NOT NULL DEFAULT 'دفعة',
      note TEXT DEFAULT '',
      added_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      edited_by TEXT,
      edited_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id BIGSERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      date DATE NOT NULL,
      category TEXT NOT NULL DEFAULT 'عام',
      note TEXT DEFAULT '',
      added_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      edited_by TEXT,
      edited_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS incomes (
      id BIGSERIAL PRIMARY KEY,
      amount NUMERIC(12,2) NOT NULL,
      date DATE NOT NULL,
      category TEXT NOT NULL DEFAULT 'عام',
      note TEXT DEFAULT '',
      added_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      edited_by TEXT,
      edited_at TIMESTAMPTZ
    );
  `);
  // Seed / repair default employees and users
  const defaultEmployees = [
    ['سالي', 'sally', 'المجموعة الأولى', 2000],
    ['هادي', 'hadi', 'المجموعة الأولى', 2000],
    ['بدر', 'badr', 'المجموعة الثانية', 1800],
    ['رغد', 'raghad', 'المجموعة الثانية', 1800]
  ];

  for (const [name, username, group, salary] of defaultEmployees) {
    await pool.query(
      `INSERT INTO employees (name, username, employee_group, salary)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      [name, username, group, salary]
    );
  }

  const emps = (
    await pool.query(
      'SELECT id, username FROM employees ORDER BY id'
    )
  ).rows;

  const employeeUsers = [
    ['sally', '123456'],
    ['hadi', '123456'],
    ['badr', '123456'],
    ['raghad', '123456']
  ];

  // Make sure admin account always exists and has admin123
  await pool.query(
    `INSERT INTO users (username, password, role, employee_id)
     VALUES ($1, $2, 'admin', NULL)
     ON CONFLICT (username)
     DO UPDATE SET password = EXCLUDED.password,
                   role = 'admin',
                   employee_id = NULL`,
    ['admin', hashPassword('admin123')]
  );

  // Make sure employee accounts exist
  for (const [username, password] of employeeUsers) {
    const employee = emps.find(x => x.username === username);

    if (!employee) continue;

    await pool.query(
      `INSERT INTO users (username, password, role, employee_id)
       VALUES ($1, $2, 'employee', $3)
       ON CONFLICT (username)
       DO UPDATE SET password = EXCLUDED.password,
                     role = 'employee',
                     employee_id = EXCLUDED.employee_id`,
      [username, hashPassword(password), employee.id]
    );
  }
}

function readLocal() { return JSON.parse(fs.readFileSync(localFile, 'utf8')); }
function writeLocal(d) { fs.writeFileSync(localFile, JSON.stringify(d, null, 2)); }
async function dbUser(username) { return (await pool.query('SELECT id,username,password,role,employee_id FROM users WHERE username=$1', [username])).rows[0]; }
async function dbEmployees(adminOnly=false, employeeId=null) {
  const q = adminOnly ? 'SELECT id,name,username,employee_group AS "group",salary::float AS salary FROM employees ORDER BY id' : 'SELECT id,name,username,employee_group AS "group",salary::float AS salary FROM employees WHERE id=$1';
  return (await pool.query(q, adminOnly ? [] : [employeeId])).rows;
}
function sessionUser(req) { return req.session.user; }
const auth = (req,res,next) => { if (!sessionUser(req)) return res.status(401).json({error:'غير مسجل الدخول'}); next(); };
const admin = (req,res,next) => { if (sessionUser(req)?.role !== 'admin') return res.status(403).json({error:'صلاحية المشرف فقط'}); next(); };
const canAccess = (req,id) => req.session.user.role === 'admin' || Number(req.session.user.employee_id) === Number(id);
function monthValue(value) { return /^\d{4}-\d{2}$/.test(String(value||'')) ? String(value) : today().slice(0,7); }

app.post('/api/login', async (req,res) => {
  try {
    const {username,password} = req.body || {};
    let u;
    if (pool) u = await dbUser(username);
    else u = readLocal().users.find(x=>x.username===username);
    if (!u || !verifyPassword(password,u.password)) return res.status(401).json({error:'اسم المستخدم أو كلمة المرور غير صحيحة'});
    req.session.user = {id:u.id, username:u.username, role:u.role, employee_id:u.employee_id || null};
    res.json({user:req.session.user});
  } catch (e) { res.status(500).json({error:'خطأ في تسجيل الدخول'}); }
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',auth,(req,res)=>res.json({user:req.session.user}));

app.post('/api/password/change',auth,async(req,res)=>{
  try {
    const {currentPassword,newPassword}=req.body||{};
    if (!newPassword || String(newPassword).length<6) return res.status(400).json({error:'كلمة السر الجديدة يجب أن تكون 6 أحرف أو أرقام على الأقل'});
    if (pool) {
      const u=(await pool.query('SELECT * FROM users WHERE id=$1',[req.session.user.id])).rows[0];
      if(!u||!verifyPassword(currentPassword,u.password)) return res.status(400).json({error:'كلمة السر الحالية غير صحيحة'});
      await pool.query('UPDATE users SET password=$1 WHERE id=$2',[hashPassword(newPassword),u.id]);
    } else {
      const d=readLocal(),u=d.users.find(x=>x.id===req.session.user.id);
      if(!u||!verifyPassword(currentPassword,u.password)) return res.status(400).json({error:'كلمة السر الحالية غير صحيحة'});
      u.password=hashPassword(newPassword); writeLocal(d);
    }
    res.json({ok:true});
  } catch(e){res.status(500).json({error:'تعذر تغيير كلمة السر'});}
});
app.post('/api/admin/password/:userId',auth,admin,async(req,res)=>{
  try {
    const {newPassword}=req.body||{}; if(!newPassword||String(newPassword).length<6)return res.status(400).json({error:'كلمة السر يجب أن تكون 6 أحرف أو أرقام على الأقل'});
    if(pool){const r=await pool.query('UPDATE users SET password=$1 WHERE id=$2 RETURNING id',[hashPassword(newPassword),Number(req.params.userId)]);if(!r.rowCount)return res.status(404).json({error:'المستخدم غير موجود'});}else{const d=readLocal(),u=d.users.find(x=>x.id===Number(req.params.userId));if(!u)return res.status(404).json({error:'المستخدم غير موجود'});u.password=hashPassword(newPassword);writeLocal(d);}res.json({ok:true});
  }catch(e){res.status(500).json({error:'تعذر تغيير كلمة السر'});}
});
app.get('/api/admin/users',auth,admin,async(req,res)=>{if(pool)return res.json((await pool.query('SELECT id,username,role,employee_id FROM users ORDER BY id')).rows);res.json(readLocal().users.map(u=>({id:u.id,username:u.username,role:u.role,employee_id:u.employee_id||null})));});

app.get('/api/employees',auth,async(req,res)=>{if(pool)return res.json(await dbEmployees(req.session.user.role==='admin',req.session.user.employee_id));const d=readLocal();res.json(req.session.user.role==='admin'?d.employees:d.employees.filter(e=>e.id===req.session.user.employee_id));});
app.put('/api/employees/:id',auth,admin,async(req,res)=>{const id=Number(req.params.id);if(pool){const r=await pool.query('UPDATE employees SET name=COALESCE($1,name), employee_group=COALESCE($2,employee_group), salary=COALESCE($3,salary) WHERE id=$4 RETURNING id,name,username,employee_group AS "group",salary::float AS salary',[req.body.name??null,req.body.group??null,req.body.salary===undefined?null:Number(req.body.salary)||0,id]);if(!r.rowCount)return res.status(404).json({error:'الموظف غير موجود'});return res.json(r.rows[0]);}const d=readLocal(),e=d.employees.find(x=>x.id===id);if(!e)return res.status(404).json({error:'الموظف غير موجود'});for(const k of ['name','group','salary'])if(req.body[k]!==undefined)e[k]=k==='salary'?Number(req.body[k])||0:req.body[k];writeLocal(d);res.json(e);});

app.get('/api/payments',auth,async(req,res)=>{const month=req.query.month;let id=req.query.employee_id?Number(req.query.employee_id):null;if(id&&!canAccess(req,id))return res.status(403).json({error:'ممنوع'});if(!id&&req.session.user.role!=='admin')id=req.session.user.employee_id;if(pool){let q='SELECT id,employee_id,amount::float AS amount,date::text,type,note,added_by,created_at,edited_by,edited_at FROM payments WHERE 1=1';const a=[];if(id){a.push(id);q+=` AND employee_id=$${a.length}`;}if(month){a.push(`${month}-01`);q+=` AND date >= $${a.length}::date AND date < ($${a.length}::date + INTERVAL '1 month')`;}q+=' ORDER BY date DESC,id DESC';return res.json((await pool.query(q,a)).rows);}let rows=readLocal().payments;if(id)rows=rows.filter(x=>x.employee_id===id);if(month)rows=rows.filter(x=>x.date?.startsWith(month));res.json(rows.sort((a,b)=>String(b.date).localeCompare(String(a.date))));});
app.post('/api/payments',auth,async(req,res)=>{const employee_id=req.session.user.role==='admin'?Number(req.body.employee_id):Number(req.session.user.employee_id),amount=Number(req.body.amount),date=req.body.date||today(),type=req.body.type||'دفعة',note=req.body.note||'';if(!(amount>0))return res.status(400).json({error:'أدخل مبلغاً صحيحاً'});if(pool){const r=await pool.query('INSERT INTO payments(employee_id,amount,date,type,note,added_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,employee_id,amount::float AS amount,date::text,type,note,added_by,created_at',[employee_id,amount,date,type,note,req.session.user.username]);return res.json(r.rows[0]);}const d=readLocal(),row={id:Date.now(),employee_id,amount,date,type,note,added_by:req.session.user.username,created_at:now()};d.payments.push(row);writeLocal(d);res.json(row);});
app.put('/api/payments/:id',auth,admin,async(req,res)=>{const id=Number(req.params.id);if(pool){const p=(await pool.query('SELECT * FROM payments WHERE id=$1',[id])).rows[0];if(!p)return res.status(404).json({error:'الدفعة غير موجودة'});if(!canAccess(req,p.employee_id))return res.status(403).json({error:'ممنوع'});if(req.session.user.role!=='admin'&&req.body.amount!==undefined)return res.status(403).json({error:'تعديل المبلغ من صلاحية المشرف فقط'});const r=await pool.query('UPDATE payments SET amount=COALESCE($1,amount),date=COALESCE($2,date),type=COALESCE($3,type),note=COALESCE($4,note),edited_by=$5,edited_at=NOW() WHERE id=$6 RETURNING id,employee_id,amount::float AS amount,date::text,type,note,added_by,created_at,edited_by,edited_at',[req.body.amount===undefined?null:Number(req.body.amount),req.body.date||null,req.body.type||null,req.body.note===undefined?null:req.body.note,req.session.user.username,id]);return res.json(r.rows[0]);}const d=readLocal(),p=d.payments.find(x=>x.id===id);if(!p)return res.status(404).json({error:'الدفعة غير موجودة'});if(!canAccess(req,p.employee_id))return res.status(403).json({error:'ممنوع'});if(req.session.user.role!=='admin'&&req.body.amount!==undefined)return res.status(403).json({error:'تعديل المبلغ من صلاحية المشرف فقط'});Object.assign(p,{amount:req.body.amount===undefined?p.amount:Number(req.body.amount),date:req.body.date??p.date,type:req.body.type??p.type,note:req.body.note??p.note,edited_by:req.session.user.username,edited_at:now()});writeLocal(d);res.json(p);});
app.delete('/api/payments/:id',auth,admin,async(req,res)=>{if(pool){await pool.query('DELETE FROM payments WHERE id=$1',[Number(req.params.id)]);return res.json({ok:true});}const d=readLocal();d.payments=d.payments.filter(x=>x.id!==Number(req.params.id));writeLocal(d);res.json({ok:true});});

app.get('/api/attendance',auth,async(req,res)=>{let id=req.query.employee_id?Number(req.query.employee_id):null;if(id&&!canAccess(req,id))return res.status(403).json({error:'ممنوع'});if(!id&&req.session.user.role!=='admin')id=req.session.user.employee_id;const month=req.query.month;if(pool){let q='SELECT id,employee_id,date::text,status,hours::float AS hours,note,added_by,created_at FROM attendance WHERE 1=1',a=[];if(id){a.push(id);q+=` AND employee_id=$${a.length}`;}if(month){a.push(month);q+=` AND date >= $${a.length}::date AND date < ($${a.length}::date + INTERVAL '1 month')`;}q+=' ORDER BY date DESC,id DESC';return res.json((await pool.query(q,a)).rows);}let rows=readLocal().attendance;if(id)rows=rows.filter(x=>x.employee_id===id);if(month)rows=rows.filter(x=>x.date.startsWith(month));res.json(rows);});
app.post('/api/attendance',auth,async(req,res)=>{const employee_id=req.session.user.role==='admin'?Number(req.body.employee_id):Number(req.session.user.employee_id),date=req.body.date||today(),status=req.body.status||'حضور',hours=Number(req.body.hours)||0,note=req.body.note||'';if(pool){const r=await pool.query('INSERT INTO attendance(employee_id,date,status,hours,note,added_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,employee_id,date::text,status,hours::float AS hours,note,added_by,created_at',[employee_id,date,status,hours,note,req.session.user.username]);return res.json(r.rows[0]);}const d=readLocal(),row={id:Date.now(),employee_id,date,status,hours,note,added_by:req.session.user.username};d.attendance.push(row);writeLocal(d);res.json(row);});
app.put('/api/attendance/:id',auth,admin,async(req,res)=>{const id=Number(req.params.id);const employee_id=req.body.employee_id===undefined?null:Number(req.body.employee_id);const date=req.body.date||null;const status=req.body.status||null;const hours=req.body.hours===undefined?null:Number(req.body.hours)||0;const note=req.body.note===undefined?null:req.body.note;if(pool){const r=await pool.query('UPDATE attendance SET employee_id=COALESCE($1,employee_id),date=COALESCE($2,date),status=COALESCE($3,status),hours=COALESCE($4,hours),note=COALESCE($5,note) WHERE id=$6 RETURNING id,employee_id,date::text,status,hours::float AS hours,note,added_by,created_at',[employee_id,date,status,hours,note,id]);if(!r.rowCount)return res.status(404).json({error:'سجل الحضور غير موجود'});return res.json(r.rows[0]);}const d=readLocal(),a=d.attendance.find(x=>x.id===id);if(!a)return res.status(404).json({error:'سجل الحضور غير موجود'});if(req.body.employee_id!==undefined)a.employee_id=Number(req.body.employee_id);if(req.body.date!==undefined)a.date=req.body.date;if(req.body.status!==undefined)a.status=req.body.status;if(req.body.hours!==undefined)a.hours=Number(req.body.hours)||0;if(req.body.note!==undefined)a.note=req.body.note;writeLocal(d);res.json(a);});
app.delete('/api/attendance/:id',auth,admin,async(req,res)=>{if(pool)await pool.query('DELETE FROM attendance WHERE id=$1',[Number(req.params.id)]);else{const d=readLocal();d.attendance=d.attendance.filter(x=>x.id!==Number(req.params.id));writeLocal(d);}res.json({ok:true});});

app.get('/api/expenses',auth,async(req,res)=>{let id=req.query.employee_id?Number(req.query.employee_id):null;if(id&&!canAccess(req,id))return res.status(403).json({error:'ممنوع'});if(!id&&req.session.user.role!=='admin')id=req.session.user.employee_id;const month=req.query.month;if(pool){let q='SELECT id,employee_id,amount::float AS amount,date::text,category,note,added_by,created_at,edited_by,edited_at FROM expenses WHERE 1=1',a=[];if(id){a.push(id);q+=` AND employee_id=$${a.length}`;}if(month){a.push(month);q+=` AND date >= $${a.length}::date AND date < ($${a.length}::date + INTERVAL '1 month')`;}q+=' ORDER BY date DESC,id DESC';return res.json((await pool.query(q,a)).rows);}let rows=readLocal().expenses||[];if(id)rows=rows.filter(x=>x.employee_id===id);if(month)rows=rows.filter(x=>String(x.date).startsWith(month));res.json(rows.sort((a,b)=>String(b.date).localeCompare(String(a.date))));});
app.post('/api/expenses',auth,async(req,res)=>{const employee_id=req.session.user.role==='admin'?Number(req.body.employee_id):Number(req.session.user.employee_id),amount=Number(req.body.amount),date=req.body.date||today(),category=req.body.category||'عام',note=req.body.note||'';if(!(amount>0))return res.status(400).json({error:'أدخل مبلغاً صحيحاً'});if(pool){const r=await pool.query('INSERT INTO expenses(employee_id,amount,date,category,note,added_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,employee_id,amount::float AS amount,date::text,category,note,added_by,created_at',[employee_id,amount,date,category,note,req.session.user.username]);return res.json(r.rows[0]);}const d=readLocal(),row={id:Date.now(),employee_id,amount,date,category,note,added_by:req.session.user.username,created_at:now()};d.expenses.push(row);writeLocal(d);res.json(row);});
app.put('/api/expenses/:id',auth,admin,async(req,res)=>{const id=Number(req.params.id);if(pool){const r=await pool.query('UPDATE expenses SET employee_id=COALESCE($1,employee_id),amount=COALESCE($2,amount),date=COALESCE($3,date),category=COALESCE($4,category),note=COALESCE($5,note),edited_by=$6,edited_at=NOW() WHERE id=$7 RETURNING id,employee_id,amount::float AS amount,date::text,category,note,added_by,created_at,edited_by,edited_at',[req.body.employee_id===undefined?null:Number(req.body.employee_id),req.body.amount===undefined?null:Number(req.body.amount),req.body.date||null,req.body.category||null,req.body.note===undefined?null:req.body.note,req.session.user.username,id]);if(!r.rowCount)return res.status(404).json({error:'المصروف غير موجود'});return res.json(r.rows[0]);}const d=readLocal(),x=d.expenses.find(x=>x.id===id);if(!x)return res.status(404).json({error:'المصروف غير موجود'});if(req.body.employee_id!==undefined)x.employee_id=Number(req.body.employee_id);if(req.body.amount!==undefined)x.amount=Number(req.body.amount);if(req.body.date!==undefined)x.date=req.body.date;if(req.body.category!==undefined)x.category=req.body.category;if(req.body.note!==undefined)x.note=req.body.note;x.edited_by=req.session.user.username;x.edited_at=now();writeLocal(d);res.json(x);});
app.delete('/api/expenses/:id',auth,admin,async(req,res)=>{if(pool)await pool.query('DELETE FROM expenses WHERE id=$1',[Number(req.params.id)]);else{const d=readLocal();d.expenses=d.expenses.filter(x=>x.id!==Number(req.params.id));writeLocal(d);}res.json({ok:true});});

/* =========================
   INCOMES / REVENUES
========================= */

app.get('/api/incomes', auth, async (req, res) => {
  try {
    const month = req.query.month;

    if (pool) {
      let q = 'SELECT id,amount::float AS amount,date::text,category,note,added_by,created_at,edited_by,edited_at FROM incomes WHERE 1=1';
      const a = [];

      if (month) {
        a.push(`${month}-01`);
        q += ` AND date >= $${a.length}::date AND date < ($${a.length}::date + INTERVAL '1 month')`;
      }

      q += ' ORDER BY date DESC,id DESC';
      return res.json((await pool.query(q, a)).rows);
    }

    const d = readLocal();
    let rows = d.incomes || [];

    if (month) {
      rows = rows.filter(x => String(x.date).startsWith(month));
    }

    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return res.json(rows);
  } catch (e) {
    console.error('GET incomes error:', e);
    res.status(500).json({ error: 'تعذر تحميل الإيرادات' });
  }
});

app.post('/api/incomes', auth, admin, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const date = req.body.date || today();
    const category = String(req.body.category || 'عام').trim() || 'عام';
    const note = String(req.body.note || '');

    if (!(amount > 0) || !Number.isFinite(amount)) {
      return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً' });
    }

    if (pool) {
      const r = await pool.query(
        'INSERT INTO incomes(amount,date,category,note,added_by) VALUES($1,$2,$3,$4,$5) RETURNING id,amount::float AS amount,date::text,category,note,added_by,created_at',
        [amount, date, category, note, req.session.user.username]
      );
      return res.json(r.rows[0]);
    }

    const d = readLocal();
    if (!Array.isArray(d.incomes)) d.incomes = [];

    const row = {
      id: Date.now(),
      amount,
      date,
      category,
      note,
      added_by: req.session.user.username,
      created_at: now()
    };

    d.incomes.push(row);
    writeLocal(d);
    return res.json(row);
  } catch (e) {
    console.error('POST incomes error:', e);
    res.status(500).json({ error: 'تعذر إضافة الإيراد' });
  }
});

app.put('/api/incomes/:id', auth, admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (
      req.body.amount !== undefined &&
      (!(Number(req.body.amount) > 0) ||
        !Number.isFinite(Number(req.body.amount)))
    ) {
      return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً' });
    }

    if (pool) {
      const r = await pool.query(
        'UPDATE incomes SET amount=COALESCE($1,amount),date=COALESCE($2,date),category=COALESCE($3,category),note=COALESCE($4,note),edited_by=$5,edited_at=NOW() WHERE id=$6 RETURNING id,amount::float AS amount,date::text,category,note,added_by,created_at,edited_by,edited_at',
        [
          req.body.amount === undefined ? null : Number(req.body.amount),
          req.body.date || null,
          req.body.category === undefined
            ? null
            : (String(req.body.category).trim() || 'عام'),
          req.body.note === undefined ? null : String(req.body.note),
          req.session.user.username,
          id
        ]
      );

      if (!r.rowCount) {
        return res.status(404).json({ error: 'الإيراد غير موجود' });
      }

      return res.json(r.rows[0]);
    }

    const d = readLocal();
    if (!Array.isArray(d.incomes)) d.incomes = [];

    const x = d.incomes.find(x => Number(x.id) === id);

    if (!x) {
      return res.status(404).json({ error: 'الإيراد غير موجود' });
    }

    if (req.body.amount !== undefined) x.amount = Number(req.body.amount);
    if (req.body.date !== undefined) x.date = req.body.date;
    if (req.body.category !== undefined) {
      x.category = String(req.body.category).trim() || 'عام';
    }
    if (req.body.note !== undefined) x.note = String(req.body.note);

    x.edited_by = req.session.user.username;
    x.edited_at = now();

    writeLocal(d);
    return res.json(x);
  } catch (e) {
    console.error('PUT incomes error:', e);
    res.status(500).json({ error: 'تعذر تعديل الإيراد' });
  }
});

app.delete('/api/incomes/:id', auth, admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (pool) {
      const r = await pool.query(
        'DELETE FROM incomes WHERE id=$1',
        [id]
      );

      if (!r.rowCount) {
        return res.status(404).json({ error: 'الإيراد غير موجود' });
      }

      return res.json({ ok: true });
    }

    const d = readLocal();
    d.incomes = (d.incomes || []).filter(x => Number(x.id) !== id);
    writeLocal(d);

    return res.json({ ok: true });
  } catch (e) {
    console.error('DELETE incomes error:', e);
    res.status(500).json({ error: 'تعذر حذف الإيراد' });
  }
});

/* =========================
   MONTHLY REPORT
========================= */

app.get('/api/report', auth, async (req, res) => {
  try {
    const month = monthValue(req.query.month);
    const monthStart = `${month}-01`;

    if (pool) {
      const employees = await dbEmployees(
        req.session.user.role === 'admin',
        req.session.user.employee_id
      );

      const result = [];

      for (const e of employees) {
        const p = (await pool.query(
          "SELECT id,employee_id,amount::float AS amount,date::text,type,note,added_by FROM payments WHERE employee_id=$1 AND date >= $2::date AND date < ($2::date + INTERVAL '1 month') ORDER BY date",
          [e.id, monthStart]
        )).rows;

        const ex = (await pool.query(
          "SELECT id,employee_id,amount::float AS amount,date::text,category,note,added_by FROM expenses WHERE employee_id=$1 AND date >= $2::date AND date < ($2::date + INTERVAL '1 month') ORDER BY date",
          [e.id, monthStart]
        )).rows;

        const at = (await pool.query(
          "SELECT id,employee_id,date::text,status,hours::float AS hours,note FROM attendance WHERE employee_id=$1 AND date >= $2::date AND date < ($2::date + INTERVAL '1 month') ORDER BY date",
          [e.id, monthStart]
        )).rows;

        const received = p.reduce(
          (sum, x) => sum + Number(x.amount || 0), 0
        );

        const expense_total = ex.reduce(
          (sum, x) => sum + Number(x.amount || 0), 0
        );

        result.push({
          ...e,
          received,
          balance: Number(e.salary) - received,
          payments: p,
          expenses: ex,
          expense_total,
          attendance: at,
          days: at.filter(a => a.status === 'حضور').length,
          absences: at.filter(a => a.status === 'غياب').length,
          hours: at.reduce((sum, a) => sum + Number(a.hours || 0), 0)
        });
      }

      const incomes = (await pool.query(
        "SELECT id,amount::float AS amount,date::text,category,note,added_by FROM incomes WHERE date >= $1::date AND date < ($1::date + INTERVAL '1 month') ORDER BY date,id",
        [monthStart]
      )).rows;

      const income_total = incomes.reduce(
        (sum, x) => sum + Number(x.amount || 0), 0
      );

      const allExp = result.flatMap(x => x.expenses);

      return res.json({
        month,
        employees: result,
        expenses: allExp,
        incomes,
        income_total
      });
    }

    const d = readLocal();

    const emps = req.session.user.role === 'admin'
      ? d.employees
      : d.employees.filter(
          e => e.id === req.session.user.employee_id
        );

    const result = emps.map(e => {
      const pays = (d.payments || []).filter(
        p => p.employee_id === e.id && String(p.date).startsWith(month)
      );

      const exp = (d.expenses || []).filter(
        x => x.employee_id === e.id && String(x.date).startsWith(month)
      );

      const att = (d.attendance || []).filter(
        a => a.employee_id === e.id && String(a.date).startsWith(month)
      );

      const received = pays.reduce(
        (sum, p) => sum + Number(p.amount || 0), 0
      );

      const expense_total = exp.reduce(
        (sum, x) => sum + Number(x.amount || 0), 0
      );

      return {
        ...e,
        received,
        balance: Number(e.salary) - received,
        payments: pays,
        expenses: exp,
        expense_total,
        attendance: att,
        days: att.filter(a => a.status === 'حضور').length,
        absences: att.filter(a => a.status === 'غياب').length,
        hours: att.reduce((sum, a) => sum + Number(a.hours || 0), 0)
      };
    });

    const incomes = (d.incomes || []).filter(
      x => String(x.date).startsWith(month)
    );

    const income_total = incomes.reduce(
      (sum, x) => sum + Number(x.amount || 0), 0
    );

    return res.json({
      month,
      employees: result,
      expenses: result.flatMap(x => x.expenses),
      incomes,
      income_total
    });
  } catch (e) {
    console.error('Monthly report error:', e);
    res.status(500).json({ error: 'تعذر تحميل التقرير الشهري' });
  }
});
app.get('/api/backup',auth,admin,async(req,res)=>{
  if(pool){
    const [users,employees,attendance,payments,expenses,incomes]=await Promise.all([
      pool.query('SELECT id,username,password,role,employee_id FROM users ORDER BY id'),
      pool.query('SELECT id,name,username,employee_group AS "group",salary::float AS salary FROM employees ORDER BY id'),
      pool.query('SELECT id,employee_id,date::text,status,hours::float AS hours,note,added_by,created_at FROM attendance ORDER BY id'),
      pool.query('SELECT id,employee_id,amount::float AS amount,date::text,type,note,added_by,created_at,edited_by,edited_at FROM payments ORDER BY id'),
      pool.query('SELECT id,employee_id,amount::float AS amount,date::text,category,note,added_by,created_at,edited_by,edited_at FROM expenses ORDER BY id'),
      pool.query('SELECT id,amount::float AS amount,date::text,category,note,added_by,created_at,edited_by,edited_at FROM incomes ORDER BY id')
    ]);
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="employee-dashboard-backup.json"');
    return res.send(JSON.stringify({users:users.rows,employees:employees.rows,attendance:attendance.rows,payments:payments.rows,expenses:expenses.rows,incomes:incomes.rows,exportedAt:now()},null,2));
  }
  const d=readLocal();res.setHeader('Content-Disposition','attachment; filename="employee-dashboard-backup.json"');res.setHeader('Content-Type','application/json; charset=utf-8');res.send(JSON.stringify({...d,incomes:d.incomes||[],exportedAt:now()},null,2));
});

app.get('/health',(req,res)=>res.json({ok:true,database:hasDatabase?'postgres':'local-file'}));
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`Employee dashboard V5 running on port ${PORT} using ${hasDatabase?'PostgreSQL':'local file'}`))).catch(err=>{console.error('Database initialization failed:',err);process.exit(1);});
