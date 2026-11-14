// แปลง Request/Response มาตรฐานเว็บ (Cloudflare Workers) ให้เรียกฟังก์ชันแบบ Node (req, res)
// ของ Vercel ได้ตรงๆ (api/webhook.js, api/push.js) โดยไม่ต้องแก้ไฟล์ต้นทาง — ใช้ได้ทั้งสองแพลตฟอร์ม
import { Buffer } from 'node:buffer';

export async function runNodeHandler(nodeHandler, request) {
  const url = new URL(request.url);
  const raw = request.method === 'GET' || request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let parsedBody;
  if ((headers['content-type'] || '').includes('application/json') && raw.length) {
    try { parsedBody = JSON.parse(raw.toString('utf-8')); } catch { parsedBody = undefined; }
  }
  const listeners = {};
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query: Object.fromEntries(url.searchParams),
    body: parsedBody,
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      if (event === 'end') {
        queueMicrotask(() => {
          if (raw.length) (listeners.data || []).forEach((f) => f(raw));
          (listeners.end || []).forEach((f) => f());
        });
      }
      return req;
    },
  };
  let status = 200;
  const outHeaders = new Headers();
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const res = {
    status(code) { status = code; return res; },
    setHeader(k, v) { outHeaders.set(k, String(v)); return res; },
    send(body) {
      if (body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) return res.json(body);
      if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'text/plain; charset=utf-8');
      resolveDone(new Response(body == null ? '' : body, { status, headers: outHeaders }));
      return res;
    },
    json(obj) {
      outHeaders.set('content-type', 'application/json; charset=utf-8');
      resolveDone(new Response(JSON.stringify(obj), { status, headers: outHeaders }));
      return res;
    },
    end(body) { return res.send(body); },
  };
  const ran = Promise.resolve(nodeHandler(req, res));
  const first = await Promise.race([done, ran.then(() => null)]);
  if (first) return first;
  // ฟังก์ชันจบแล้วแต่ยังไม่ได้ตอบผ่าน res — ให้โอกาสอีกนิด แล้วตอบว่างตามสถานะที่ตั้งไว้
  return Promise.race([done, new Promise((r) => setTimeout(() => r(new Response('', { status })), 0))]);
}
