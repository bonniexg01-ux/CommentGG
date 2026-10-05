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

// เช็ค access_token กับ Facebook จริงๆ ก่อนบันทึกเสมอ
//
// เจอจริง: เดิมเช็คแค่ยิง GET /{pageId}?fields=id,name ไปตรงๆ — ปัญหาคือ field id/name เป็นข้อมูล
// สาธารณะของเพจ อ่านได้ด้วย token แทบทุกประเภท "แม้แต่ user access token ของผู้ใช้ทั่วไปก็ยังอ่าน
// ผ่าน" ทำให้การเช็คแบบนี้ไม่สามารถจับได้เลยว่ามีคนเผลอวาง "user token" (token ของบัญชีผู้ใช้ตอนล็อกอิน
// Facebook) แทนที่จะเป็น "page token" (token เฉพาะของเพจ ใช้โพสต์/ตอบคอมเมนต์แทนเพจได้จริง) ลงไป —
// ตรวจสอบผ่านตอนกด "ทดสอบ Token" ทั้งที่ token ใช้ตอบคอมเมนต์จริงไม่ได้ (เจอเคสจริงกับ Cabal)
//
// แก้โดยเช็คผ่าน debug_token ก่อนเสมอ ซึ่งบอกชัดเจนว่า token นี้เป็น "PAGE" หรือ "USER":
// - เป็น PAGE token ของเพจที่ตรงกับ pageId อยู่แล้ว → ใช้ได้เลย
// - เป็น USER token (เผลอวางผิด) → แทนที่จะปฏิเสธเฉยๆ ลองแลก (exchange) เป็น page token ที่ถูกต้องให้
//   อัตโนมัติผ่าน /me/accounts (ถ้า user คนนั้นมีสิทธิ์แอดมินเพจนี้อยู่แล้ว) กันพลาดจากการที่คนวาง
//   token ผิดประเภทโดยไม่รู้ตัว — ไม่ต้องรอให้ใครมาคอยสอนว่า token ไหนถูกประเภทอีกต่อไป
async function testFacebookToken(pageId, accessToken) {
  try {
    const debugUrl = `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(accessToken)}`;
    const dr = await fetchWithTimeout(debugUrl, { method: 'GET' });
    const ddata = await dr.json();
    if (ddata.error) {
      return { ok: false, error: ddata.error.message || 'Facebook ปฏิเสธ token นี้ (ตรวจสอบไม่ผ่าน)' };
    }
    const info = ddata.data || {};
    if (!info.is_valid) {
      return { ok: false, error: 'Token นี้ไม่ valid แล้ว (อาจถูกยกเลิก/หมดอายุ/เปลี่ยนรหัสผ่านบัญชีที่สร้าง token นี้)' };
    }

    let finalToken = accessToken;
    let note = null;

    if (info.type === 'PAGE') {
      if (String(info.profile_id) !== String(pageId)) {
        return { ok: false, error: `Token นี้ใช้ได้ แต่เป็นของเพจอื่น (id: ${info.profile_id}) ไม่ตรงกับ Page ID ที่กรอกไว้ (${pageId})` };
      }
    } else if (info.type === 'USER') {
      // user token ล็อกอินส่วนตัว — ลองแลกเป็น page token ของเพจนี้โดยเฉพาะให้อัตโนมัติ
      const accUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(accessToken)}`;
      const ar = await fetchWithTimeout(accUrl, { method: 'GET' });
      const adata = await ar.json();
      if (adata.error) {
        return { ok: false, error: `นี่คือ token ของบัญชีผู้ใช้ ไม่ใช่ token ของเพจ และดึงรายชื่อเพจที่จัดการได้ไม่สำเร็จ: ${adata.error.message}` };
      }
      const match = (adata.data || []).find((p) => String(p.id) === String(pageId));
      if (!match || !match.access_token) {
        return {
          ok: false,
          error: `นี่คือ token ของบัญชีผู้ใช้ (ไม่ใช่ token ของเพจ) และบัญชีนี้ไม่มีสิทธิ์แอดมินเพจ ID ${pageId} — วิธีแก้: ใน Facebook ให้เลือก "page access token" ของเพจนี้โดยเฉพาะ หรือล็อกอินด้วยบัญชีที่เป็นแอดมินเพจนี้แล้วลองใหม่`,
        };
      }
      finalToken = match.access_token;
      note = 'วาง token ของบัญชีผู้ใช้มาแทน token ของเพจ — ระบบแลกเป็น page token ที่ถูกต้องให้อัตโนมัติแล้ว ไม่ต้องทำอะไรเพิ่ม';
    } else {
      return { ok: false, error: `Token ประเภท "${info.type || 'ไม่ทราบ'}" ใช้กับระบบนี้ไม่ได้ ต้องเป็น page access token เท่านั้น` };
    }

    // เช็คซ้ำอีกชั้นด้วย GET จริงแบบเดียวกับที่ api/reply.mjs ใช้ตอนตอบคอมเมนต์จริง (คำขอชนิดเดียวกัน
    // เป๊ะๆ) ให้มั่นใจว่า token สุดท้ายที่จะบันทึก (ไม่ว่าจะของเดิมหรือที่เพิ่งแลกมา) ใช้งานได้จริง
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=id,name&access_token=${encodeURIComponent(finalToken)}`;
    const r = await fetchWithTimeout(url, { method: 'GET' });
    const data = await r.json();
    if (data.error) {
      return { ok: false, error: data.error.message || 'Facebook ปฏิเสธ token นี้' };
    }
    if (String(data.id) !== String(pageId)) {
      return { ok: false, error: `Token นี้ใช้ได้ แต่เป็นของเพจอื่น (id: ${data.id}) ไม่ตรงกับ Page ID ที่กรอกไว้ (${pageId})` };
    }
    return { ok: true, name: data.name, fbId: data.id, finalToken, note };
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

// เช็คสถานะ token ของทุกเพจพร้อมกัน (ใช้ debug_token อย่างเดียว ไม่ยิง GET หน้าเพจซ้ำ เบากว่า
// testFacebookToken ทั้งก้อน) — ใช้โชว์ที่หน้า "จัดการเพจ" ให้เห็นล่วงหน้าว่าเพจไหน token ใกล้หมดอายุ/
// หมดอายุแล้ว/ใช้ไม่ได้แล้ว โดยไม่ต้องรอให้ตอบคอมเมนต์ไม่ออกก่อนถึงจะรู้ตัว (ตามที่ขอ)
async function checkAllTokenHealth() {
  const url = `${SUPABASE_URL}/rest/v1/pages?select=id,page_id,page_name,access_token&order=page_name.asc`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) throw new Error('โหลดรายชื่อเพจไม่สำเร็จ');
  const rows = await r.json();

  const results = await Promise.all(
    rows.map(async (row) => {
      const base = { id: row.id, pageId: row.page_id, pageName: row.page_name };
      if (!row.access_token) {
        return { ...base, status: 'no_token', message: 'ยังไม่มี Access Token' };
      }
      try {
        const debugUrl = `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(row.access_token)}&access_token=${encodeURIComponent(row.access_token)}`;
        const dr = await fetchWithTimeout(debugUrl, { method: 'GET' });
        const ddata = await dr.json();
        if (ddata.error) {
          return { ...base, status: 'invalid', message: ddata.error.message || 'Facebook ปฏิเสธ token นี้' };
        }
        const info = ddata.data || {};
        if (!info.is_valid) {
          return { ...base, status: 'invalid', message: 'Token ไม่ valid แล้ว (ถูกยกเลิก/รหัสผ่านบัญชีที่สร้างถูกเปลี่ยน/ถอนสิทธิ์แอป)' };
        }
        if (info.type !== 'PAGE' || String(info.profile_id) !== String(row.page_id)) {
          // ไม่ควรเกิดแล้วหลังมีระบบแลก token อัตโนมัติตอนบันทึก แต่เผื่อไว้ (เช่น ข้อมูลเก่าก่อนมีระบบนี้)
          return { ...base, status: 'invalid', message: 'Token ที่บันทึกไว้ไม่ใช่ page token ของเพจนี้ — ลองวาง token ใหม่แล้วบันทึกอีกครั้ง' };
        }
        // page access token ที่ได้จาก user token ที่ไม่มีวันหมดอายุ (long-lived) จะได้ expires_at: 0
        // แปลว่า "ไม่มีวันหมดอายุ" ตราบใดที่ยังเป็นแอดมินเพจและไม่ถอนสิทธิ์แอปออกเอง
        if (!info.expires_at) {
          return { ...base, status: 'ok', message: 'ใช้ได้ ไม่มีวันหมดอายุ (ตราบใดที่ยังเป็นแอดมินเพจ และไม่ถอนสิทธิ์แอปใน Facebook)', expiresAt: null };
        }
        const expiresAtMs = info.expires_at * 1000;
        const daysLeft = Math.floor((expiresAtMs - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft < 0) {
          return { ...base, status: 'expired', message: `Token หมดอายุไปแล้ว`, expiresAt: expiresAtMs };
        }
        if (daysLeft <= 7) {
          return { ...base, status: 'expiring', message: `Token จะหมดอายุในอีก ${daysLeft} วัน`, expiresAt: expiresAtMs };
        }
        return { ...base, status: 'ok', message: `ใช้ได้ (หมดอายุในอีก ${daysLeft} วัน)`, expiresAt: expiresAtMs };
      } catch (err) {
        const isTimeout = err && err.name === 'AbortError';
        return { ...base, status: 'unknown', message: isTimeout ? 'Facebook ไม่ตอบสนอง (หมดเวลา) ตอนเช็ค token' : `เช็คไม่สำเร็จ: ${err.message || err}` };
      }
    })
  );
  return results;
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

    if (action === 'token-health') {
      const health = await checkAllTokenHealth();
      return json({ ok: true, health });
    }

    if (action === 'test-token') {
      const { pageId, accessToken } = body || {};
      if (!pageId || !accessToken) return json({ error: 'pageId และ accessToken จำเป็นต้องมี' }, 400);
      const result = await testFacebookToken(pageId, accessToken);
      // ไม่ส่ง finalToken (ค่า token จริง) กลับไปฝั่ง client ตอน "ทดสอบ" เฉยๆ — ส่งแค่ชื่อเพจ/note
      // พอ (เก็บ token จริงไว้แค่ตอน action 'save' เท่านั้น ลดพื้นที่หลุดของค่า token)
      const { finalToken, ...safeResult } = result;
      return json(safeResult, result.ok ? 200 : 400);
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
      let fbNote = null;
      let resolvedToken = null;
      if (accessToken && String(accessToken).trim()) {
        const testResult = await testFacebookToken(pageId, accessToken);
        if (!testResult.ok) {
          return json({ error: `ตรวจสอบ Token ไม่ผ่าน: ${testResult.error}` }, 400);
        }
        fbCheckedName = testResult.name;
        fbNote = testResult.note;
        // ถ้าที่วางมาเป็น user token เผลอวางผิด testFacebookToken จะแลกเป็น page token ที่ถูกต้องให้
        // แล้ว (ดูคอมเมนต์ในฟังก์ชันนั้น) — เก็บตัวที่แลกแล้วลงฐานข้อมูลเสมอ ไม่ใช่ตัวที่วางมาดิบๆ
        resolvedToken = testResult.finalToken;
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
      if (resolvedToken) {
        fields.access_token = resolvedToken;
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
      // เดิม Prefer: return=representation ส่งทั้งแถว "รวม access_token/app_secret ตัวจริง" กลับไปฝั่ง
      // client ตรงๆ ทุกครั้งที่บันทึก (ถึงจะมีแค่ action 'list' ที่ตัดออกก่อนตามคอมเมนต์ด้านบน แต่
      // action 'save' หลุดไป) — ตัดออกให้เหมือนกันตรงนี้ด้วย กันค่า token จริงหลุดไปอยู่ใน network
      // response/console ฝั่งเบราว์เซอร์โดยไม่จำเป็น
      let safePage = null;
      if (rows[0]) {
        const { access_token, app_secret, ...rest } = rows[0];
        safePage = { ...rest, has_token: !!access_token, has_webhook: !!app_secret };
      }
      return json({ ok: true, page: safePage, fbCheckedName, fbNote });
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
