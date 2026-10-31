// api/sync-posts.mjs
// ดึง "โพสต์ใหม่" (ไม่ใช่คอมเมนต์) จากทุกแฟนเพจที่มีในระบบ มาเก็บไว้ในตาราง page_posts สำหรับหน้า
// "โพสต์เพจ" ใหม่ — ต่างจาก sync-comments.mjs ที่เป็นคนละวัตถุประสงค์กัน (ดึงคอมเมนต์ใต้โพสต์ ไม่ใช่
// ตัวโพสต์เอง) และ sync-comments.mjs จะดึงเฉพาะเพจที่ needs_polling=true เท่านั้น ส่วนตัวนี้ดึง "ทุก
// เพจที่ active" ตามที่ขอ (ไม่จำกัดแค่เพจที่ตั้ง polling คอมเมนต์ไว้)
//
// เรียกจากฝั่ง frontend เป็นระยะ (ดู syncPagePostsFromFb ใน index.html) เฉพาะตอนมีคนล็อกอินใช้งาน
// แดชบอร์ดอยู่จริงเท่านั้น เหตุผลเดียวกับ sync-comments.mjs (แผน Cron ของ Vercel Hobby ไม่พอ)

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const GRAPH_VERSION = 'v23.0';
const FB_TIMEOUT_MS = 12000;
const POSTS_PER_PAGE = 10;
// ย้อนดูโพสต์ 14 วันล่าสุดพอ (โพสต์ออกไม่บ่อยเท่าคอมเมนต์ แต่ก็ไม่จำเป็นต้องไล่ทวนเก่ามาก)
const SINCE_DAYS = 14;

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
      console.error('sync-posts error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    const pages = await fetchActivePages();
    if (!pages.length) return json({ ok: true, pagesChecked: 0, inserted: 0 });

    let inserted = 0;
    const seenPostIds = [];
    for (const page of pages) {
      try {
        inserted += await syncOnePage(page, seenPostIds);
      } catch (err) {
        console.error('sync-posts error: syncOnePage ล้มเหลว', page.page_id, err);
      }
    }

    // สำรองกรณี webhook ไม่ได้ส่งโพสต์ใหม่มา — ให้ api/push.js เช็คว่ามีประกาศสำคัญที่ยังไม่เคยส่งแจ้งเตือนไหม
    // (ส่งต่อ Authorization ของคนที่เรียกมา; api/push.js กันส่งซ้ำเองด้วย page_posts.push_sent_at)
    if (seenPostIds.length) {
      try {
        await fetch(new URL('/api/push', request.url).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: request.headers.get('Authorization') || '' },
          body: JSON.stringify({ action: 'notify-posts', fbPostIds: seenPostIds }),
        });
      } catch (err) {
        console.error('sync-posts error: เรียก api/push ไม่สำเร็จ', err);
      }
    }

    return json({ ok: true, pagesChecked: pages.length, inserted });
  } catch (err) {
    console.error('sync-posts error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}

// ดึง "ทุกเพจที่ active" ไม่กรองด้วย needs_polling (ต่างจาก sync-comments.mjs) ตามที่ขอให้ครอบคลุม
// ทุกเพจที่มีในระบบตอนนี้
async function fetchActivePages() {
  const url = `${SUPABASE_URL}/rest/v1/pages?is_active=eq.true&select=id,page_id,access_token`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) {
    console.error('sync-posts error: fetchActivePages ล้มเหลว', r.status, await r.text().catch(() => ''));
    return [];
  }
  return r.json();
}

async function syncOnePage(page, seenPostIds = []) {
  if (!page.access_token) return 0;

  const posts = await fetchRecentPostsFull(page.page_id, page.access_token);
  let inserted = 0;

  for (const post of posts) {
    seenPostIds.push(post.id);
    const ok = await upsertPagePost({
      page_id: page.id,
      fb_post_id: post.id,
      message: post.message || post.story || '',
      image_url: extractImageUrl(post),
      permalink_url: post.permalink_url || null,
      posted_at: post.created_time || null,
    });
    if (ok) inserted += 1;
  }
  return inserted;
}

// รูปภาพของโพสต์ — full_picture เป็น field ตรงไปตรงมาที่สุด (Facebook เลือกรูปเด่นของโพสต์ให้เองแล้ว
// ใช้ได้ทั้งโพสต์รูปเดี่ยว/อัลบั้ม/ลิงก์ที่มีรูปปก) ไม่ไปไล่ attachments{media} เอง กันกรณี edge case
// (วิดีโอ/หลายรูป) ซับซ้อนเกินจำเป็นสำหรับแค่โชว์เป็นรูปประกอบการแจ้งเตือน
function extractImageUrl(post) {
  return post.full_picture || null;
}

async function fetchRecentPostsFull(pageId, accessToken) {
  const sinceTs = Math.floor(Date.now() / 1000) - SINCE_DAYS * 24 * 3600;
  const fields = 'id,message,story,full_picture,permalink_url,created_time';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/posts?fields=${encodeURIComponent(fields)}&since=${sinceTs}&limit=${POSTS_PER_PAGE}&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  const data = await r.json();
  if (data.error) {
    console.error('sync-posts error: fetchRecentPostsFull', data.error);
    return [];
  }
  return Array.isArray(data.data) ? data.data : [];
}

// upsert เข้า page_posts (on_conflict=fb_post_id กันซ้ำ) — คืนค่า true ถ้า insert แถวใหม่จริง
// (แพทเทิร์นเดียวกับ insertFeedItem ใน sync-comments.mjs)
async function upsertPagePost(record) {
  const url = `${SUPABASE_URL}/rest/v1/page_posts?on_conflict=fb_post_id`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(record),
  });
  if (!r.ok) {
    console.error('sync-posts error: upsertPagePost ล้มเหลว', r.status, await r.text().catch(() => ''));
    return false;
  }
  return r.status === 201;
}
