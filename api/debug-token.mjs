// api/debug-token.mjs
// เครื่องมือ debug ชั่วคราว: เช็คว่า access_token ของแต่ละเพจที่เก็บไว้ใน Supabase ตอนนี้
// มีสิทธิ์ (scopes) อะไรบ้างจริงๆ ผ่าน Facebook Graph API /debug_token
// ใช้หาคำตอบว่าทำไมชื่อคนคอมเมนต์ถึงอ่านไม่ได้ (from.name เป็น null) — เช็คให้ชัดแทนการเดา

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
  if (!SERVICE_KEY) return json({ error: 'missing SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/pages?select=id,page_name,access_token`, { headers: sbHeaders });
  const pages = await r.json();

  const results = [];
  for (const p of pages) {
    if (!p.access_token) {
      results.push({ page: p.page_name, error: 'no access_token stored' });
      continue;
    }
    try {
      const dbgUrl = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(p.access_token)}&access_token=${encodeURIComponent(p.access_token)}`;
      const dr = await fetch(dbgUrl);
      const dj = await dr.json();
      results.push({ page: p.page_name, debug: dj.data || dj });
    } catch (e) {
      results.push({ page: p.page_name, error: String(e) });
    }
  }

  return json({ results });
}
