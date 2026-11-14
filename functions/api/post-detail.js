// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/post-detail.mjs)
import handler from '../../api/post-detail.mjs';
export const onRequest = (ctx) => handler(ctx.request);
