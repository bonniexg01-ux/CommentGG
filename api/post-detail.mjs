// api/post-detail.mjs
// ให้แอดมินกดแว่นขยายแล้วดู "โพสต์ต้นทาง + คอมเมนต์ทั้งหมดของโพสต์นั้น" จาก Facebook ได้เลย
// โดยไม่ต้องออกไปเปิด Facebook เอง — ดึงสดจาก Graph API ทุกครั้งที่กด (ไม่ได้แคชไว้ในระบบเรา)
//
// รับ itemId (feed_items.id) แล้วมาหา fb_post_id + page access_token ต่อ (แพทเทิร์นเดียวกับ
// api/reply.mjs) จากนั้นยิง Graph API 2 คำสั่งขนานกัน: ตัวโพสต์ และ คอมเมนต์ทั้งหมดของโพสต์
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

    if (item.type !== 'comment' || !item.fb_post_id) {
      return json({ error: 'รายการนี้ไม่มีโพสต์ต้นทาง (เป็นข้อความ Inbox ไม่ใช่คอมเมนต์ใต้โพสต์)' }, 400);
    }

    const page = item.pages;
    if (!page || !page.access_token) {
      return json({ error: 'ไม่พบ access token ของเพจนี้ ตั้งค่าเพจให้ครบก่อน' }, 400);
    }

    let post, comments;
    try {
      [post, comments] = await Promise.all([
        fetchPost(item.fb_post_id, page.access_token),
        fetchComments(item.fb_post_id, page.access_token),
      ]);
    } catch (fbErr) {
      const isTimeout = fbErr && fbErr.name === 'AbortError';
      console.error('post-detail error: เรียก Facebook ไม่สำเร็จ', isTimeout ? 'timeout' : fbErr);
      return json(
        { error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : 'เชื่อมต่อ Facebook ไม่สำเร็จ' },
        502
      );
    }

    if (post && post.error) {
      return json({ error: `Facebook ปฏิเสธ: ${post.error.message || 'unknown error'}` }, 502);
    }

    return json({
      post: {
        message: post.message || null,
        fullPicture: post.full_picture || null,
        permalinkUrl: post.permalink_url || null,
        createdTime: post.created_time || null,
        from: post.from ? post.from.name : null,
      },
      comments: (comments && comments.data ? comments.data : []).map((c) => ({
        id: c.id,
        message: c.message || '',
        from: c.from ? c.from.name : 'ไม่ทราบชื่อ',
        createdTime: c.created_time || null,
      })),
    });
  } catch (err) {
    console.error('post-detail error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}

async function fetchFeedItemWithPage(id) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?id=eq.${encodeURIComponent(id)}&select=id,page_id,type,fb_id,fb_post_id,status,pages(access_token)`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function fetchPost(postId, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(postId)}?fields=message,full_picture,permalink_url,created_time,from&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  return r.json();
}

async function fetchComments(postId, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(postId)}/comments?fields=message,from,created_time&limit=25&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  return r.json();
}
