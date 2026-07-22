// api/post-detail.mjs
// ให้แอดมินกดแว่นขยายที่แถวไหน แล้วดู "คอมเมนต์นั้นเดี่ยวๆ พร้อมบริบทของโพสต์ต้นทาง" จาก Facebook
// ได้เลย (รูป/แคปชั่นของโพสต์ต้นทางถ้ามี + ข้อความคอมเมนต์เต็ม + รูปที่แนบมากับคอมเมนต์ถ้ามี +
// ชื่อคนคอมเมนต์ + เวลา + ลิงก์เปิดดูบน Facebook) โดยไม่ต้องออกไปเปิด Facebook เอง —
// ดึงสดทุกครั้งที่กด (ไม่ได้แคชไว้ในระบบเรา)
//
// เอาเฉพาะคอมเมนต์ที่กดดู ไม่ใช่คอมเมนต์อื่นๆ ทั้งหมดใต้โพสต์เดียวกัน (ของเดิมเคยดึงมาทั้งเธรดกว้างไป)
// แต่ยังดึงโพสต์ต้นทางมาโชว์คู่กันด้วย เพื่อให้รู้บริบทว่ากำลังดูคอมเมนต์ใต้โพสต์อะไร
//
// รับ itemId (feed_items.id) แล้วมาหา fb_id/fb_post_id + page access_token ต่อ (แพทเทิร์นเดียวกับ
// api/reply.mjs) แล้วดึง comment_id จริงด้วย deriveCommentId แบบเดียวกับตอนตอบกลับ
//
// ใช้ SUPABASE_SERVICE_ROLE_KEY ฝั่งเซิร์ฟเวอร์เท่านั้น (เหตุผลเดียวกับ reply.mjs — ตาราง pages
// ไม่เปิดให้ frontend อ่าน access_token ตรงๆ)

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
  if (request.method !== 'GET') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  try {
    if (!SERVICE_KEY) {
      console.error('post-detail error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('itemId');
    if (!itemId) return json({ error: 'itemId จำเป็นต้องมี' }, 400);

    const item = await fetchFeedItemWithPage(itemId);
    if (!item) return json({ error: 'ไม่พบรายการนี้ในระบบ' }, 404);

    if (item.type !== 'comment' || !item.fb_id) {
      return json({ error: 'รายการนี้ไม่ใช่คอมเมนต์ใต้โพสต์ (เป็นข้อความ Inbox)' }, 400);
    }

    const page = item.pages;
    if (!page || !page.access_token) {
      return json({ error: 'ไม่พบ access token ของเพจนี้ ตั้งค่าเพจให้ครบก่อน' }, 400);
    }

    const commentId = deriveCommentId(item.fb_id, item.fb_post_id);

    let comment, post;
    try {
      // ดึงคอมเมนต์ที่กด + โพสต์ต้นทาง (เอาแค่รูป/แคปชั่นพอ ให้รู้บริบทว่าคอมเมนต์นี้อยู่ใต้โพสต์อะไร)
      // ยิงขนานกัน ถ้าโพสต์ดึงไม่ได้ (เช่น โดนลบ) ก็ไม่ให้ทั้งคำขอพัง แค่ไม่มีส่วนโพสต์ให้แสดง
      const results = await Promise.allSettled([
        fetchComment(commentId, page.access_token),
        item.fb_post_id ? fetchPost(item.fb_post_id, page.access_token) : Promise.resolve(null),
      ]);
      comment = results[0].status === 'fulfilled' ? results[0].value : null;
      post = results[1].status === 'fulfilled' ? results[1].value : null;
      if (!comment) throw (results[0].reason || new Error('โหลดคอมเมนต์ไม่สำเร็จ'));
    } catch (fbErr) {
      const isTimeout = fbErr && fbErr.name === 'AbortError';
      console.error('post-detail error: เรียก Facebook ไม่สำเร็จ', isTimeout ? 'timeout' : fbErr);
      return json(
        { error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : 'เชื่อมต่อ Facebook ไม่สำเร็จ' },
        502
      );
    }

    if (comment && comment.error) {
      return json({ error: `Facebook ปฏิเสธ: ${comment.error.message || 'unknown error'}` }, 502);
    }

    // รูปที่แนบมากับคอมเมนต์ (ถ้ามี) — เอาทั้งรูปเดี่ยวและ album หลายรูป
    const images = [];
    const att = comment.attachment;
    if (att && att.media && att.media.image && att.media.image.src) images.push(att.media.image.src);
    if (att && att.subattachments && Array.isArray(att.subattachments.data)) {
      for (const sub of att.subattachments.data) {
        if (sub.media && sub.media.image && sub.media.image.src) images.push(sub.media.image.src);
      }
    }

    return json({
      commentId,
      message: comment.message || '',
      from: comment.from ? comment.from.name : null,
      createdTime: comment.created_time || null,
      permalinkUrl: comment.permalink_url || null,
      images,
      post: post && !post.error
        ? { message: post.message || null, fullPicture: post.full_picture || null }
        : null,
    });
  } catch (err) {
    console.error('post-detail error', err);
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
  const url = `${SUPABASE_URL}/rest/v1/feed_items?id=eq.${encodeURIComponent(id)}&select=id,page_id,type,fb_id,fb_post_id,status,pages(access_token)`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function fetchComment(commentId, accessToken) {
  const fields = 'message,from,created_time,permalink_url,attachment{media,type,url,subattachments}';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  return r.json();
}

async function fetchPost(postId, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(postId)}?fields=message,full_picture&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  return r.json();
}
