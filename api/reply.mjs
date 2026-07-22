// api/reply.mjs
// รับคำขอจากหน้า dashboard เมื่อแอดมินกด "ส่งข้อความ" แล้วยิงตอบกลับไปที่ Facebook จริง
// (คอมเมนต์ -> POST /{comment-id}/comments, ข้อความ Inbox -> POST /me/messages)
// ใช้ SUPABASE_SERVICE_ROLE_KEY ฝั่งเซิร์ฟเวอร์เท่านั้นเพื่ออ่าน page access_token ที่เก็บไว้ใน
// ตาราง pages (คอลัมน์นี้ไม่ถูก expose ผ่าน view pages_public ที่ frontend ใช้ตามปกติ)
//
// สำคัญ: access_token และข้อความ (ซึ่งอาจมีภาษาไทย) ถูกส่งผ่าน "body" ของ request เท่านั้น
// ไม่เคยถูกนำไปใส่ใน header ใดๆ เพื่อป้องกันปัญหา
// "Cannot convert argument to a ByteString" ที่เกิดจากอักขระนอก Latin1 หลุดเข้า header
//
// สถานะจะถูกตั้งเป็น 'replied' ก็ต่อเมื่อ Facebook ตอบกลับสำเร็จจริงเท่านั้น
// ถ้า Facebook ปฏิเสธ/error จะตั้งเป็น 'failed' แทน (ไม่ใช่ 'replied') เพื่อไม่ให้ dashboard
// ขึ้น "ตอบแล้ว" ทั้งที่ไม่มีอะไรถูกส่งออกไปจริง
//
// รันบน Vercel Edge Runtime แทน Node serverless ธรรมดา — cold start แทบเป็นศูนย์ และ Vercel
// จะเลือกจุดที่ใกล้ผู้เรียกที่สุดให้อัตโนมัติ (ไม่ต้อง pin region เอง เผื่อ Facebook/ผู้ใช้งานอยู่คนละฝั่งโลก)

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// publishable/anon key — ใช้แค่ตรวจสอบ token ผู้ใช้ที่แนบมากับคำขอผ่าน /auth/v1/user เท่านั้น
// (ค่านี้ถูกออกแบบให้ฝังในฝั่ง client ได้อยู่แล้ว ไม่ใช่ความลับเหมือน SERVICE_KEY)
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const GRAPH_VERSION = 'v23.0';
// ถ้า Facebook ไม่ตอบภายในเวลานี้ ให้ตัดการเชื่อมต่อเองแล้วมาร์ค 'failed' ทันที
// กันไม่ให้ Vercel Edge Function ถูก platform ตัดจบกลางคันแบบเงียบๆ (ซึ่งจะทำให้ไม่มีการเขียน
// สถานะลง Supabase เลยสักครั้ง — รายการค้างเป็น 'pending' ตลอดไปโดยไม่มีใครรู้ว่าส่งไม่สำเร็จ)
const FB_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, options, timeoutMs = FB_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

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

