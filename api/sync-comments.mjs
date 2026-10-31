// api/sync-comments.mjs
// สำรองไว้สำหรับเพจที่ยังตั้งค่า Webhook เรียลไทม์ไม่ได้ (เช่น ยังไม่มี App Secret ของแอปที่ออก
// Token ให้) — จะ "ไปดึง" คอมเมนต์ล่าสุดจากเพจเองเป็นระยะๆ แทนที่จะรอ Facebook ส่งเข้ามา (push)
// ทำงานคล้าย api/webhook.js (insert เข้า feed_items แบบเดียวกัน กรอง echo แบบเดียวกัน) ต่างกันแค่
// จุดเริ่มต้น: อันนี้เราเป็นฝ่ายไปถามเอง ไม่ใช่ Facebook เป็นฝ่ายส่งมา
//
// เรียกจากฝั่ง frontend เป็นระยะ (ดู pollSyncComments ใน index.html) เฉพาะตอนมีคนล็อกอินใช้งาน
// แดชบอร์ดอยู่จริงเท่านั้น — ไม่ได้ผูกกับ Vercel Cron เพราะแผน Hobby จำกัดความถี่ของ Cron ไว้ที่วันละ
// ครั้ง ไม่พอสำหรับงานนี้
//
// เพจที่ต้องการให้ sync แบบนี้ต้องตั้ง pages.needs_polling = true ไว้ก่อน (เพจอื่นที่ผูก Webhook
// เรียลไทม์ได้ปกติแล้วไม่ต้องยุ่ง ให้ webhook.js จัดการเหมือนเดิม)

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const GRAPH_VERSION = 'v23.0';
const FB_TIMEOUT_MS = 12000;
const POSTS_PER_PAGE = 10;
const COMMENTS_PER_POST = 100;
const MAX_COMMENT_PAGES = 5; // สูงสุด 500 คอมเมนต์ต่อโพสต์ต่อรอบ

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
      console.error('sync-comments error: missing SUPABASE_SERVICE_ROLE_KEY env var');
      return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
    }

    const pages = await fetchPollingPages();
    if (!pages.length) return json({ ok: true, pagesChecked: 0, inserted: 0 });

    let inserted = 0;
    for (const page of pages) {
      try {
        inserted += await syncOnePage(page);
      } catch (err) {
        console.error('sync-comments error: syncOnePage ล้มเหลว', page.page_id, err);
      }
    }

    return json({ ok: true, pagesChecked: pages.length, inserted });
  } catch (err) {
    console.error('sync-comments error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}

async function fetchPollingPages() {
  const url = `${SUPABASE_URL}/rest/v1/pages?needs_polling=eq.true&is_active=eq.true&select=id,page_id,access_token`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) {
    console.error('sync-comments error: fetchPollingPages ล้มเหลว', r.status, await r.text().catch(() => ''));
    return [];
  }
  return r.json();
}

async function syncOnePage(page) {
  if (!page.access_token) return 0;

  const posts = await fetchRecentPosts(page.page_id, page.access_token);
  let inserted = 0;

  for (const post of posts) {
    const { comments, complete, sinceTs } = await fetchRecentComments(post.id, page.access_token);
    const liveFbIds = new Set();

    for (const c of comments) {
      const commenterId = c.from && String(c.from.id);
      // ข้ามคอมเมนต์ที่ "เพจตัวเอง" เป็นคนโพสต์ (echo ของคำตอบแอดมิน) แบบเดียวกับ webhook.js
      if (commenterId === String(page.page_id)) continue;
      // ต้องเป็นรูปแบบเดียวกับ api/webhook.js เป๊ะๆ ("page_post_comment") — เดิมต่อ `${post.id}_${c.id}`
      // ได้ "page_post_post_comment" (c.id ของ Graph มีเลขโพสต์นำหน้าอยู่แล้ว) ทำให้เพจที่เปิดทั้ง polling
      // และ Webhook ได้คอมเมนต์ซ้ำ 2 แถว และ removeDeletedComments ลบแถวที่มาจาก Webhook ทิ้ง
      const fbId = toFbId(post.id, c.id);
      liveFbIds.add(fbId);
      const ok = await insertFeedItem({
        page_id: page.id,
        type: 'comment',
        fb_id: fbId,
        fb_post_id: post.id,
        author_fb_id: c.from && c.from.id,
        author_name: c.from && c.from.name,
        message: c.message || '',
        status: 'pending',
        folder: 'inbox',
      });
      if (ok) inserted += 1;
    }

    // ลูกค้าลบคอมเมนต์ตัวเองทิ้งไปจาก Facebook แล้ว แต่ยังค้างอยู่ในกล่อง "ต้องตอบกลับ" ของเรา —
    // เทียบรายการที่ยังไม่ตอบ (folder=inbox) ของโพสต์นี้กับชุดที่ดึงมาสดๆ ล่าสุด อันไหนไม่มีอยู่จริง
    // แล้วให้ลบทิ้งจากแดชบอร์ดไปด้วย (เฉพาะที่ยังไม่ตอบ ไม่ยุ่งกับ Archive/ประวัติที่ตอบไปแล้ว)
    //
    // ทำเฉพาะตอนดึงคอมเมนต์ของโพสต์นั้นมาได้ "ครบทุกหน้า" เท่านั้น และเทียบเฉพาะแถวที่เข้าระบบหลังช่วง
    // since (+1 ชม. กันขอบ) — เดิมดึงแค่ 50 คอมเมนต์แรกแล้วลบทุกแถวที่ไม่อยู่ในชุดนั้น โพสต์กิจกรรมที่มี
    // คอมเมนต์เป็นร้อยจะโดนลบคอมเมนต์จริงทิ้งไปด้วย
    if (complete) await removeDeletedComments(page.id, post.id, liveFbIds, sinceTs);
  }
  return inserted;
}

// แปลง comment id จาก Graph ให้เป็นรูปแบบ fb_id เดียวกับ api/webhook.js (คัดลอก logic มาตรงๆ)
function toFbId(postId, rawId) {
  const raw = String(rawId);
  if (raw === postId || raw.startsWith(`${postId}_`)) return raw;
  const underscoreIdx = postId.indexOf('_');
  if (underscoreIdx > -1) {
    const pageId = postId.slice(0, underscoreIdx);
    const postNumericId = postId.slice(underscoreIdx + 1);
    if (raw === postNumericId || raw.startsWith(`${postNumericId}_`)) return `${pageId}_${raw}`;
  }
  return `${postId}_${raw}`;
}

async function removeDeletedComments(pageUuid, postId, liveFbIds, sinceTs) {
  const cutoffMs = (sinceTs + 3600) * 1000;
  const existing = (await fetchExistingInboxFbIds(pageUuid, postId))
    .filter((row) => new Date(row.created_at).getTime() >= cutoffMs)
    .map((row) => row.fb_id);
  const toDelete = existing.filter((fbId) => !liveFbIds.has(fbId));
  for (const fbId of toDelete) {
    const url = `${SUPABASE_URL}/rest/v1/feed_items?fb_id=eq.${encodeURIComponent(fbId)}`;
    const r = await fetch(url, { method: 'DELETE', headers: sbHeaders });
    if (!r.ok) {
      console.error('sync-comments error: removeDeletedComments ล้มเหลว', fbId, r.status, await r.text().catch(() => ''));
    }
  }
}

async function fetchExistingInboxFbIds(pageUuid, postId) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?page_id=eq.${encodeURIComponent(pageUuid)}&fb_post_id=eq.${encodeURIComponent(postId)}&folder=eq.inbox&select=fb_id,created_at`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return [];
  return r.json();
}

async function fetchRecentPosts(pageId, accessToken) {
  // since=48 ชม.ล่าสุด เหตุผลเดียวกับ fetchRecentComments ด้านล่าง (กัน sync รอบแรกไล่ทวนโพสต์เก่า)
  const sinceTs = Math.floor(Date.now() / 1000) - 48 * 3600;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/posts?fields=id&since=${sinceTs}&limit=${POSTS_PER_PAGE}&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  const data = await r.json();
  if (data.error) {
    console.error('sync-comments error: fetchRecentPosts', data.error);
    return [];
  }
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchRecentComments(postId, accessToken) {
  const fields = 'id,message,from,created_time';
  // จำกัดแค่คอมเมนต์ 48 ชม.ล่าสุด (since=unix timestamp) กันไม่ให้ sync รอบแรกดึงคอมเมนต์เก่าย้อนหลัง
  // เป็นร้อยรายการเข้ามาพร้อมกันทีเดียว (เพจนี้มีคนเก่าคุยไว้เยอะแล้วผ่านเครื่องมืออื่น ไม่อยากให้ซ้ำ
  // เป็นภาระทีมตรวจซ้ำของเก่า เอาแค่ตามทันจากนี้ไปพอ)
  const sinceTs = Math.floor(Date.now() / 1000) - 48 * 3600;
  // ไล่ตาม paging.next ให้ครบ (สูงสุด MAX_COMMENT_PAGES หน้า) — complete=true เฉพาะตอนได้ครบทุกหน้าจริง
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(postId)}/comments?fields=${encodeURIComponent(fields)}&filter=stream&since=${sinceTs}&limit=${COMMENTS_PER_POST}&access_token=${encodeURIComponent(accessToken)}`;
  const comments = [];
  for (let i = 0; i < MAX_COMMENT_PAGES && url; i++) {
    let data;
    try {
      const r = await fetchWithTimeout(url, { method: 'GET' });
      data = await r.json();
    } catch {
      return { comments, complete: false, sinceTs };
    }
    // โพสต์บางอันอาจปิดคอมเมนต์/ถูกลบ ไม่ให้ทั้งงานพัง แค่ข้ามโพสต์นั้น
    if (data.error) return { comments, complete: false, sinceTs };
    if (Array.isArray(data.data)) comments.push(...data.data);
    url = data.paging && data.paging.next ? data.paging.next : null;
  }
  return { comments, complete: !url, sinceTs };
}

