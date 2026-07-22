// api/moderate-comment.mjs
// ปุ่ม "ซ่อนคอมเมนต์"/"เผยแพร่คืน" เดิมแค่แก้สถานะใน Supabase ฝั่งเราเท่านั้น ไม่เคยสั่งซ่อนที่
// Facebook จริง — คอมเมนต์เลยยังโชว์อยู่บนหน้าเพจตามปกติ (บั๊กแบบเดียวกับที่เคยเจอตอนปุ่ม "ตอบ"
// ก่อนหน้านี้: dashboard ขึ้นว่าทำแล้ว แต่ไม่มีอะไรเกิดขึ้นจริงฝั่ง Facebook)
//
// ไฟล์นี้สั่งซ่อน/เลิกซ่อนคอมเมนต์บน Facebook จริงผ่าน Graph API: POST /{comment-id} พร้อม
// is_hidden=true|false แล้วค่อยอัปเดตสถานะใน Supabase ต่อเมื่อ Facebook ยืนยันสำเร็จเท่านั้น
//
// ใช้ได้เฉพาะ type: 'comment' เท่านั้น (ข้อความ Inbox ไม่มี concept การซ่อนแบบนี้บน Facebook)

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

// เดิม endpoint นี้ไม่เช็คเลยว่าใครเป็นคนเรียก -- ตรวจ token ที่แนบมากับ Authorization header
// ผ่าน Supabase Auth ก่อนเสมอ ไม่มี token ที่ใช้ได้ = ปฏิเสธ (แพทเทิร์นเดียวกับ api/reply.mjs)
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
      console.error('moderate-comment error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
    }
    const { itemId, hidden } = body || {};
    if (!itemId || typeof hidden !== 'boolean') {
      return json({ error: 'itemId และ hidden (true/false) จำเป็นต้องมี' }, 400);
    }

    const item = await fetchFeedItemWithPage(itemId);
    if (!item) return json({ error: 'ไม่พบรายการนี้ในระบบ' }, 404);

    if (item.type !== 'comment' || !item.fb_id) {
      return json({ error: 'ซ่อน/เผยแพร่คืนได้เฉพาะคอมเมนต์เท่านั้น (ไม่ใช่ข้อความ Inbox)' }, 400);
    }

    const page = item.pages;
    if (!page || !page.access_token) {
      return json({ error: 'ไม่พบ access token ของเพจนี้ ตั้งค่าเพจให้ครบก่อน' }, 400);
    }

    const commentId = deriveCommentId(item.fb_id, item.fb_post_id);

    let fbResult;
    try {
      fbResult = await setHidden(commentId, hidden, page.access_token);
    } catch (fbErr) {
      const isTimeout = fbErr && fbErr.name === 'AbortError';
      console.error('moderate-comment error: เรียก Facebook ไม่สำเร็จ', isTimeout ? 'timeout' : fbErr);
      return json(
        { error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : 'เชื่อมต่อ Facebook ไม่สำเร็จ' },
        502
      );
    }

    if (fbResult && fbResult.error) {
      const e = fbResult.error;
      // subcode 1446036 = "Duplicate Mark Spam Request" — คอมเมนต์นี้ถูกซ่อนไปแล้วจริงๆ ตั้งแต่
      // ครั้งก่อน (Facebook ทำสำเร็จแล้ว แค่ตอนนั้นเราไม่ได้เขียนสถานะฝั่งเราให้ตรงกัน) ไม่ใช่ error
      // จริง ให้ถือว่าสำเร็จแล้วต่อ (idempotent) แทนที่จะโชว์ error ซ้ำไปเรื่อยๆ
      const alreadyDone = hidden && e.error_subcode === 1446036;
      if (!alreadyDone) {
        console.error('moderate-comment error: Facebook ปฏิเสธ', e);
        const detail = [e.message, e.type, e.code != null ? `code ${e.code}` : null, e.error_subcode != null ? `subcode ${e.error_subcode}` : null]
          .filter(Boolean).join(' | ');
        return json({ error: `Facebook ปฏิเสธ: ${detail || 'unknown error'}` }, 502);
      }
    }

    if (hidden) {
      await markFeedItem(itemId, { status: 'spam_hidden', ai_reason: 'ซ่อนโดยแอดมินด้วยตนเอง' });
    } else {
      await markFeedItem(itemId, { status: 'pending' });
    }

    return json({ ok: true });
  } catch (err) {
    console.error('moderate-comment error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}

// fb_id ถูกเก็บตอน insert เป็น `${post_id}_${comment_id}` (ดู api/webhook.js) — ตัด prefix ของ
// fb_post_id ออกเพื่อให้ได้ comment_id ดิบสำหรับยิง Graph API (แพทเทิร์นเดียวกับ api/reply.mjs)
function deriveCommentId(fbId, fbPostId) {
  if (fbPostId && fbId.startsWith(`${fbPostId}_`)) {
    return fbId.slice(fbPostId.length + 1);
  }
  return fbId;
}

async function fetchFeedItemWithPage(id) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?id=eq.${encodeURIComponent(id)}&select=id,page_id,type,fb_id,fb_post_id,pages(access_token)`;
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

// สั่งซ่อน/เลิกซ่อนคอมเมนต์บน Facebook จริง: POST /{comment-id} พร้อม is_hidden=true|false
async function setHidden(commentId, hidden, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}`;
  const params = new URLSearchParams({ is_hidden: String(hidden), access_token: accessToken });
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return r.json();
}
