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

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const hasDatabase = Boolean(process.env.DATABASE_URL);

app.use(express.json({ limit: '1mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 12
  }
}));


// =========================
// PASSWORD FUNCTIONS
// =========================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(
    String(password),
    salt,
    64
  ).toString('hex');

  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;

  if (!stored.startsWith('scrypt:')) {
    return stored === password;
  }

  const [, salt, hash] = stored.split(':');

  const derived = crypto.scryptSync(
    String(password),
    salt,
    64
  ).toString('hex');

  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(derived, 'hex')
  );
}


// =========================
// HELPERS
// =========================

const today = () =>
  new Date().toISOString().slice(0, 10);

const now = () =>
  new Date().toISOString();


// =========================
// DATABASE
// =========================

let pool = null;

if (hasDatabase) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 5
  });
}


// =========================
// LOCAL FILE
// =========================

const localFile = path.join(__dirname, 'data.json');

function localSeed() {
  if (fs.existsSync(localFile)) return;

  const employees = [
    {
      id: 1,
      name: 'سالي',
      username: 'sally',
      group: 'المجموعة الأولى',
      salary: 2000
    },
    {
      id: 2,
      name: 'هادي',
      username: 'hadi',
      group: 'المجموعة الأولى',
      salary: 2000
    },
    {
      id: 3,
      name: 'بدر',
      username: 'badr',
      group: 'المجموعة الثانية',
      salary: 1800
    },
    {
      id: 4,
      name: 'رغد',
      username: 'raghad',
      group: 'المجموعة الثانية',
      salary: 1800
    }
  ];

  fs.writeFileSync(
    localFile,
    JSON.stringify(
      {
        users: [
          {
            id: 1,
            username: 'admin',
            password: hashPassword('admin123'),
            role: 'admin'
          },
          {
            id: 2,
            username: 'sally',
            password: hashPassword('123456'),
            role: 'employee',
            employee_id: 1
          },
          {
            id: 3,
            username: 'hadi',
            password: hashPassword('123456'),
            role: 'employee',
            employee_id: 2
          },
          {
            id: 4,
            username: 'badr',
            password: hashPassword('123456'),
            role: 'employee',
            employee_id: 3
          },
          {
            id: 5,
            username: 'raghad',
            password: hashPassword('123456'),
            role: 'employee',
            employee_id: 4
          }
        ],

        employees,
        attendance: [],
        expenses: [],
        payments: [],
        createdAt: now()
      },
      null,
      2
    )
  );
}

if (!hasDatabase) {
  if (isProduction) {
    throw new Error('DATABASE_URL is required in production.');
  }

  localSeed();
}


