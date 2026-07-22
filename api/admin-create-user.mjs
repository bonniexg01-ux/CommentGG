// api/admin-create-user.mjs
// เครื่องมือสำหรับ "แอดมินสร้างบัญชีให้ทีม" (ตามที่เลือกไว้ตอนเพิ่มระบบ login — ไม่มีปุ่มสมัคร
// เองในหน้าเว็บ) เรียก Supabase Auth Admin API (POST /auth/v1/admin/users) ด้วย service role key
// ฝั่งเซิร์ฟเวอร์เท่านั้น เพื่อสร้างผู้ใช้ใหม่พร้อมยืนยันอีเมลให้เลย (ไม่ต้องกดยืนยันอีเมลเอง)
//
// ป้องกันด้วย SETUP_SECRET (ค่าสุ่ม ไม่ใช่ความลับระดับเดียวกับ service key แต่กันไม่ให้ใครก็ตาม
// ที่เจอ URL นี้มาสร้างบัญชีมั่วๆ ได้) — ไม่ใช่ endpoint ที่เปิดให้ frontend เรียกใช้ตามปกติ
// เรียกเองผ่านเครื่องมือฝั่งแอดมินเท่านั้นตอนจะเพิ่ม/ลบสมาชิกทีม

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SETUP_SECRET = 'JKOu3kzH4bhgXRDNvKugFxToeDOFhXab';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    if (!SERVICE_KEY) return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
    }
    const { secret, email, password } = body || {};
    if (secret !== SETUP_SECRET) return json({ error: 'unauthorized' }, 403);
    if (!email || !password) return json({ error: 'email และ password จำเป็นต้องมี' }, 400);

    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('admin-create-user error:', data);
      return json({ error: data.msg || data.error_description || data.message || 'สร้างบัญชีไม่สำเร็จ' }, 502);
    }

    return json({ ok: true, userId: data.id, email: data.email });
  } catch (err) {
    console.error('admin-create-user error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}
