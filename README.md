# Employee Dashboard Online V5

نسخة جاهزة للاستضافة الأونلاين مع PostgreSQL.

## أهم تغيير
إذا كان `DATABASE_URL` موجودًا، كل البيانات تحفظ في PostgreSQL وليس في `data.json`. هذا مناسب للاستضافة لأن ملفات الاستضافة المجانية مؤقتة.

إذا لم تضع `DATABASE_URL` محليًا، يعمل المشروع بوضع محلي باستخدام `data.json` حتى تستطيع تجربته على الكمبيوتر.

## تشغيل محلي
```bash
npm install
npm start
```
ثم افتح `http://localhost:3000`.

## حسابات البداية
- admin / admin123
- sally / 123456
- hadi / 123456
- badr / 123456
- raghad / 123456

غيّر كلمات السر بعد أول دخول.

## الاستضافة
1. أنشئ PostgreSQL مجانيًا على مزود يدعم PostgreSQL مثل Neon.
2. انسخ `DATABASE_URL` وضعه في Environment Variables في الاستضافة.
3. ضع `SESSION_SECRET` قويًا وعشوائيًا.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. لا ترفع أي ملف `.env` حقيقي إلى GitHub.

عند أول تشغيل مع PostgreSQL، يتم إنشاء الجداول والحسابات الأربعة وحساب Admin تلقائيًا.