// =========================
// DATABASE INITIALIZATION
// =========================

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
  `);


  // ==========================================
  // CREATE / REPAIR DEFAULT EMPLOYEES
  // ==========================================

  const defaultEmployees = [
    ['سالي', 'sally', 'المجموعة الأولى', 2000],
    ['هادي', 'hadi', 'المجموعة الأولى', 2000],
    ['بدر', 'badr', 'المجموعة الثانية', 1800],
    ['رغد', 'raghad', 'المجموعة الثانية', 1800]
  ];


  for (const [name, username, group, salary] of defaultEmployees) {
    await pool.query(
      `
      INSERT INTO employees
        (name, username, employee_group, salary)

      VALUES
        ($1, $2, $3, $4)

      ON CONFLICT (username)
      DO NOTHING
      `,
      [
        name,
        username,
        group,
        salary
      ]
    );
  }


  // ==========================================
  // GET EMPLOYEES
  // ==========================================

  const emps = (
    await pool.query(
      `
      SELECT id, username
      FROM employees
      ORDER BY id
      `
    )
  ).rows;


  // ==========================================
  // EMPLOYEE DEFAULT PASSWORDS
  // ==========================================

  const employeeUsers = [
    ['sally', '123456'],
    ['hadi', '123456'],
    ['badr', '123456'],
    ['raghad', '123456']
  ];


  // ==========================================
  // CREATE / REPAIR ADMIN
  // ==========================================

  await pool.query(
    `
    INSERT INTO users
      (username, password, role, employee_id)

    VALUES
      ($1, $2, 'admin', NULL)

    ON CONFLICT (username)

    DO UPDATE SET
      password = EXCLUDED.password,
      role = 'admin',
      employee_id = NULL
    `,
    [
      'admin',
      hashPassword('admin123')
    ]
  );


  // ==========================================
  // CREATE / REPAIR EMPLOYEE ACCOUNTS
  // ==========================================

  for (const [username, password] of employeeUsers) {

    const employee = emps.find(
      x => x.username === username
    );

    if (!employee) continue;

    await pool.query(
      `
      INSERT INTO users
        (username, password, role, employee_id)

      VALUES
        ($1, $2, 'employee', $3)

      ON CONFLICT (username)

      DO UPDATE SET
        password = EXCLUDED.password,
        role = 'employee',
        employee_id = EXCLUDED.employee_id
      `,
      [
        username,
        hashPassword(password),
        employee.id
      ]
    );
  }
}


// =========================
// LOCAL FUNCTIONS
// =========================

function readLocal() {
  return JSON.parse(
    fs.readFileSync(localFile, 'utf8')
  );
}

function writeLocal(data) {
  fs.writeFileSync(
    localFile,
    JSON.stringify(data, null, 2)
  );
}


// =========================
// DATABASE HELPERS
// =========================

async function dbUser(username) {
  return (
    await pool.query(
      `
      SELECT
        id,
        username,
        password,
        role,
        employee_id

      FROM users

      WHERE username = $1
      `,
      [username]
    )
  ).rows[0];
}


async function dbEmployees(
  adminOnly = false,
  employeeId = null
) {

  const query = adminOnly
    ? `
      SELECT
        id,
        name,
        username,
        employee_group AS "group",
        salary::float AS salary

      FROM employees

      ORDER BY id
      `
    : `
      SELECT
        id,
        name,
        username,
        employee_group AS "group",
        salary::float AS salary

      FROM employees

      WHERE id = $1
      `;

  return (
    await pool.query(
      query,
      adminOnly ? [] : [employeeId]
    )
  ).rows;
}


// =========================
// AUTH
// =========================

function sessionUser(req) {
  return req.session.user;
}


const auth = (req, res, next) => {

  if (!sessionUser(req)) {
    return res.status(401).json({
      error: 'غير مسجل الدخول'
    });
  }

  next();
};


const admin = (req, res, next) => {

  if (sessionUser(req)?.role !== 'admin') {
    return res.status(403).json({
      error: 'صلاحية المشرف فقط'
    });
  }

  next();
};


const canAccess = (req, id) =>
  req.session.user.role === 'admin' ||
  Number(req.session.user.employee_id) === Number(id);


function monthValue(value) {
  return /^\d{4}-\d{2}$/.test(
    String(value || '')
  )
    ? String(value)
    : today().slice(0, 7);
}


// =========================
// LOGIN
// =========================

app.post('/api/login', async (req, res) => {

  try {

    const {
      username,
      password
    } = req.body || {};

    let user;

    if (pool) {
      user = await dbUser(username);
    } else {
      user = readLocal()
        .users
        .find(x => x.username === username);
    }


    if (
      !user ||
      !verifyPassword(password, user.password)
    ) {

      return res.status(401).json({
        error:
          'اسم المستخدم أو كلمة المرور غير صحيحة'
      });
    }


    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      employee_id: user.employee_id || null
    };


    res.json({
      user: req.session.user
    });

  } catch (error) {

    console.error('Login error:', error);

    res.status(500).json({
      error: 'خطأ في تسجيل الدخول'
    });
  }
});


// =========================
// LOGOUT
// =========================

app.post(
  '/api/logout',
  (req, res) => {

    req.session.destroy(
      () => res.json({ ok: true })
    );
  }
);


// =========================
// CURRENT USER
// =========================

app.get(
  '/api/me',
  auth,
  (req, res) => {

    res.json({
      user: req.session.user
    });
  }
);


// =========================
// CHANGE OWN PASSWORD
// =========================

app.post(
  '/api/password/change',
  auth,
  async (req, res) => {

    try {

      const {
        currentPassword,
        newPassword
      } = req.body || {};


      if (
        !newPassword ||
        String(newPassword).length < 6
      ) {

        return res.status(400).json({
          error:
            'كلمة السر الجديدة يجب أن تكون 6 أحرف أو أرقام على الأقل'
        });
      }


      if (pool) {

        const user = (
          await pool.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            `,
            [req.session.user.id]
          )
        ).rows[0];


        if (
          !user ||
          !verifyPassword(
            currentPassword,
            user.password
          )
        ) {

          return res.status(400).json({
            error:
              'كلمة السر الحالية غير صحيحة'
          });
        }


        await pool.query(
          `
          UPDATE users
          SET password = $1
          WHERE id = $2
          `,
          [
            hashPassword(newPassword),
            user.id
          ]
        );

      } else {

        const data = readLocal();

        const user = data.users.find(
          x => x.id === req.session.user.id
        );


        if (
          !user ||
          !verifyPassword(
            currentPassword,
            user.password
          )
        ) {

          return res.status(400).json({
            error:
              'كلمة السر الحالية غير صحيحة'
          });
        }


        user.password =
          hashPassword(newPassword);

        writeLocal(data);
      }


      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: 'تعذر تغيير كلمة السر'
      });
    }
  }
);


