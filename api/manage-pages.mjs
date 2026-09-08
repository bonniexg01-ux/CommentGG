// api/manage-pages.mjs
// ให้แอดมิน (คนที่มีสิทธิ์ can_manage_pages ใน app_metadata เท่านั้น) เพิ่ม/แก้ไขเพจ + access_token
// เองจากหน้าเว็บได้เลย โดยไม่ต้องรอให้แก้ฐานข้อมูลให้ทุกครั้ง
//
// สำคัญเรื่องความปลอดภัย:
// 1. สิทธิ์เช็คจาก app_metadata ของ "user object ที่ยืนยันแล้วจริงๆ ผ่าน Supabase Auth" (ยิงไปถาม
//    /auth/v1/user ด้วย token ที่แนบมา) ไม่ใช่เชื่อค่าที่ client ส่งมาตรงๆ — กัน token ของทีมคนอื่น
//    ที่ไม่มีสิทธิ์ ถูกเอามาแอบเรียก endpoint นี้เขียนข้อมูลเพจได้
// 2. action 'list' ไม่เคยส่ง access_token ตัวจริงกลับไปฝั่ง client เลยแม้แต่คนที่มีสิทธิ์ก็ตาม — ส่งแค่
//    has_token (true/false) ว่ามีตั้งไว้หรือยัง เวลาจะแก้เพจเดิม ถ้าไม่ได้วาง token ใหม่ลงไป ระบบจะ
//    เก็บ token เดิมไว้เฉยๆ ไม่ลบทิ้ง
// 3. ก่อนบันทึก token ใหม่ทุกครั้ง (ทั้งตอนเพิ่มเพจใหม่และแก้เพจเดิม) จะยิงไปเช็คกับ Facebook Graph
//    API จริงก่อนเสมอ ถ้า token ใช้ไม่ได้จะไม่บันทึกและแจ้ง error กลับไปทันที กันบันทึก token ผิด/
//    หมดอายุเข้าไปแบบไม่รู้ตัว (บั๊กที่เจอมาก่อนกับเพจ WarZ TH)

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

const ALLOWED_ENDINGS = new Set(['ค่ะ', 'ครับ']); // ต้องตรงกับ CHECK constraint ของตาราง pages เป๊ะๆ

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

function canManagePages(user) {
  return !!(user && user.app_metadata && user.app_metadata.can_manage_pages);
}

// เช็ค access_token กับ Facebook จริงๆ ก่อนบันทึกเสมอ — ยิง GET ธรรมดาไปที่ตัวเพจเอง (ไม่ใช่
// debug_token) เพราะนี่คือคำขอแบบเดียวกับที่ api/reply.mjs จะใช้จริงตอนตอบคอมเมนต์ ถ้าอันนี้ผ่าน
// แปลว่า token เพจจริงพร้อมใช้งานแน่นอน
async function testFacebookToken(pageId, accessToken) {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
    const r = await fetchWithTimeout(url, { method: 'GET' });
    const data = await r.json();
    if (data.error) {
      return { ok: false, error: data.error.message || 'Facebook ปฏิเสธ token นี้' };
    }
    if (String(data.id) !== String(pageId)) {
      return { ok: false, error: `Token นี้ใช้ได้ แต่เป็นของเพจอื่น (id: ${data.id}) ไม่ตรงกับ Page ID ที่กรอกไว้ (${pageId})` };
    }
    return { ok: true, name: data.name, fbId: data.id };
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : `เชื่อมต่อ Facebook ไม่สำเร็จ: ${err.message || err}` };
  }
}

async function listPages() {
  const url = `${SUPABASE_URL}/rest/v1/pages?select=id,page_id,page_name,game_name,color_hex,emoji,tag,pronoun,ending,hashtag,is_active,needs_polling,created_at,access_token,app_id,app_secret&order=page_name.asc`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) throw new Error('โหลดรายชื่อเพจไม่สำเร็จ');
  const rows = await r.json();
  // ตัด access_token/app_secret ตัวจริงทิ้งก่อนส่งกลับไปฝั่ง client เสมอ เหลือไว้แค่ boolean ว่ามีตั้งไว้หรือยัง
  return rows.map((row) => {
    const { access_token, app_secret, ...rest } = row;
    return { ...rest, has_token: !!access_token, has_webhook: !!app_secret };
  });
}

// ตั้งค่า Webhook ให้ apps อัตโนมัติผ่าน Graph API ล้วนๆ (ไม่ต้องเข้า App Dashboard เอง) — 2 ขั้นตอน:
// 1) POST /{app-id}/subscriptions ผูก callback_url + verify_token ให้แอปนี้ (ทำ handshake กับ
//    callback_url ของเราเองในตัว) 2) POST /{page-id}/subscribed_apps ให้เพจนี้ "สมัครรับ" event
//    จากแอปนี้จริงๆ (ต้องใช้ access_token ของเพจเอง ไม่ใช่ของแอป)
const WEBHOOK_CALLBACK_URL = 'https://commentgg-live.vercel.app/api/webhook';
const WEBHOOK_VERIFY_TOKEN = 'commentgg_self_service_webhook_v1';

