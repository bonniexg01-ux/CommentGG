// lib/push.cjs — ส่งแจ้งเตือน push ไปมือถือ/คอมของทีม เมื่อเพจโพสต์ "ประกาศสำคัญ" (ปิดเซิร์ฟ/ปิดปรับปรุง ฯลฯ)
// ใช้ร่วมกันจาก api/webhook.js (เพจโพสต์ปุ๊บ Facebook ยิง webhook มา — ทำงานได้แม้ไม่มีใครเปิดเว็บ) และ
// api/push.mjs (ตอน sync-posts ฝั่งหน้าเว็บเจอโพสต์ใหม่ — สำรองกรณี webhook ไม่ส่งมา)
//
// ส่งซ้ำไม่ได้: "จอง" โพสต์ก่อนด้วย page_posts.push_sent_at (อัปเดตเฉพาะแถวที่ยังเป็น null) ใครจองได้ก่อนคนนั้นส่ง
// ส่งเฉพาะคนที่มีสิทธิ์เห็นเพจนั้น และไม่ได้ซ่อนเพจนั้นไว้ใน "⚙️ เลือกเพจ"
const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' });

// ต้องตรงกับ IMPORTANT_POST_RE ใน index.html
const IMPORTANT_POST_RE = /(ปิดเซิร์ฟ|ปิดเซิฟ|ปิดเซริฟ|ปิดให้บริการ|ยุติการให้บริการ|ยุติให้บริการ|ปิดปรับปรุง|ปิดระบบ|ปิดเกม|ปิดตัว|server\s*close|shut\s*down|maintenance|เซิร์ฟเวอร์มีปัญหา|เซิฟล่ม|เซิร์ฟล่ม)/i;
function isImportantAnnouncement(message) {
  return IMPORTANT_POST_RE.test(message || '');
}

let vapidReady = null;
async function ensureVapid() {
  if (vapidReady) return vapidReady;
  vapidReady = (async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_secrets?key=in.(vapid_public_key,vapid_private_key,vapid_subject)&select=key,value`, { headers: sbHeaders() });
    if (!r.ok) throw new Error('โหลด VAPID keys ไม่สำเร็จ');
    const kv = Object.fromEntries((await r.json()).map((row) => [row.key, row.value]));
    webpush.setVapidDetails(kv.vapid_subject, kv.vapid_public_key, kv.vapid_private_key);
    return true;
  })();
  vapidReady.catch(() => { vapidReady = null; });
  return vapidReady;
}

// รายชื่อ user_id ที่ควรได้แจ้งเตือนของเพจนี้
async function eligibleUserIds(pageUuid) {
  const usersR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: sbHeaders() });
  if (!usersR.ok) throw new Error('โหลดรายชื่อผู้ใช้ไม่สำเร็จ');
  const data = await usersR.json();
  const users = Array.isArray(data) ? data : data.users || [];
  const accessR = await fetch(`${SUPABASE_URL}/rest/v1/user_page_access?page_id=eq.${encodeURIComponent(pageUuid)}&select=user_id`, { headers: sbHeaders() });
  const withAccess = new Set((accessR.ok ? await accessR.json() : []).map((r) => r.user_id));
  return users
    .filter((u) => {
      const meta = u.app_metadata || {};
      const um = u.user_metadata || {};
      const canSee = meta.can_see_all_pages || withAccess.has(u.id);
      const hidden = Array.isArray(um.hidden_page_ids) && um.hidden_page_ids.includes(pageUuid);
      return canSee && !hidden;
    })
    .map((u) => u.id);
}

// ส่งแจ้งเตือนของโพสต์นี้ (row จากตาราง page_posts) ถ้าเป็นประกาศสำคัญและยังไม่เคยส่ง — คืนจำนวนอุปกรณ์ที่ส่งสำเร็จ
// force=true ใช้ตอนทดสอบเท่านั้น (ข้ามการเช็คคำสำคัญ/การจอง)
async function notifyImportantPost(post, { force = false, onlyUserId = null, titleOverride = null } = {}) {
  if (!post) return { sent: 0, reason: 'no-post' };
  if (!force && !isImportantAnnouncement(post.message)) return { sent: 0, reason: 'not-important' };

  if (!force) {
    // จองโพสต์นี้ — ถ้ามีอีกเส้นทางส่งไปแล้ว (push_sent_at ไม่ null) จะได้ [] กลับมา แล้วจบเลย
    const claimR = await fetch(`${SUPABASE_URL}/rest/v1/page_posts?id=eq.${encodeURIComponent(post.id)}&push_sent_at=is.null`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ push_sent_at: new Date().toISOString() }),
    });
    const claimed = claimR.ok ? await claimR.json() : [];
    if (!claimed.length) return { sent: 0, reason: 'already-sent' };
  }

  await ensureVapid();
  const pageR = await fetch(`${SUPABASE_URL}/rest/v1/pages?id=eq.${encodeURIComponent(post.page_id)}&select=page_name,logo_url`, { headers: sbHeaders() });
  const page = (pageR.ok ? await pageR.json() : [])[0] || {};

  const userIds = onlyUserId ? [onlyUserId] : await eligibleUserIds(post.page_id);
  if (!userIds.length) return { sent: 0, reason: 'no-users' };
  const subsR = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=in.(${userIds.join(',')})&select=id,endpoint,p256dh,auth`, { headers: sbHeaders() });
  const subs = subsR.ok ? await subsR.json() : [];

  const payload = JSON.stringify({
    title: titleOverride || `⚠️ ประกาศสำคัญ — ${page.page_name || 'เพจ'}`,
    body: (post.message || '').slice(0, 180),
    icon: page.logo_url || '/icons/icon-192.png',
    tag: 'page-post-' + post.id,
    postId: post.id,
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600, urgency: 'high' });
      sent += 1;
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${s.id}`, {
        method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify({ last_success_at: new Date().toISOString() }),
      }).catch(() => {});
    } catch (err) {
      // 404/410 = อุปกรณ์นี้ยกเลิกการรับแจ้งเตือนแล้ว (ลบแอป/ล้างเบราว์เซอร์) ลบทิ้งไปเลย
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${s.id}`, { method: 'DELETE', headers: sbHeaders() }).catch(() => {});
      } else {
        console.error('push error: ส่งไม่สำเร็จ', err && err.statusCode, err && err.body);
      }
    }
  }));
  return { sent, devices: subs.length };
}

module.exports = { notifyImportantPost, isImportantAnnouncement, ensureVapid };
