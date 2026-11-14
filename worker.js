// worker.js — ทางเข้าของ Cloudflare Workers (ใช้แทน Vercel): /api/* เรียกโค้ดเดิมใน api/ ส่วนอื่นเสิร์ฟไฟล์เว็บ
// (ไฟล์เว็บ static ฟรีไม่จำกัด ไม่นับโควตา — นับเฉพาะ /api/* ที่ 100,000 ครั้ง/วันของแผนฟรี)
// เพิ่ม endpoint ใหม่ใน api/ แล้วต้องมาเพิ่มในรายการด้านล่างด้วย
//
// ไฟล์ใน api/ อ่าน process.env.* ตั้งแต่ตอนโหลดไฟล์ — เลยต้องคัดลอกค่าลับจาก env ของ Cloudflare เข้า
// process.env ก่อน แล้วค่อย import แบบ lazy (import ตอนมี request แรก) ไม่งั้นจะอ่านได้ค่าว่าง
import { runNodeHandler } from './lib/node-adapter.mjs';

const EDGE = {
  'delete-reply': () => import('./api/delete-reply.mjs'),
  'edit-reply': () => import('./api/edit-reply.mjs'),
  'manage-pages': () => import('./api/manage-pages.mjs'),
  'manage-team': () => import('./api/manage-team.mjs'),
  'moderate-comment': () => import('./api/moderate-comment.mjs'),
  'post-detail': () => import('./api/post-detail.mjs'),
  'reply': () => import('./api/reply.mjs'),
  'sync-comments': () => import('./api/sync-comments.mjs'),
  'sync-posts': () => import('./api/sync-posts.mjs'),
  'translate': () => import('./api/translate.mjs'),
};
const NODE = {
  webhook: () => import('./api/webhook.js'),
  push: () => import('./api/push.js'),
};

function syncEnv(env) {
  globalThis.process = globalThis.process || { env: {} };
  globalThis.process.env = globalThis.process.env || {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string') globalThis.process.env[k] = v;
  }
}

export default {
  async fetch(request, env) {
    const m = new URL(request.url).pathname.match(/^\/api\/([a-z-]+)\/?$/);
    if (m && m[1] === 'health') {
      // ตรวจสุขภาพ: บอกแค่ "มี/ไม่มี" ค่าลับแต่ละตัว (ไม่เปิดเผยค่า)
      const has = (k) => typeof (env || {})[k] === 'string' && env[k].length > 0;
      return new Response(JSON.stringify({ ok: true, build: '2026-11-14b', envKeys: Object.keys(env || {}), serviceKey: has('SUPABASE_SERVICE_ROLE_KEY') }), { headers: { 'content-type': 'application/json' } });
    }
    if (m) {
      try {
        syncEnv(env);
        if (EDGE[m[1]]) {
          const mod = await EDGE[m[1]]();
          return await mod.default(request);
        }
        if (NODE[m[1]]) {
          const mod = await NODE[m[1]]();
          return await runNodeHandler(mod.default || mod, request);
        }
      } catch (err) {
        console.error('worker error', m[1], err);
        return new Response(JSON.stringify({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
