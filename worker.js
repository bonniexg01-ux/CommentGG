// worker.js — ทางเข้าของ Cloudflare Workers (ใช้แทน Vercel): /api/* เรียกโค้ดเดิมใน api/ ส่วนอื่นเสิร์ฟไฟล์เว็บ
// (ไฟล์เว็บ static ฟรีไม่จำกัด ไม่นับโควตา — นับเฉพาะ /api/* ที่ 100,000 ครั้ง/วันของแผนฟรี)
// เพิ่ม endpoint ใหม่ใน api/ แล้วต้องมาเพิ่มในรายการด้านล่างด้วย
import { runNodeHandler } from './lib/node-adapter.mjs';
import h_webhook from './api/webhook.js';
import h_push from './api/push.js';
import h_delete_reply from './api/delete-reply.mjs';
import h_edit_reply from './api/edit-reply.mjs';
import h_manage_pages from './api/manage-pages.mjs';
import h_manage_team from './api/manage-team.mjs';
import h_moderate_comment from './api/moderate-comment.mjs';
import h_post_detail from './api/post-detail.mjs';
import h_reply from './api/reply.mjs';
import h_sync_comments from './api/sync-comments.mjs';
import h_sync_posts from './api/sync-posts.mjs';
import h_translate from './api/translate.mjs';

const EDGE = {
  'delete-reply': h_delete_reply,
  'edit-reply': h_edit_reply,
  'manage-pages': h_manage_pages,
  'manage-team': h_manage_team,
  'moderate-comment': h_moderate_comment,
  'post-detail': h_post_detail,
  'reply': h_reply,
  'sync-comments': h_sync_comments,
  'sync-posts': h_sync_posts,
  'translate': h_translate,
};
const NODE = { webhook: h_webhook, push: h_push };

export default {
  async fetch(request, env) {
    const m = new URL(request.url).pathname.match(/^\/api\/([a-z-]+)\/?$/);
    if (m) {
      try {
        if (EDGE[m[1]]) return await EDGE[m[1]](request);
        if (NODE[m[1]]) return await runNodeHandler(NODE[m[1]], request);
      } catch (err) {
        console.error('worker error', m[1], err);
        return new Response(JSON.stringify({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