async function subscribeWebhook(pageDbId, pageFbId, pageAccessToken, appId, appSecret) {
  // ขั้น 1: ผูก Webhooks product ของแอปนี้เข้ากับ callback_url ของเรา
  const subUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(appId)}/subscriptions`;
  const subParams = new URLSearchParams({
    object: 'page',
    callback_url: WEBHOOK_CALLBACK_URL,
    fields: 'feed',
    verify_token: WEBHOOK_VERIFY_TOKEN,
    access_token: `${appId}|${appSecret}`,
  });
  let r;
  try {
    r = await fetchWithTimeout(subUrl, { method: 'POST', body: subParams });
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ตอนตั้งค่า Webhooks ลองใหม่อีกครั้ง' : `เชื่อมต่อ Facebook ไม่สำเร็จ: ${err.message || err}` };
  }
  const subData = await r.json().catch(() => ({}));
  if (subData.error) {
    return { ok: false, error: `ตั้งค่า Webhooks ของแอปไม่สำเร็จ: ${subData.error.message || 'App ID หรือ App Secret ไม่ถูกต้อง'}` };
  }

  // ขั้น 2: ให้เพจนี้สมัครรับ event ผ่านแอปนี้จริง (ใช้ access_token ของเพจเอง)
  const pageSubUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageFbId)}/subscribed_apps`;
  const pageSubParams = new URLSearchParams({
    subscribed_fields: 'feed',
    access_token: pageAccessToken,
  });
  let r2;
  try {
    r2 = await fetchWithTimeout(pageSubUrl, { method: 'POST', body: pageSubParams });
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ตอนผูกเพจกับแอป ลองใหม่อีกครั้ง' : `เชื่อมต่อ Facebook ไม่สำเร็จ: ${err.message || err}` };
  }
  const pageSubData = await r2.json().catch(() => ({}));
  if (pageSubData.error) {
    return { ok: false, error: `ผูกเพจเข้ากับแอปไม่สำเร็จ: ${pageSubData.error.message || 'ตรวจสอบว่า Access Token ของเพจยังใช้ได้อยู่'}` };
  }
  if (!pageSubData.success) {
    return { ok: false, error: 'Facebook ไม่ยืนยันว่าผูกสำเร็จ ลองใหม่อีกครั้ง' };
  }

  // สำเร็จ — บันทึก app_id/app_secret ลงเพจนี้ ให้ webhook.js เอาไปตรวจลายเซ็น event ที่เข้ามาต่อไป
  const patchUrl = `${SUPABASE_URL}/rest/v1/pages?id=eq.${encodeURIComponent(pageDbId)}`;
  const patchR = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ app_id: String(appId).trim(), app_secret: String(appSecret).trim() }),
  });
  if (!patchR.ok) {
    console.error('manage-pages error: บันทึก app_id/app_secret ไม่สำเร็จ', patchR.status, await patchR.text().catch(() => ''));
    return { ok: false, error: 'ผูก Webhook กับ Facebook สำเร็จ แต่บันทึกลงระบบไม่สำเร็จ ลองกดใหม่อีกครั้ง' };
  }

  return { ok: true };
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const user = await requireAuth(request);
  if (!user) return json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' }, 401);
  if (!canManagePages(user)) return json({ error: 'คุณไม่มีสิทธิ์จัดการเพจ' }, 403);

  if (!SERVICE_KEY) {
    console.error('manage-pages error: missing SUPABASE_SERVICE_ROLE_KEY env var');
    return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
  }
  const { action } = body || {};

  try {
    if (action === 'list') {
      const pages = await listPages();
      return json({ ok: true, pages });
    }

    if (action === 'test-token') {
      const { pageId, accessToken } = body || {};
      if (!pageId || !accessToken) return json({ error: 'pageId และ accessToken จำเป็นต้องมี' }, 400);
      const result = await testFacebookToken(pageId, accessToken);
      return json(result, result.ok ? 200 : 400);
    }

    if (action === 'save') {
      const { id, pageId, pageName, gameName, accessToken, emoji, colorHex, tag, pronoun, ending, hashtag, isActive, needsPolling } = body || {};
      if (!pageId || !String(pageId).trim()) return json({ error: 'Page ID จำเป็นต้องมี' }, 400);
      if (!pageName || !String(pageName).trim()) return json({ error: 'ชื่อเพจจำเป็นต้องมี' }, 400);
      if (ending && !ALLOWED_ENDINGS.has(ending)) {
        return json({ error: `คำลงท้ายต้องเป็น "ค่ะ" หรือ "ครับ" เท่านั้น (ได้รับ: ${ending})` }, 400);
      }

      // ถ้ามีการวาง token ใหม่มาด้วย (ไม่ว่าจะเพิ่มเพจใหม่หรือแก้เพจเดิม) ต้องเช็คกับ Facebook จริง
      // ให้ผ่านก่อนเสมอ ถึงจะยอมบันทึกลงฐานข้อมูล — ถ้าไม่ผ่านหยุดตรงนี้เลย ไม่บันทึกอะไรทั้งนั้น
      let fbCheckedName = null;
      if (accessToken && String(accessToken).trim()) {
        const testResult = await testFacebookToken(pageId, accessToken);
        if (!testResult.ok) {
          return json({ error: `ตรวจสอบ Token ไม่ผ่าน: ${testResult.error}` }, 400);
        }
        fbCheckedName = testResult.name;
      } else if (!id) {
        // เพจใหม่ (ยังไม่มี id เดิม) บังคับต้องมี token ตั้งแต่แรกเลย ไม่งั้นเพิ่มเพจแล้วตอบคอมเมนต์
        // ไม่ได้ทันที เดี๋ยวจะงงว่าทำไมส่งไม่ออก
        return json({ error: 'เพจใหม่ต้องใส่ Access Token ด้วย' }, 400);
      }

      const fields = {
        page_id: String(pageId).trim(),
        page_name: String(pageName).trim(),
        game_name: gameName ? String(gameName).trim() : null,
        emoji: emoji || '🎮',
        color_hex: colorHex || '#2563eb',
        tag: tag ? String(tag).trim() : null,
        pronoun: pronoun ? String(pronoun).trim() : null,
        ending: ending || 'ค่ะ',
        hashtag: hashtag ? String(hashtag).trim() : null,
        is_active: isActive !== false,
        needs_polling: !!needsPolling,
      };
      if (accessToken && String(accessToken).trim()) {
        fields.access_token = String(accessToken).trim();
      }

      let url;
      let method;
      if (id) {
        url = `${SUPABASE_URL}/rest/v1/pages?id=eq.${encodeURIComponent(id)}`;
        method = 'PATCH';
      } else {
        url = `${SUPABASE_URL}/rest/v1/pages`;
        method = 'POST';
      }

      const r = await fetch(url, {
        method,
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify(fields),
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error('manage-pages error: Supabase write failed', r.status, errText);
        // unique constraint บน page_id — เจอบ่อยสุดตอนพิมพ์ Page ID ซ้ำกับเพจที่มีอยู่แล้วตอนเพิ่มใหม่
        const isDuplicate = errText.includes('duplicate key') || errText.includes('pages_page_id_key');
        return json(
          { error: isDuplicate ? 'Page ID นี้มีอยู่ในระบบแล้ว (ซ้ำกับเพจอื่น)' : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง' },
          isDuplicate ? 409 : 502
        );
      }

      const rows = await r.json().catch(() => []);
      return json({ ok: true, page: rows[0] || null, fbCheckedName });
    }

    if (action === 'subscribe-webhook') {
      const { id, appId, appSecret } = body || {};
      if (!id) return json({ error: 'ต้องบันทึกเพจนี้ไว้ก่อน ถึงจะผูก Webhook ได้ (ต้องมี Page ID + Access Token อยู่แล้ว)' }, 400);
      if (!appId || !String(appId).trim()) return json({ error: 'App ID จำเป็นต้องมี' }, 400);
      if (!appSecret || !String(appSecret).trim()) return json({ error: 'App Secret จำเป็นต้องมี' }, 400);

      const pageUrl = `${SUPABASE_URL}/rest/v1/pages?id=eq.${encodeURIComponent(id)}&select=page_id,access_token`;
      const pageR = await fetch(pageUrl, { headers: sbHeaders });
      if (!pageR.ok) return json({ error: 'โหลดข้อมูลเพจไม่สำเร็จ' }, 502);
      const pageRows = await pageR.json();
      const page = pageRows[0];
      if (!page) return json({ error: 'ไม่พบเพจนี้ในระบบ' }, 404);
      if (!page.access_token) return json({ error: 'เพจนี้ยังไม่มี Access Token — ใส่ Access Token แล้วบันทึกก่อน' }, 400);

      const result = await subscribeWebhook(id, page.page_id, page.access_token, String(appId).trim(), String(appSecret).trim());
      return json(result, result.ok ? 200 : 400);
    }

    return json({ error: `ไม่รู้จัก action: ${action}` }, 400);
  } catch (err) {
    console.error('manage-pages error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}
