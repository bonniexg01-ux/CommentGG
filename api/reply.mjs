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
const GRAPH_VERSION = 'v23.0';

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

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

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
      console.error('reply error: เรียก Facebook Graph API ไม่สำเร็จ', fbErr);
      await markFeedItem(itemId, { status: 'failed' });
      return json({ error: 'เชื่อมต่อ Facebook ไม่สำเร็จ ลองใหม่อีกครั้ง' }, 502);
    }

    if (fbResult && fbResult.error) {
      console.error('reply error: Facebook ปฏิเสธการส่ง', fbResult.error);
      await markFeedItem(itemId, { status: 'failed' });
      return json(
        { error: `Facebook ปฏิเสธการส่ง: ${fbResult.error.message || 'unknown error'}` },
        502
      );
    }

    // สำเร็จจริงแล้ว — ตอบกลับ dashboard ทันที ไม่ต้องรอ Supabase เขียนเสร็จก่อน (fire-and-forget)
    // เพื่อให้ผู้ใช้รู้สึกว่าปุ่ม "ส่ง" เร็วขึ้น การเขียนสถานะยังเกิดขึ้นแน่นอน แค่ไม่บล็อกการตอบกลับ
    markFeedItem(itemId, { status: 'replied', admin_reply: text }).catch((e) =>
      console.error('reply warning: mark replied failed after successful FB send', e)
    );
    return json({ ok: true });
  } catch (err) {
    console.error('reply error', err);
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
  const r = await fetch(url, {
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}