// =========================
// ADMIN CHANGE PASSWORD
// =========================

app.post(
  '/api/admin/password/:userId',
  auth,
  admin,
  async (req, res) => {

    try {

      const {
        newPassword
      } = req.body || {};


      if (
        !newPassword ||
        String(newPassword).length < 6
      ) {

        return res.status(400).json({
          error:
            'كلمة السر يجب أن تكون 6 أحرف أو أرقام على الأقل'
        });
      }


      if (pool) {

        const result = await pool.query(
          `
          UPDATE users

          SET password = $1

          WHERE id = $2

          RETURNING id
          `,
          [
            hashPassword(newPassword),
            Number(req.params.userId)
          ]
        );


        if (!result.rowCount) {

          return res.status(404).json({
            error: 'المستخدم غير موجود'
          });
        }

      } else {

        const data = readLocal();

        const user = data.users.find(
          x => x.id === Number(req.params.userId)
        );


        if (!user) {

          return res.status(404).json({
            error: 'المستخدم غير موجود'
          });
        }


        user.password =
          hashPassword(newPassword);

        writeLocal(data);
      }


      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: 'تعذر تغيير كلمة السر'
      });
    }
  }
);


// =========================
// ADMIN USERS
// =========================

app.get(
  '/api/admin/users',
  auth,
  admin,
  async (req, res) => {

    if (pool) {

      return res.json(
        (
          await pool.query(
            `
            SELECT
              id,
              username,
              role,
              employee_id

            FROM users

            ORDER BY id
            `
          )
        ).rows
      );
    }


    res.json(
      readLocal()
        .users
        .map(user => ({
          id: user.id,
          username: user.username,
          role: user.role,
          employee_id:
            user.employee_id || null
        }))
    );
  }
);


// =========================
// EMPLOYEES
// =========================

app.get(
  '/api/employees',
  auth,
  async (req, res) => {

    if (pool) {

      return res.json(
        await dbEmployees(
          req.session.user.role === 'admin',
          req.session.user.employee_id
        )
      );
    }


    const data = readLocal();

    res.json(
      req.session.user.role === 'admin'
        ? data.employees
        : data.employees.filter(
            e =>
              e.id ===
              req.session.user.employee_id
          )
    );
  }
);


// =========================
// EDIT EMPLOYEE
// =========================

app.put(
  '/api/employees/:id',
  auth,
  admin,
  async (req, res) => {

    const id = Number(req.params.id);

    if (pool) {

      const result = await pool.query(
        `
        UPDATE employees

        SET
          name = COALESCE($1, name),
          employee_group =
            COALESCE($2, employee_group),
          salary =
            COALESCE($3, salary)

        WHERE id = $4

        RETURNING
          id,
          name,
          username,
          employee_group AS "group",
          salary::float AS salary
        `,
        [
          req.body.name ?? null,
          req.body.group ?? null,
          req.body.salary === undefined
            ? null
            : Number(req.body.salary) || 0,
          id
        ]
      );


      if (!result.rowCount) {

        return res.status(404).json({
          error: 'الموظف غير موجود'
        });
      }


      return res.json(
        result.rows[0]
      );
    }


    const data = readLocal();

    const employee =
      data.employees.find(
        x => x.id === id
      );


    if (!employee) {

      return res.status(404).json({
        error: 'الموظف غير موجود'
      });
    }


    for (
      const key of [
        'name',
        'group',
        'salary'
      ]
    ) {

      if (
        req.body[key] !== undefined
      ) {

        employee[key] =
          key === 'salary'
            ? Number(req.body[key]) || 0
            : req.body[key];
      }
    }


    writeLocal(data);

    res.json(employee);
  }
);


// =========================
// PAYMENTS
// =========================

