// Service worker ของ CommentGG — มีไว้ให้ติดตั้งเป็นแอปบนมือถือ/คอมได้ (PWA) เท่านั้น
// จงใจ "ไม่แคช" อะไรเลย: ทุกคำขอวิ่งไปที่เครือข่ายตามปกติเหมือนเปิดเว็บธรรมดา หน้าเว็บจึงได้เวอร์ชันล่าสุด
// เสมอทันทีที่ deploy (ไม่มีปัญหาแอปค้างเวอร์ชันเก่า) — ขั้นถัดไปจะใช้ไฟล์นี้รับแจ้งเตือน (push) ตอนปิดแอป
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// แจ้งเตือน push จากเซิร์ฟเวอร์ (ประกาศสำคัญ) — เด้งได้แม้ปิดแอป/ปิดเว็บอยู่ ดู lib/push.cjs
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || '⚠️ ประกาศสำคัญ', {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || undefined,
    requireInteraction: true,
    data: { postId: data.postId || null },
  }));
});

// กดแจ้งเตือน (ที่เว็บสั่งแสดงผ่าน service worker) แล้วเปิด/สลับกลับมาที่แอป
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const postId = event.notification.data && event.notification.data.postId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if (postId) c.postMessage({ type: 'open-post', postId }); // ให้หน้าเว็บเปิดโพสต์นั้นเลย
        return;
      }
    }
    return self.clients.openWindow('/');
  })());
});
