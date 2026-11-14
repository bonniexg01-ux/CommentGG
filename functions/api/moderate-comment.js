// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/moderate-comment.mjs)
import handler from '../../api/moderate-comment.mjs';
export const onRequest = (ctx) => handler(ctx.request);
