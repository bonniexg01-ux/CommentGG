// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/reply.mjs)
import handler from '../../api/reply.mjs';
export const onRequest = (ctx) => handler(ctx.request);
