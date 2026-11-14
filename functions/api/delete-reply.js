// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/delete-reply.mjs)
import handler from '../../api/delete-reply.mjs';
export const onRequest = (ctx) => handler(ctx.request);
