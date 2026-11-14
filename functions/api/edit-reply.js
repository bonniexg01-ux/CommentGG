// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/edit-reply.mjs)
import handler from '../../api/edit-reply.mjs';
export const onRequest = (ctx) => handler(ctx.request);