app.get(
  '/api/payments',
  auth,
  async (req, res) => {

    const month = req.query.month;

    let employeeId =
      req.query.employee_id
        ? Number(req.query.employee_id)
        : null;


    if (
      employeeId &&
      !canAccess(req, employeeId)
    ) {

      return res.status(403).json({
        error: 'ممنوع'
      });
    }


    if (
      !employeeId &&
      req.session.user.role !== 'admin'
    ) {

      employeeId =
        req.session.user.employee_id;
    }


    if (pool) {

      let query = `
        SELECT
          id,
          employee_id,
          amount::float AS amount,
          date::text,
          type,
          note,
          added_by,
          created_at,
          edited_by,
          edited_at

        FROM payments

        WHERE 1=1
      `;

      const params = [];


      if (employeeId) {

        params.push(employeeId);

        query +=
          ` AND employee_id=$${params.length}`;
      }


      if (month) {

        params.push(month);

        query += `
          AND date >= $${params.length}::date
          AND date <
            ($${params.length}::date +
             INTERVAL '1 month')
        `;
      }


      query +=
        ' ORDER BY date DESC, id DESC';


      return res.json(
        (
          await pool.query(
            query,
            params
          )
        ).rows
      );
    }


    let rows =
      readLocal().payments;


    if (employeeId) {

      rows =
        rows.filter(
          x => x.employee_id === employeeId
        );
    }


    if (month) {

      rows =
        rows.filter(
          x => x.date?.startsWith(month)
        );
    }


    res.json(
      rows.sort(
        (a, b) =>
          String(b.date)
            .localeCompare(
              String(a.date)
            )
      )
    );
  }
);


// =========================
// ADD PAYMENT
// =========================

app.post(
  '/api/payments',
  auth,
  async (req, res) => {

    const employee_id =
      req.session.user.role === 'admin'
        ? Number(req.body.employee_id)
        : Number(
            req.session.user.employee_id
          );

    const amount =
      Number(req.body.amount);

    const date =
      req.body.date || today();

    const type =
      req.body.type || 'دفعة';

    const note =
      req.body.note || '';


    if (!(amount > 0)) {

      return res.status(400).json({
        error: 'أدخل مبلغاً صحيحاً'
      });
    }


    if (pool) {

      const result =
        await pool.query(
          `
          INSERT INTO payments
            (
              employee_id,
              amount,
              date,
              type,
              note,
              added_by
            )

          VALUES
            ($1,$2,$3,$4,$5,$6)

          RETURNING
            id,
            employee_id,
            amount::float AS amount,
            date::text,
            type,
            note,
            added_by,
            created_at
          `,
          [
            employee_id,
            amount,
            date,
            type,
            note,
            req.session.user.username
          ]
        );


      return res.json(
        result.rows[0]
      );
    }


    const data = readLocal();

    const row = {
      id: Date.now(),
      employee_id,
      amount,
      date,
      type,
      note,
      added_by:
        req.session.user.username,
      created_at: now()
    };


    data.payments.push(row);

    writeLocal(data);

    res.json(row);
  }
);


// =========================
// EDIT PAYMENT
// =========================