// upsert เข้า feed_items แบบเดียวกับ api/webhook.js เป๊ะๆ (on_conflict=fb_id กันซ้ำ)
// คืนค่า true ถ้าเป็นรายการใหม่จริง (สำหรับนับจำนวนที่เพิ่งเพิ่ม) — ตรวจง่ายๆ จาก header ที่ Supabase
// ส่งกลับตอน insert สำเร็จ (ไม่มีทางรู้ชัวร์ 100% ว่า "ใหม่จริง" หรือ "ชนแล้วข้าม" จาก REST ตรงๆ
// ง่ายกว่าคือเรียก select ก่อน insert แต่เพิ่ม round-trip โดยไม่จำเป็น จึงนับแบบคร่าวๆ พอ)
async function insertFeedItem(record) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?on_conflict=fb_id`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(record),
  });
  if (!r.ok) {
    console.error('sync-comments error: insertFeedItem ล้มเหลว', r.status, await r.text().catch(() => ''));
    return false;
  }
  // Supabase ส่ง 201 กลับเมื่อ insert แถวใหม่จริง และ 201 เหมือนกันแม้ ignore-duplicates ข้ามไป
  // (เพราะ return=minimal ไม่มี body ให้เช็ค) เอา status 201 เป็นตัวประมาณจำนวนที่ "พยายาม insert"
  return r.status === 201;
}
