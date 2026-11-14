// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/sync-posts.mjs)
import handler from '../../api/sync-posts.mjs';
export const onRequest = (ctx) => handler(ctx.request);
