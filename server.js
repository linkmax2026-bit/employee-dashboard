# إضافة الإيرادات الشهرية إلى server.js

## 1) داخل localSeed()
ابحث عن:
    expenses: [],
    payments: [],
    createdAt: now()

واستبدلها بـ:
    expenses: [],
    payments: [],
    incomes: [],
    createdAt: now()

## 2) داخل initDb() بعد CREATE TABLE expenses
أضف هذا الجدول قبل إغلاق await pool.query(`...`):

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

هذا آمن ولن يحذف أي بيانات موجودة.

## 3) أضف API الإيرادات قبل قسم REPORT مباشرة
أي قبل السطر:
   /* =========================
      REPORT
   ========================= */

الصق الكود التالي:

/* =========================
   INCOMES / REVENUES
========================= */

app.get(
  '/api/incomes',
  auth,
  admin,
  async (req, res) => {
    const month = req.query.month;

    if (pool) {
      let q = `
        SELECT
          id,
          amount::float AS amount,
          date::text,
          category,
          note,
          added_by,
          created_at,
          edited_by,
          edited_at
        FROM incomes
        WHERE 1=1
      `;

      const a = [];

      if (month) {
        a.push(month);

        q += `
          AND date >= ($${a.length} || '-01')::date
          AND date < (
            ($${a.length} || '-01')::date
            + INTERVAL '1 month'
          )
        `;
      }

      q += `
        ORDER BY date DESC, id DESC
      `;

      return res.json(
        (await pool.query(q, a)).rows
      );
    }

    const d = readLocal();

    let rows = d.incomes || [];

    if (month) {
      rows = rows.filter((x) =>
        String(x.date).startsWith(month)
      );
    }

    rows.sort((a, b) =>
      String(b.date).localeCompare(
        String(a.date)
      )
    );

    res.json(rows);
  }
);

app.post(
  '/api/incomes',
  auth,
  admin,
  async (req, res) => {
    const amount = Number(req.body.amount);
    const date = req.body.date || today();
    const category = req.body.category || 'عام';
    const note = req.body.note || '';

    if (!(amount > 0)) {
      return res.status(400).json({
        error: 'أدخل مبلغاً صحيحاً'
      });
    }

    if (pool) {
      const r = await pool.query(
        `
        INSERT INTO incomes
          (amount,date,category,note,added_by)
        VALUES
          ($1,$2,$3,$4,$5)
        RETURNING
          id,
          amount::float AS amount,
          date::text,
          category,
          note,
          added_by,
          created_at
        `,
        [
          amount,
          date,
          category,
          note,
          req.session.user.username
        ]
      );

      return res.json(r.rows[0]);
    }

    const d = readLocal();

    if (!Array.isArray(d.incomes)) {
      d.incomes = [];
    }

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

    res.json(row);
  }
);

app.put(
  '/api/incomes/:id',
  auth,
  admin,
  async (req, res) => {
    const id = Number(req.params.id);

    if (pool) {
      const r = await pool.query(
        `
        UPDATE incomes
        SET
          amount=COALESCE($1,amount),
          date=COALESCE($2,date),
          category=COALESCE($3,category),
          note=COALESCE($4,note),
          edited_by=$5,
          edited_at=NOW()
        WHERE id=$6
        RETURNING
          id,
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

      if (!r.rowCount) {
        return res.status(404).json({
          error: 'الإيراد غير موجود'
        });
      }

      return res.json(r.rows[0]);
    }

    const d = readLocal();

    const x = (d.incomes || []).find(
      (x) => x.id === id
    );

    if (!x) {
      return res.status(404).json({
        error: 'الإيراد غير موجود'
      });
    }

    if (req.body.amount !== undefined) {
      x.amount = Number(req.body.amount);
    }

    if (req.body.date !== undefined) {
      x.date = req.body.date;
    }

    if (req.body.category !== undefined) {
      x.category = req.body.category;
    }

    if (req.body.note !== undefined) {
      x.note = req.body.note;
    }

    x.edited_by = req.session.user.username;
    x.edited_at = now();

    writeLocal(d);

    res.json(x);
  }
);

app.delete(
  '/api/incomes/:id',
  auth,
  admin,
  async (req, res) => {
    const id = Number(req.params.id);

    if (pool) {
      await pool.query(
        'DELETE FROM incomes WHERE id=$1',
        [id]
      );

      return res.json({ ok: true });
    }

    const d = readLocal();

    d.incomes =
      (d.incomes || []).filter(
        (x) => x.id !== id
      );

    writeLocal(d);

    res.json({ ok: true });
  }
);

## 4) تعديل /api/report

داخل جزء PostgreSQL في report، بعد:
      const result = [];

أضف:

      const incomes = (
        await pool.query(
          `
          SELECT
            id,
            amount::float AS amount,
            date::text,
            category,
            note,
            added_by
          FROM incomes
          WHERE
            date >= ($1 || '-01')::date
            AND date < (
              ($1 || '-01')::date
              + INTERVAL '1 month'
            )
          ORDER BY date, id
          `,
          [month]
        )
      ).rows;

وبعد حساب allExp:
      const allExp =
        result.flatMap(
          (x) => x.expenses
        );

أضف:

      const income_total =
        incomes.reduce(
          (s, x) => s + Number(x.amount || 0),
          0
        );

ثم غيّر return النهائي في PostgreSQL من:

      return res.json({
        month,
        employees: result,
        expenses: allExp
      });

إلى:

      return res.json({
        month,
        employees: result,
        expenses: allExp,
        incomes,
        income_total
      });

## 5) تعديل الجزء المحلي Local داخل report

بعد:
    const d = readLocal();

أضف:

    const incomes =
      (d.incomes || []).filter(
        (x) =>
          String(x.date).startsWith(month)
      );

    const income_total =
      incomes.reduce(
        (s, x) => s + Number(x.amount || 0),
        0
      );

ثم غيّر return النهائي في Local من:

    res.json({
      month,
      employees: result,
      expenses:
        result.flatMap(
          (x) => x.expenses
        )
    });

إلى:

    res.json({
      month,
      employees: result,
      expenses:
        result.flatMap(
          (x) => x.expenses
        ),
      incomes,
      income_total
    });

## 6) تعديل النسخة الاحتياطية /api/backup

في Promise.all أضف استعلام incomes بعد expenses:

        pool.query(
          `
          SELECT
            id,
            amount::float AS amount,
            date::text,
            category,
            note,
            added_by,
            created_at,
            edited_by,
            edited_at
          FROM incomes
          ORDER BY id
          `
        )

وبما أن destructuring الحالي هو:
      const [
        users,
        employees,
        attendance,
        payments,
        expenses
      ] = await Promise.all([

اجعله:

      const [
        users,
        employees,
        attendance,
        payments,
        expenses,
        incomes
      ] = await Promise.all([

وفي JSON الاحتياطي، بعد:
            expenses:
              expenses.rows,

أضف:

            incomes:
              incomes.rows,

مهم:
- لا تحذف جدولاً.
- لا تعمل DROP DATABASE.
- لا تغيّر DATABASE_URL.
- جدول incomes سينشأ تلقائياً عند تشغيل السيرفر.
- الإيراد عام للمؤسسة وليس مربوطاً بموظف.
- الحذف من الإيرادات يحذف السجل من التقرير الشهري أيضاً.
