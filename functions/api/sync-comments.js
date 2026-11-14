// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/sync-comments.mjs)
import handler from '../../api/sync-comments.mjs';
export const onRequest = (ctx) => handler(ctx.request);