app.put(
  '/api/payments/:id',
  auth,
  async (req, res) => {

    const id =
      Number(req.params.id);


    if (pool) {

      const payment =
        (
          await pool.query(
            `
            SELECT *
            FROM payments
            WHERE id=$1
            `,
            [id]
          )
        ).rows[0];


      if (!payment) {

        return res.status(404).json({
          error: 'الدفعة غير موجودة'
        });
      }


      if (
        !canAccess(
          req,
          payment.employee_id
        )
      ) {

        return res.status(403).json({
          error: 'ممنوع'
        });
      }


      if (
        req.session.user.role !== 'admin' &&
        req.body.amount !== undefined
      ) {

        return res.status(403).json({
          error:
            'تعديل المبلغ من صلاحية المشرف فقط'
        });
      }


      const result =
        await pool.query(
          `
          UPDATE payments

          SET
            amount =
              COALESCE($1, amount),
            date =
              COALESCE($2, date),
            type =
              COALESCE($3, type),
            note =
              COALESCE($4, note),
            edited_by = $5,
            edited_at = NOW()

          WHERE id = $6

          RETURNING
            id,
            employee_id,
            amount::float AS amount,
            date::text,
            type,
            note,
            added_by,
            created_at,
            edited_by,
            edited_at
          `,
          [
            req.body.amount === undefined
              ? null
              : Number(req.body.amount),

            req.body.date || null,

            req.body.type || null,

            req.body.note === undefined
              ? null
              : req.body.note,

            req.session.user.username,

            id
          ]
        );


      return res.json(
        result.rows[0]
      );
    }


    const data = readLocal();

    const payment =
      data.payments.find(
        x => x.id === id
      );


    if (!payment) {

      return res.status(404).json({
        error: 'الدفعة غير موجودة'
      });
    }


    if (
      !canAccess(
        req,
        payment.employee_id
      )
    ) {

      return res.status(403).json({
        error: 'ممنوع'
      });
    }


    if (
      req.session.user.role !== 'admin' &&
      req.body.amount !== undefined
    ) {

      return res.status(403).json({
        error:
          'تعديل المبلغ من صلاحية المشرف فقط'
      });
    }


    Object.assign(
      payment,
      {
        amount:
          req.body.amount === undefined
            ? payment.amount
            : Number(req.body.amount),

        date:
          req.body.date ?? payment.date,

        type:
          req.body.type ?? payment.type,

        note:
          req.body.note ?? payment.note,

        edited_by:
          req.session.user.username,

        edited_at: now()
      }
    );


    writeLocal(data);

    res.json(payment);
  }
);


// =========================
// DELETE PAYMENT
// =========================

app.delete(
  '/api/payments/:id',
  auth,
  admin,
  async (req, res) => {

    if (pool) {

      await pool.query(
        'DELETE FROM payments WHERE id=$1',
        [Number(req.params.id)]
      );

      return res.json({
        ok: true
      });
    }


    const data = readLocal();

    data.payments =
      data.payments.filter(
        x =>
          x.id !==
          Number(req.params.id)
      );

    writeLocal(data);

    res.json({
      ok: true
    });
  }
);


// =========================
// ATTENDANCE
// =========================

app.get(
  '/api/attendance',
  auth,
  async (req, res) => {

    let employeeId =
      req.query.employee_id
        ? Number(req.query.employee_id)
        : null;


    if (
      employeeId &&
      !canAccess(req, employeeId)
    ) {

      return res.status(403).json({
        error: 'ممنوع'
      });
    }


    if (
      !employeeId &&
      req.session.user.role !== 'admin'
    ) {

      employeeId =
        req.session.user.employee_id;
    }


    const month =
      req.query.month;


    if (pool) {

      let query = `
        SELECT
          id,
          employee_id,
          date::text,
          status,
          hours::float AS hours,
          note,
          added_by,
          created_at

        FROM attendance

        WHERE 1=1
      `;

      const params = [];


      if (employeeId) {

        params.push(employeeId);

        query +=
          ` AND employee_id=$${params.length}`;
      }


      if (month) {

        params.push(month);

        query += `
          AND date >= $${params.length}::date
          AND date <
            ($${params.length}::date +
             INTERVAL '1 month')
        `;
      }


      query +=
        ' ORDER BY date DESC, id DESC';


      return res.json(
        (
          await pool.query(
            query,
            params
          )
        ).rows
      );
    }


    let rows =
      readLocal().attendance;


    if (employeeId) {

      rows =
        rows.filter(
          x =>
            x.employee_id === employeeId
        );
    }


    if (month) {

      rows =
        rows.filter(
          x =>
            x.date.startsWith(month)
        );
    }


    res.json(rows);
  }
);


// =========================
// ADD ATTENDANCE
// =========================

app.post(
  '/api/attendance',
  auth,
  async (req, res) => {

    const employee_id =
      req.session.user.role === 'admin'
        ? Number(req.body.employee_id)
        : Number(
            req.session.user.employee_id
          );

    const date =
      req.body.date || today();

    const status =
      req.body.status || 'حضور';

    const hours =
      Number(req.body.hours) || 0;

    const note =
      req.body.note || '';


    if (pool) {

      const result =
        await pool.query(
          `
          INSERT INTO attendance
            (
              employee_id,
              date,
              status,
              hours,
              note,
              added_by
            )

          VALUES
            ($1,$2,$3,$4,$5,$6)

          RETURNING
            id,
            employee_id,
            date::text,
            status,
            hours::float AS hours,
            note,
            added_by,
            created_at
          `,
          [
            employee_id,
            date,
            status,
            hours,
            note,
            req.session.user.username
          ]
        );


      return res.json(
        result.rows[0]
      );
    }


    const data = readLocal();

    const row = {
      id: Date.now(),
      employee_id,
      date,
      status,
      hours,
      note,
      added_by:
        req.session.user.username
    };


    data.attendance.push(row);

    writeLocal(data);

    res.json(row);
  }
);


