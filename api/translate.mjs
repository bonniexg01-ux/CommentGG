// api/translate.mjs
// แปลภาษาให้ 2 ทาง: (1) แปลคอมเมนต์ที่เข้ามาเป็นภาษาอื่น (เช่น เพจ PH/ID/SEA) ให้เป็นไทยเพื่ออ่านเข้าใจ
// และ (2) แปลข้อความที่แอดมินพิมพ์ตอบเป็นไทย ให้เป็นภาษาของเพจนั้นๆ ก่อนส่งจริง
//
// ใช้บริการแปลแบบไม่มีค่าใช้จ่าย (endpoint เดียวกับที่ปลั๊กอินแปลภาษาฟรีหลายตัวใช้กัน) แทนการสมัคร
// Google Cloud Translation API ตัวเป็นทางการ (มีค่าใช้จ่ายต่อตัวอักษร + ต้องตั้งบัตรเครดิต/billing
// account) ตามที่ขอว่าอยากได้แบบไม่เสียตังก่อน — ถ้าปริมาณการแปลเยอะขึ้นมากในอนาคตจนบริการฟรีนี้เริ่ม
// ช้า/error บ่อย ค่อยพิจารณาย้ายไปใช้ตัวเป็นทางการทีหลังได้ (โครงสร้างโค้ดนี้ออกแบบให้สลับผู้ให้บริการ
// แปลได้ง่าย เพราะกันไว้เป็นฟังก์ชันแยกต่างหาก translateViaFree() จุดเดียว)
//
// รันบน Edge Runtime เหมือน endpoint อื่นๆ ในระบบ — ต้องล็อกอินก่อนถึงจะเรียกได้ (เช็คผ่าน Supabase Auth
// เหมือน reply.mjs/manage-pages.mjs) แต่ไม่ได้จำกัดสิทธิ์พิเศษเพิ่มเติม เพราะเป็นฟีเจอร์ที่ทีมทุกคน
// ที่ตอบคอมเมนต์อยู่แล้วควรใช้ได้ ไม่ใช่สิทธิ์ระดับแอดมิน

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const TRANSLATE_TIMEOUT_MS = 10000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchWithTimeout(url, options, timeoutMs = TRANSLATE_TIMEOUT_MS) {
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

// เรียกบริการแปลฟรีตัวหลัก (endpoint สาธารณะที่ไม่ต้องใช้ API key, คุณภาพดี) — รูปแบบผลลัพธ์เป็น nested
// array แปลกๆ ตามธรรมชาติของ endpoint นี้ (ไม่ใช่ REST ปกติ) ต้องแกะเอาประโยคที่แปลแล้วมาต่อกันเอง
// เพราะข้อความยาวอาจถูกตัดเป็นหลายท่อนกลับมา
//
// เจอจริง: endpoint นี้บางครั้งตอบ HTTP 429 (Too Many Requests) กับทราฟฟิกที่มาจาก IP ของผู้ให้บริการ
// คลาวด์ (เช่น Vercel Edge) เพราะเป็น endpoint ไม่เป็นทางการที่ไม่ได้ออกแบบมาให้ยิงจากเซิร์ฟเวอร์จำนวน
// มากพร้อมกัน — ไม่ได้เกิดจากเรายิงถี่เกินไปเอง แก้ด้วยการมีบริการสำรอง (translateViaMyMemory) ไว้สลับ
// ใช้อัตโนมัติทันทีถ้าตัวหลักล้ม ไม่ต้องรอให้ผู้ใช้กดลองใหม่เอง
async function translateViaGoogleFree(text, target, source) {
  // ส่งข้อความใน body (POST) ไม่ใส่ใน URL — ภาษาไทย 1 ตัวเข้ารหัสใน URL ได้ 9 ไบต์ ข้อความยาวๆ (ใกล้ 4000 ตัว)
  // ทำให้ URL ยาวเกินที่ Google รับ แปลไม่ได้ (ทดสอบแล้ว: GET พัง, POST ผ่าน)
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(source || 'auto')}&tl=${encodeURIComponent(target)}&dt=t`;
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q: text }),
  });
  if (!r.ok) throw new Error(`บริการแปลหลักตอบกลับผิดพลาด (HTTP ${r.status})`);
  const data = await r.json();
  // data[0] = array ของ [แปลแล้ว, ต้นฉบับ, ...] ต่อ 1 ท่อน, data[2] = ภาษาต้นฉบับที่ตรวจพบ
  const chunks = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = chunks.map((c) => (Array.isArray(c) ? c[0] : '')).join('');
  const detectedSource = typeof data?.[2] === 'string' ? data[2] : (source || 'auto');
  if (!translated) throw new Error('บริการแปลหลักไม่คืนข้อความแปลมา');
  return { translated, detectedSource };
}

// บริการแปลฟรีสำรอง (MyMemory) — โควต้าฟรีพอสมควรต่อวันและออกแบบมาให้เรียกผ่านโปรแกรม/เซิร์ฟเวอร์ได้
// โดยตรงอยู่แล้ว (ไม่ค่อยบล็อก IP คลาวด์เหมือนตัวหลัก) ใช้เป็นตัวสำรองตอนตัวหลักล่ม/โดนจำกัด
async function translateViaMyMemory(text, target, source) {
  const langpair = `${source && source !== 'auto' ? source : 'autodetect'}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' });
  if (!r.ok) throw new Error(`บริการแปลสำรองตอบกลับผิดพลาด (HTTP ${r.status})`);
  const data = await r.json();
  const translated = data?.responseData?.translatedText;
  if (!translated) throw new Error('บริการแปลสำรองไม่คืนข้อความแปลมา');
  return { translated, detectedSource: source || 'auto' };
}

// ลองตัวหลักก่อนเสมอ (คุณภาพดีกว่า) ล้มแล้วค่อยสลับไปตัวสำรองอัตโนมัติ — คืน error จากตัวหลักถ้าตัวสำรอง
// ก็ล้มด้วย (ข้อความ error จะได้สื่อถึงปัญหาจริงมากกว่า)
async function translateText(text, target, source) {
  try {
    return await translateViaGoogleFree(text, target, source);
  } catch (primaryErr) {
    try {
      return await translateViaMyMemory(text, target, source);
    } catch {
      throw primaryErr;
    }
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await requireAuth(request);
  if (!user) return json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'รูปแบบคำขอไม่ถูกต้อง' }, 400);
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const target = typeof body?.target === 'string' ? body.target.trim() : '';
  const source = typeof body?.source === 'string' ? body.source.trim() : 'auto';

  if (!text) return json({ error: 'ไม่มีข้อความให้แปล' }, 400);
  if (!target) return json({ error: 'ไม่ได้ระบุภาษาปลายทาง' }, 400);
  if (text.length > 4000) return json({ error: 'ข้อความยาวเกินไป (จำกัด 4000 ตัวอักษรต่อครั้ง)' }, 400);

  try {
    const result = await translateText(text, target, source);
    return json({ ok: true, translated: result.translated, detectedSource: result.detectedSource });
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    console.error('translate error:', err);
    return json({ error: isTimeout ? 'บริการแปลไม่ตอบสนอง (หมดเวลา) ลองใหม่อีกครั้ง' : (err.message || 'แปลไม่สำเร็จ ลองใหม่อีกครั้ง') }, 500);
  }
}