// เดิม endpoint นี้ไม่เช็คเลยว่าใครเป็นคนเรียก -- ใครก็ตามที่รู้ URL ยิง POST เข้ามาตรงๆ ได้ทันที
// (ส่งข้อความจริงไป Facebook โดยไม่ต้องล็อกอินผ่านหน้าเว็บเลย) ตอนนี้ตรวจ token ที่แนบมากับ
// Authorization header ผ่าน Supabase Auth ก่อนเสมอ ไม่มี token ที่ใช้ได้ = ปฏิเสธ
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

  // เอาไว้ให้ outer catch ด้านล่างใช้มาร์ค 'failed' ได้ ถ้า error เกิดขึ้นตรงไหนก็ตามหลังจากรู้ itemId แล้ว
  // (เดิม error ที่เกิดนอกช่วงเรียก Facebook โดยตรงจะหลุดไม่เขียนสถานะอะไรเลย รายการค้าง 'pending' เงียบๆ)
  let itemIdForCleanup;

  try {
    if (!SERVICE_KEY) {
      console.error('reply error: missing SUPABASE_SERVICE_ROLE_KEY env var');
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
    itemIdForCleanup = itemId;

    // ดึงรายการ + access_token ของเพจในคำเดียว (join ผ่าน PostgREST embed)
    // แทนที่จะยิง Supabase 2 รอบแยกกัน — ลดเวลาแฝงของปุ่ม "ส่ง" ลงหนึ่ง round trip
    const item = await fetchFeedItemWithPage(itemId);
    if (!item) return json({ error: 'ไม่พบรายการนี้ในระบบ' }, 404);
    if (item.status === 'replied') {
      return json({ ok: true, alreadyReplied: true });
    }

    const page = item.pages;
    if (!page || !page.access_token) {
      return json({ error: 'ไม่พบ access token ของเพจนี้ ตั้งค่าเพจให้ครบก่อน' }, 400);
    }

    let fbResult;
    try {
      if (item.type === 'comment') {
        const commentId = deriveCommentId(item.fb_id, item.fb_post_id);
        fbResult = await postCommentReply(commentId, text, page.access_token);
      } else if (item.type === 'message') {
        fbResult = await postMessengerReply(item.author_fb_id, text, page.access_token);
      } else {
        return json({ error: `ไม่รู้จักประเภทรายการ: ${item.type}` }, 400);
      }
    } catch (fbErr) {
      const isTimeout = fbErr && fbErr.name === 'AbortError';
      console.error('reply error: เรียก Facebook Graph API ไม่สำเร็จ', isTimeout ? 'timeout' : fbErr);
      await markFeedItem(itemId, { status: 'failed' });
      return json(
        { error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : 'เชื่อมต่อ Facebook ไม่สำเร็จ ลองใหม่อีกครั้ง' },
        502
      );
    }

    if (fbResult && fbResult.error) {
      console.error('reply error: Facebook ปฏิเสธการส่ง', fbResult.error);
      await markFeedItem(itemId, { status: 'failed' });
      return json(
        { error: `Facebook ปฏิเสธการส่ง: ${fbResult.error.message || 'unknown error'}` },
        502
      );
    }

    // สำเร็จจริงแล้ว — ต้อง await การเขียนสถานะนี้ก่อน return เสมอ (ห้ามทำเป็น fire-and-forget)
    // เดิมเคยปล่อยแบบไม่ await เพื่อให้ตอบกลับ dashboard เร็วขึ้น แต่บน Vercel Edge Runtime
    // พอ return response แล้ว instance อาจถูกเก็บกวาดทิ้งทันทีก่อน request ที่ยังไม่ await เสร็จ
    // ทำให้สถานะ 'replied' ไม่เคยถูกเขียนลง Supabase จริงเลยสักครั้ง (ส่งไป Facebook สำเร็จ แต่
    // dashboard ไม่รู้ พอรีเฟรชเลยเห็นเป็น pending เหมือนไม่เคยตอบ) — ต้อง await แลกกับหน่วงเวลาส่งนิดหน่อย
    //
    // เก็บ comment id ของ "คำตอบที่แอดมินโพสไป" ไว้ด้วย (fbResult.id ที่ Facebook ส่งกลับมาตอนสร้าง
    // คอมเมนต์สำเร็จ) — ใช้สำหรับปุ่มแก้ไข/ลบคำตอบทีหลัง (api/edit-reply.mjs, api/delete-reply.mjs)
    // มีให้เฉพาะ type: 'comment' เท่านั้น ข้อความ Messenger ไม่มี concept นี้
    const updateFields = { status: 'replied', admin_reply: text };
    if (item.type === 'comment' && fbResult && fbResult.id) {
      updateFields.admin_reply_fb_id = fbResult.id;
    }
    try {
      await markFeedItem(itemId, updateFields);
    } catch (writeErr) {
      // Facebook รับข้อความไปแล้วจริง แค่บันทึกสถานะฝั่งเราไม่สำเร็จ — แจ้งเตือนแต่ไม่ต้อง fail request
      // (ไม่งั้น dashboard จะ mark เป็น failed ทั้งที่จริงๆ ส่งไป Facebook สำเร็จแล้ว จะกลายเป็นตอบซ้ำ)
      console.error('reply warning: FB ส่งสำเร็จ แต่บันทึกสถานะ replied ลง Supabase ไม่สำเร็จ', writeErr);
    }
    return json({ ok: true });
  } catch (err) {
    console.error('reply error', err);
    // best-effort: กันรายการค้าง 'pending' เงียบๆ ถ้ามี itemId แล้วแต่ error เกิดขึ้นก่อนจะรู้ผล Facebook
    if (itemIdForCleanup) {
      markFeedItem(itemIdForCleanup, { status: 'failed' }).catch(() => {});
    }
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}

// fb_id ถูกเก็บตอน insert เป็น `${post_id}_${comment_id}` (ดู api/webhook.js)
// ตัด prefix ของ fb_post_id ออกเพื่อให้ได้ comment_id ดิบสำหรับยิง Graph API
function deriveCommentId(fbId, fbPostId) {
  if (fbPostId && fbId.startsWith(`${fbPostId}_`)) {
    return fbId.slice(fbPostId.length + 1);
  }
  return fbId;
}

// ดึง feed_items แถวเดียว พร้อม access_token ของเพจเจ้าของในคำสั่งเดียว (PostgREST embed/join
// ผ่าน foreign key feed_items.page_id -> pages.id) แทนการยิง 2 คำสั่งแยกกัน
async function fetchFeedItemWithPage(id) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?id=eq.${encodeURIComponent(id)}&select=id,page_id,type,fb_id,fb_post_id,author_fb_id,status,pages(access_token)`;
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

// ตอบกลับคอมเมนต์: access_token และ message ส่งผ่าน body แบบ form-urlencoded เท่านั้น ไม่แตะ header
async function postCommentReply(commentId, message, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}/comments`;
  const params = new URLSearchParams({ message: String(message), access_token: accessToken });
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return r.json();
}

// ส่งข้อความ Messenger ตอบกลับ: access_token และข้อความอยู่ใน JSON body เท่านั้น
async function postMessengerReply(recipientFbId, text, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`;
  const payload = {
    recipient: { id: recipientFbId },
    messaging_type: 'RESPONSE',
    message: { text: String(text) },
    access_token: accessToken,
  };
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}