// =========================
// DELETE ATTENDANCE
// =========================

app.delete(
  '/api/attendance/:id',
  auth,
  admin,
  async (req, res) => {

    if (pool) {

      await pool.query(
        'DELETE FROM attendance WHERE id=$1',
        [Number(req.params.id)]
      );

    } else {

      const data = readLocal();

      data.attendance =
        data.attendance.filter(
          x =>
            x.id !==
            Number(req.params.id)
        );

      writeLocal(data);
    }


    res.json({
      ok: true
    });
  }
);


// =========================
// EXPENSES
// =========================

app.get(
  '/api/expenses',
  auth,
  async (req, res) => {

    let employeeId =
      req.query.employee_id
        ? Number(req.query.employee_id)
        : null;


    if (
      employeeId &&
      !canAccess(req, employeeId)
    ) {

      return res.status(403).json({
        error: 'ممنوع'
      });
    }


    if (
      !employeeId &&
      req.session.user.role !== 'admin'
    ) {

      employeeId =
        req.session.user.employee_id;
    }


    const month =
      req.query.month;


    if (pool) {

      let query = `
        SELECT
          id,
          employee_id,
          amount::float AS amount,
          date::text,
          category,
          note,
          added_by,
          created_at,
          edited_by,
          edited_at

        FROM expenses

        WHERE 1=1
      `;

      const params = [];


      if (employeeId) {

        params.push(employeeId);

        query +=
          ` AND employee_id=$${params.length}`;
      }


      if (month) {

        params.push(month);

        query += `
          AND date >= $${params.length}::date
          AND date <
            ($${params.length}::date +
             INTERVAL '1 month')
        `;
      }


      query +=
        ' ORDER BY date DESC, id DESC';


      return res.json(
        (
          await pool.query(
            query,
            params
          )
        ).rows
      );
    }


    let rows =
      readLocal().expenses || [];


    if (employeeId) {

      rows =
        rows.filter(
          x =>
            x.employee_id === employeeId
        );
    }


    if (month) {

      rows =
        rows.filter(
          x =>
            String(x.date)
              .startsWith(month)
        );
    }


    res.json(
      rows.sort(
        (a, b) =>
          String(b.date)
            .localeCompare(
              String(a.date)
            )
      )
    );
  }
);


// =========================
// ADD EXPENSE
// =========================

app.post(
  '/api/expenses',
  auth,
  async (req, res) => {

    const employee_id =
      req.session.user.role === 'admin'
        ? Number(req.body.employee_id)
        : Number(
            req.session.user.employee_id
          );

    const amount =
      Number(req.body.amount);

    const date =
      req.body.date || today();

    const category =
      req.body.category || 'عام';

    const note =
      req.body.note || '';


    if (!(amount > 0)) {

      return res.status(400).json({
        error: 'أدخل مبلغاً صحيحاً'
      });
    }


    if (pool) {

      const result =
        await pool.query(
          `
          INSERT INTO expenses
            (
              employee_id,
              amount,
              date,
              category,
              note,
              added_by
            )

          VALUES
            ($1,$2,$3,$4,$5,$6)

          RETURNING
            id,
            employee_id,
            amount::float AS amount,
            date::text,
            category,
            note,
            added_by,
            created_at
          `,
          [
            employee_id,
            amount,
            date,
            category,
            note,
            req.session.user.username
          ]
        );


      return res.json(
        result.rows[0]
      );
    }


    const data = readLocal();

    const row = {
      id: Date.now(),
      employee_id,
      amount,
      date,
      category,
      note,
      added_by:
        req.session.user.username,
      created_at: now()
    };


    data.expenses.push(row);

    writeLocal(data);

    res.json(row);
  }
);


// =========================
// EDIT EXPENSE
// =========================

