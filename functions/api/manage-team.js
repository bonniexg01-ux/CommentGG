// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/manage-team.mjs)
import handler from '../../api/manage-team.mjs';
export const onRequest = (ctx) => handler(ctx.request);
