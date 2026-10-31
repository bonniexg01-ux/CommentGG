// api/push.js — ลงทะเบียนอุปกรณ์รับแจ้งเตือน push (มือถือ/คอม) + สั่งส่งแจ้งเตือนประกาศสำคัญ
// actions (ทุกอันต้องล็อกอิน):
//   subscribe    — บันทึก PushSubscription ของอุปกรณ์นี้ผูกกับบัญชีที่ล็อกอิน
//   unsubscribe  — ลบอุปกรณ์นี้ออก
//   notify-posts — ให้ api/sync-posts.mjs (edge) เรียกต่อเมื่อเจอโพสต์ใหม่ ส่งเฉพาะที่เป็นประกาศสำคัญและยังไม่เคยส่ง
//   test         — ส่งแจ้งเตือนทดสอบไปทุกอุปกรณ์ของบัญชีตัวเองเท่านั้น
const { notifyImportantPost } = require('../lib/push.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

async function requireAuth(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const user = await requireAuth(req);
  if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' });

  const body = req.body || {};
  try {
    if (body.action === 'subscribe') {
      const sub = body.subscription || {};
      const keys = sub.keys || {};
      if (!sub.endpoint || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'ข้อมูลการลงทะเบียนไม่ครบ' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: user.id, endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) }),
      });
      if (!r.ok) {
        console.error('push error: subscribe', r.status, await r.text().catch(() => ''));
        return res.status(500).json({ error: 'ลงทะเบียนรับแจ้งเตือนไม่สำเร็จ' });
      }
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'unsubscribe') {
      if (!body.endpoint) return res.status(400).json({ error: 'ไม่มี endpoint' });
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint)}&user_id=eq.${user.id}`, { method: 'DELETE', headers: sbHeaders });
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'notify-posts') {
      const ids = Array.isArray(body.fbPostIds) ? body.fbPostIds.filter(Boolean).slice(0, 100) : [];
      if (!ids.length) return res.status(200).json({ ok: true, sent: 0 });
      const list = ids.map((x) => `"${String(x).replace(/"/g, '')}"`).join(',');
      const r = await fetch(`${SUPABASE_URL}/rest/v1/page_posts?fb_post_id=in.(${list})&push_sent_at=is.null&select=id,page_id,message`, { headers: sbHeaders });
      const posts = r.ok ? await r.json() : [];
      let sent = 0;
      for (const p of posts) sent += (await notifyImportantPost(p)).sent || 0;
      return res.status(200).json({ ok: true, sent });
    }

    if (body.action === 'test') {
      const result = await notifyImportantPost(
        { id: 'test-' + Date.now(), page_id: null, message: 'ถ้าเห็นข้อความนี้ แปลว่าอุปกรณ์นี้จะได้รับแจ้งเตือนประกาศสำคัญแม้ปิดแอปอยู่' },
        { force: true, onlyUserId: user.id, titleOverride: '🔔 ทดสอบแจ้งเตือน CommentGG' }
      );
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(400).json({ error: `ไม่รู้จัก action: ${body.action}` });
  } catch (err) {
    console.error('push error', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
};