app.put(
  '/api/expenses/:id',
  auth,
  admin,
  async (req, res) => {

    const id =
      Number(req.params.id);


    if (pool) {

      const result =
        await pool.query(
          `
          UPDATE expenses

          SET
            employee_id =
              COALESCE($1, employee_id),

            amount =
              COALESCE($2, amount),

            date =
              COALESCE($3, date),

            category =
              COALESCE($4, category),

            note =
              COALESCE($5, note),

            edited_by = $6,
            edited_at = NOW()

          WHERE id = $7

          RETURNING
            id,
            employee_id,
            amount::float AS amount,
            date::text,
            category,
            note,
            added_by,
            created_at,
            edited_by,
            edited_at
          `,
          [
            req.body.employee_id === undefined
              ? null
              : Number(req.body.employee_id),

            req.body.amount === undefined
              ? null
              : Number(req.body.amount),

            req.body.date || null,

            req.body.category || null,

            req.body.note === undefined
              ? null
              : req.body.note,

            req.session.user.username,

            id
          ]
        );


      if (!result.rowCount) {

        return res.status(404).json({
          error: 'المصروف غير موجود'
        });
      }


      return res.json(
        result.rows[0]
      );
    }


    const data = readLocal();

    const expense =
      data.expenses.find(
        x => x.id === id
      );


    if (!expense) {

      return res.status(404).json({
        error: 'المصروف غير موجود'
      });
    }


    if (
      req.body.employee_id !== undefined
    ) {

      expense.employee_id =
        Number(req.body.employee_id);
    }


    if (
      req.body.amount !== undefined
    ) {

      expense.amount =
        Number(req.body.amount);
    }


    if (
      req.body.date !== undefined
    ) {

      expense.date =
        req.body.date;
    }


    if (
      req.body.category !== undefined
    ) {

      expense.category =
        req.body.category;
    }


    if (
      req.body.note !== undefined
    ) {

      expense.note =
        req.body.note;
    }


    expense.edited_by =
      req.session.user.username;

    expense.edited_at =
      now();


    writeLocal(data);

    res.json(expense);
  }
);


// =========================
// DELETE EXPENSE
// =========================

app.delete(
  '/api/expenses/:id',
  auth,
  admin,
  async (req, res) => {

    if (pool) {

      await pool.query(
        'DELETE FROM expenses WHERE id=$1',
        [Number(req.params.id)]
      );

    } else {

      const data = readLocal();

      data.expenses =
        data.expenses.filter(
          x =>
            x.id !==
            Number(req.params.id)
        );

      writeLocal(data);
    }


    res.json({
      ok: true
    });
  }
);


// =========================
// MONTHLY REPORT
// =========================

app.get(
  '/api/report',
  auth,
  async (req, res) => {

    const month =
      monthValue(req.query.month);


    if (pool) {

      const employees =
        await dbEmployees(
          req.session.user.role === 'admin',
          req.session.user.employee_id
        );


      const result = [];


      for (const employee of employees) {

        const payments =
          (
            await pool.query(
              `
              SELECT
                id,
                employee_id,
                amount::float AS amount,
                date::text,
                type,
                note,
                added_by

              FROM payments

              WHERE employee_id = $1

              AND date >= $2::date

              AND date <
                ($2::date +
                 INTERVAL '1 month')

              ORDER BY date
              `,
              [
                employee.id,
                month
              ]
            )
          ).rows;


        const expenses =
          (
            await pool.query(
              `
              SELECT
                id,
                employee_id,
                amount::float AS amount,
                date::text,
                category,
                note,
                added_by

              FROM expenses

              WHERE employee_id = $1

              AND date >= $2::date

              AND date <
                ($2::date +
                 INTERVAL '1 month')

              ORDER BY date
              `,
              [
                employee.id,
                month
              ]
            )
          ).rows;


        const attendance =
          (
            await pool.query(
              `
              SELECT
                id,
                employee_id,
                date::text,
                status,
                hours::float AS hours,
                note

              FROM attendance

              WHERE employee_id = $1

              AND date >= $2::date

              AND date <
                ($2::date +
                 INTERVAL '1 month')

              ORDER BY date
              `,
              [
                employee.id,
                month
              ]
            )
          ).rows;


        const received =
          payments.reduce(
            (sum, item) =>
              sum + item.amount,
            0
          );


        const expense_total =
          expenses.reduce(
            (sum, item) =>
              sum + item.amount,
            0
          );


        result.push({
          ...employee,

          received,

          balance:
            Number(employee.salary) -
            received,

          payments,

          expenses,

          expense_total,

          attendance,

          days:
            attendance.filter(
              a =>
                a.status === 'حضور'
            ).length,

          absences:
            attendance.filter(
              a =>
                a.status === 'غياب'
            ).length,

          hours:
            attendance.reduce(
              (sum, item) =>
                sum +
                Number(item.hours || 0),
              0
            )
        });
      }


      const allExpenses =
        result.flatMap(
          employee =>
            employee.expenses
        );


      return res.json({
        month,
        employees: result,
        expenses: allExpenses
      });
    }


    const data = readLocal();


    const employees =
      req.session.user.role === 'admin'
        ? data.employees
        : data.employees.filter(
            employee =>
              employee.id ===
              req.session.user.employee_id
          );


    const result =
      employees.map(employee => {

        const payments =
          data.payments.filter(
            payment =>
              payment.employee_id ===
                employee.id &&
              payment.date.startsWith(
                month
              )
          );


        const expenses =
          (data.expenses || []).filter(
            expense =>
              expense.employee_id ===
                employee.id &&
              expense.date.startsWith(
                month
              )
          );


        const attendance =
          data.attendance.filter(
            item =>
              item.employee_id ===
                employee.id &&
              item.date.startsWith(
                month
              )
          );


        const received =
          payments.reduce(
            (sum, item) =>
              sum + item.amount,
            0
          );


        const expense_total =
          expenses.reduce(
            (sum, item) =>
              sum + item.amount,
            0
          );


        return {
          ...employee,

          received,

          balance:
            employee.salary -
            received,

          payments,

          expenses,

          expense_total,

          attendance,

          days:
            attendance.filter(
              a =>
                a.status === 'حضور'
            ).length,

          absences:
            attendance.filter(
              a =>
                a.status === 'غياب'
            ).length,

          hours:
            attendance.reduce(
              (sum, item) =>
                sum +
                (item.hours || 0),
              0
            )
        };
      });


    res.json({
      month,
      employees: result,
      expenses:
        result.flatMap(
          employee =>
            employee.expenses
        )
    });
  }
);


