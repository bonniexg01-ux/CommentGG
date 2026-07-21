// api/webhook.js
// Meta (Facebook) Webhook handler — GET verification handshake + POST event ingest.
// Adapted from backend/src/routes/webhook.ts for a single-file Vercel serverless function.
// Writes new comments/messages directly into Supabase `feed_items`.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN; // optional for now
const APP_SECRET = process.env.META_APP_SECRET; // optional for now

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return handleVerify(req, res);
  }
  if (req.method === 'POST') {
    return handleEvent(req, res);
  }
  res.status(405).send('Method Not Allowed');
};

// GET /api/webhook — Meta ยิงมาครั้งเดียวตอนตั้งค่า Webhook เพื่อยืนยันความเป็นเจ้าของ endpoint
function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && (!VERIFY_TOKEN || token === VERIFY_TOKEN)) {
    return res.status(200).send(challenge || '');
  }
  return res.status(403).send('Forbidden');
}

// POST /api/webhook — event จริงจาก Meta (คอมเมนต์ใหม่ / ข้อความ Inbox ใหม่)
async function handleEvent(req, res) {
  try {
    const rawBody = await readRawBody(req);

    if (APP_SECRET) {
      const isValid = verifySignature(req, rawBody, APP_SECRET);
      if (!isValid) {
        return res.status(401).send('Invalid signature');
      }
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return res.status(400).send('Bad Request');
    }

    if (body.object !== 'page') {
      return res.status(200).send('EVENT_RECEIVED');
    }

    for (const entry of body.entry || []) {
      const fbPageId = String(entry.id);
      const pageUuid = await lookupPageUuid(fbPageId);
      if (!pageUuid) continue; // เพจนี้ยังไม่ได้ลงทะเบียนในระบบ

      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'feed' && change.value && change.value.item === 'comment') {
            await insertComment(pageUuid, change.value);
          }
        }
      }
      if (entry.messaging) {
        for (const messagingEvent of entry.messaging) {
          if (!messagingEvent.message || messagingEvent.message.is_echo) continue;
          await insertMessage(pageUuid, messagingEvent);
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('webhook error', err);
    // ตอบ 200 เสมอกัน Meta retry ถี่ๆ แม้ฝั่งเราจะ error ระหว่างประมวลผล
    return res.status(200).send('EVENT_RECEIVED');
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(req, rawBody, appSecret) {
  const signatureHeader = req.headers['x-hub-signature-256'];
  if (!signatureHeader) return false;
  const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expectedSignature = `sha256=${expectedHash}`;
  const sigBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

async function lookupPageUuid(fbPageId) {
  const url = `${SUPABASE_URL}/rest/v1/pages_public?page_id=eq.${encodeURIComponent(fbPageId)}&select=id`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] ? rows[0].id : null;
}

async function insertComment(pageUuid, value) {
  const record = {
    page_id: pageUuid,
    type: 'comment',
    fb_id: `${value.post_id}_${value.comment_id}`,
    fb_post_id: value.post_id,
    author_fb_id: value.from && value.from.id,
    author_name: value.from && value.from.name,
    message: value.message,
    status: 'pending',
    folder: 'inbox',
  };
  await insertFeedItem(record);
}

async function insertMessage(pageUuid, event) {
  const record = {
    page_id: pageUuid,
    type: 'message',
    fb_id: event.message.mid,
    author_fb_id: event.sender && event.sender.id,
    message: event.message.text,
    status: 'pending',
    folder: 'inbox',
  };
  await insertFeedItem(record);
}

async function insertFeedItem(record) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?on_conflict=fb_id`;
  await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(record),
  });
}
