// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/translate.mjs)
import handler from '../../api/translate.mjs';
export const onRequest = (ctx) => handler(ctx.request);