// =========================
// BACKUP
// =========================

app.get(
  '/api/backup',
  auth,
  admin,
  async (req, res) => {

    if (pool) {

      const [
        users,
        employees,
        attendance,
        payments,
        expenses
      ] = await Promise.all([

        pool.query(
          `
          SELECT
            id,
            username,
            password,
            role,
            employee_id

          FROM users

          ORDER BY id
          `
        ),

        pool.query(
          `
          SELECT
            id,
            name,
            username,
            employee_group AS "group",
            salary::float AS salary

          FROM employees

          ORDER BY id
          `
        ),

        pool.query(
          `
          SELECT
            id,
            employee_id,
            date::text,
            status,
            hours::float AS hours,
            note,
            added_by,
            created_at

          FROM attendance

          ORDER BY id
          `
        ),

        pool.query(
          `
          SELECT
            id,
            employee_id,
            amount::float AS amount,
            date::text,
            type,
            note,
            added_by,
            created_at,
            edited_by,
            edited_at

          FROM payments

          ORDER BY id
          `
        ),

        pool.query(
          `
          SELECT
            id,
            employee_id,
            amount::float AS amount,
            date::text,
            category,
            note,
            added_by,
            created_at,
            edited_by,
            edited_at

          FROM expenses

          ORDER BY id
          `
        )
      ]);


      res.setHeader(
        'Content-Type',
        'application/json; charset=utf-8'
      );


      res.setHeader(
        'Content-Disposition',
        'attachment; filename="employee-dashboard-backup.json"'
      );


      return res.send(
        JSON.stringify(
          {
            users: users.rows,
            employees: employees.rows,
            attendance: attendance.rows,
            payments: payments.rows,
            expenses: expenses.rows,
            exportedAt: now()
          },
          null,
          2
        )
      );
    }


    res.download(
      localFile,
      'employee-dashboard-backup.json'
    );
  }
);


// =========================
// HEALTH CHECK
// =========================

app.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,
      database:
        hasDatabase
          ? 'postgres'
          : 'local-file'
    });
  }
);


// =========================
// STATIC WEBSITE
// =========================

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


app.get(
  '*',
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    )
);


// =========================
// START SERVER
// =========================

initDb()
  .then(() => {

    app.listen(
      PORT,
      '0.0.0.0',
      () => {

        console.log(
          `Employee dashboard V5 running on port ${PORT} using ${
            hasDatabase
              ? 'PostgreSQL'
              : 'local file'
          }`
        );
      }
    );

  })
  .catch(error => {

    console.error(
      'Database initialization failed:',
      error
    );

    process.exit(1);
  });
