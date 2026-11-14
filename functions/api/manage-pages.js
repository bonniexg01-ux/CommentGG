// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/manage-pages.mjs)
import handler from '../../api/manage-pages.mjs';
export const onRequest = (ctx) => handler(ctx.request);
