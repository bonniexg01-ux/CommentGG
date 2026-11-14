// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/webhook.js) ผ่านตัวแปลง req/res
import nodeHandler from '../../api/webhook.js';
import { runNodeHandler } from '../_node-adapter.js';
export const onRequest = (ctx) => runNodeHandler(nodeHandler, ctx.request);
