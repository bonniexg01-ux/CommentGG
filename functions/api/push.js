// Cloudflare Pages Function → ใช้โค้ดเดียวกับ Vercel (api/push.js) ผ่านตัวแปลง req/res
import nodeHandler from '../../api/push.js';
import { runNodeHandler } from '../_node-adapter.js';
export const onRequest = (ctx) => runNodeHandler(nodeHandler, ctx.request);
