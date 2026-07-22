// api/update-page.mjs
// รับคำขอจาก Account settings modal ตอนแอดมินกด "Save" แล้วอัปเดตแฮชแท็กประจำเพจจริงใน Supabase
// ใช้ SUPABASE_SERVICE_ROLE_KEY ฝั่งเซิร์ฟเวอร์เท่านั้น เพราะตาราง pages ไม่เปิดให้เขียนผ่าน
// anon/publishable key ตรงๆ (view pages_public ที่ frontend ใช้อ่านเป็น read-only โดยตั้งใจ
// เพื่อกันไม่ให้ access_token หลุดออกไปฝั่ง client)
//
// รันบน Vercel Edge Runtime เหมือน api/reply.mjs

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function requireAuth(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const user = await requireAuth(request);
  if (!user) return json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' }, 401);

  try {
    if (!SERVICE_KEY) {
      console.error('update-page error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
    }
    const { pageId, hashtag } = body || {};
    if (!pageId) {
      return json({ error: 'pageId จำเป็นต้องมี' }, 400);
    }

    const url = `${SUPABASE_URL}/rest/v1/pages?id=eq.${encodeURIComponent(pageId)}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ hashtag: String(hashtag ?? '').trim() }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('update-page error: Supabase PATCH failed', r.status, errText);
      return json({ error: 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง' }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('update-page error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}
