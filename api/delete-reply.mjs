// api/delete-reply.mjs
// ให้แอดมินลบคำตอบที่ตอบไปแล้ว (คอมเมนต์ของแอดมินเองบน Facebook) ได้ — ลบออกจาก Facebook จริง
// แล้วดึงรายการนี้กลับไปเป็น "ต้องตอบกลับ" (pending) เหมือนไม่เคยตอบ เผื่ออยากตอบใหม่
//
// ใช้ Graph API: DELETE /{comment-id}
// ต้องมี feed_items.admin_reply_fb_id อยู่ก่อน (ดู api/edit-reply.mjs หมายเหตุเดียวกัน)

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const GRAPH_VERSION = 'v23.0';
const FB_TIMEOUT_MS = 12000;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchWithTimeout(url, options, timeoutMs = FB_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
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
      console.error('delete-reply error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
    }
    const { itemId } = body || {};
    if (!itemId) return json({ error: 'itemId จำเป็นต้องมี' }, 400);

    const item = await fetchFeedItemWithPage(itemId);
    if (!item) return json({ error: 'ไม่พบรายการนี้ในระบบ' }, 404);
    if (!item.admin_reply_fb_id) {
      return json({ error: 'คำตอบนี้ไม่มีข้อมูล comment ID (อาจตอบไปก่อนฟีเจอร์นี้มีผล) ลบผ่านระบบไม่ได้' }, 400);
    }

    const page = item.pages;
    if (!page || !page.access_token) {
      return json({ error: 'ไม่พบ access token ของเพจนี้ ตั้งค่าเพจให้ครบก่อน' }, 400);
    }

    let fbResult;
    try {
      fbResult = await deleteComment(item.admin_reply_fb_id, page.access_token);
    } catch (fbErr) {
      const isTimeout = fbErr && fbErr.name === 'AbortError';
      console.error('delete-reply error: เรียก Facebook ไม่สำเร็จ', isTimeout ? 'timeout' : fbErr);
      return json(
        { error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : 'เชื่อมต่อ Facebook ไม่สำเร็จ' },
        502
      );
    }

    if (fbResult && fbResult.error) {
      console.error('delete-reply error: Facebook ปฏิเสธการลบ', fbResult.error);
      return json({ error: `Facebook ปฏิเสธการลบ: ${fbResult.error.message || 'unknown error'}` }, 502);
    }

    // ลบจาก Facebook สำเร็จแล้ว — ดึงรายการนี้กลับไปเป็น "ต้องตอบกลับ" เหมือนไม่เคยตอบ
    await markFeedItem(itemId, { status: 'pending', admin_reply: null, admin_reply_fb_id: null });
    return json({ ok: true });
  } catch (err) {
    console.error('delete-reply error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}

async function fetchFeedItemWithPage(id) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?id=eq.${encodeURIComponent(id)}&select=id,page_id,type,admin_reply_fb_id,pages(access_token)`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function markFeedItem(id, fields) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?id=eq.${encodeURIComponent(id)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
}

async function deleteComment(commentId, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}?access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'DELETE' });
  return r.json();
}
