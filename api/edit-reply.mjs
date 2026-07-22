// api/edit-reply.mjs
// ให้แอดมินแก้ไขข้อความที่ตอบไปแล้ว (คอมเมนต์ของแอดมินเองบน Facebook) ได้ ไม่ต้องลบแล้วตอบใหม่
// ใช้ Graph API: POST /{comment-id} พร้อม message ใหม่ (Facebook แก้ไขคอมเมนต์ของตัวเองแบบนี้)
//
// ต้องมี feed_items.admin_reply_fb_id (comment id ของคำตอบที่แอดมินโพสไป) อยู่ก่อน — เก็บไว้ตอน
// ส่งสำเร็จใน api/reply.mjs รายการที่ตอบไปก่อนหน้านี้ (ก่อนมี column นี้) จะไม่มีให้แก้
//
// สำคัญ: ข้อความ (อาจมีภาษาไทย) ส่งผ่าน body แบบ form-urlencoded เท่านั้น ไม่แตะ header
// (แพทเทิร์นเดียวกับ api/reply.mjs กันปัญหา ByteString)

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  try {
    if (!SERVICE_KEY) {
      console.error('edit-reply error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
    }
    const { itemId, text } = body || {};
    if (!itemId || !text || !String(text).trim()) {
      return json({ error: 'itemId และ text จำเป็นต้องมี' }, 400);
    }

    const item = await fetchFeedItemWithPage(itemId);
    if (!item) return json({ error: 'ไม่พบรายการนี้ในระบบ' }, 404);
    if (!item.admin_reply_fb_id) {
      return json({ error: 'คำตอบนี้ไม่มีข้อมูล comment ID (อาจตอบไปก่อนฟีเจอร์นี้มีผล) แก้ไขผ่านระบบไม่ได้' }, 400);
    }

    const page = item.pages;
    if (!page || !page.access_token) {
      return json({ error: 'ไม่พบ access token ของเพจนี้ ตั้งค่าเพจให้ครบก่อน' }, 400);
    }

    let fbResult;
    try {
      fbResult = await editComment(item.admin_reply_fb_id, text, page.access_token);
    } catch (fbErr) {
      const isTimeout = fbErr && fbErr.name === 'AbortError';
      console.error('edit-reply error: เรียก Facebook ไม่สำเร็จ', isTimeout ? 'timeout' : fbErr);
      return json(
        { error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : 'เชื่อมต่อ Facebook ไม่สำเร็จ' },
        502
      );
    }

    if (fbResult && fbResult.error) {
      console.error('edit-reply error: Facebook ปฏิเสธการแก้ไข', fbResult.error);
      return json({ error: `Facebook ปฏิเสธการแก้ไข: ${fbResult.error.message || 'unknown error'}` }, 502);
    }

    await markFeedItem(itemId, { admin_reply: text });
    return json({ ok: true });
  } catch (err) {
    console.error('edit-reply error', err);
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

// แก้ไขคอมเมนต์ที่แอดมินโพสไปเอง: POST /{comment-id} พร้อม message ใหม่ (ผ่าน body form-urlencoded)
async function editComment(commentId, message, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}`;
  const params = new URLSearchParams({ message: String(message), access_token: accessToken });
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return r.json();
}
