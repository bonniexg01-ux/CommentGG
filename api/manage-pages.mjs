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
  const url = `${SUPABASE_URL}/rest/v1/pages?select=id,page_id,page_name,game_name,color_hex,emoji,tag,pronoun,ending,hashtag,is_active,needs_polling,created_at,access_token&order=page_name.asc`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) throw new Error('โหลดรายชื่อเพจไม่สำเร็จ');
  const rows = await r.json();
  // ตัด access_token ตัวจริงทิ้งก่อนส่งกลับไปฝั่ง client เสมอ เหลือไว้แค่ boolean ว่ามีหรือยัง
  return rows.map((row) => {
    const { access_token, ...rest } = row;
    return { ...rest, has_token: !!access_token };
  });
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

    return json({ error: `ไม่รู้จัก action: ${action}` }, 400);
  } catch (err) {
    console.error('manage-pages error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}
