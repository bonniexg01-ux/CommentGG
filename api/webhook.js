// api/webhook.js
// Meta (Facebook) Webhook handler — GET verification handshake + POST event ingest.
// Adapted from backend/src/routes/webhook.ts for a single-file Vercel serverless function.
// Writes new comments/messages directly into Supabase `feed_items`.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
// เดิมไฟล์นี้ใช้ anon/publishable key อ่าน/เขียน Supabase — ตอนเพิ่มระบบ login เข้ามาทีหลัง เรา
// ล็อก RLS ของ feed_items และ pages_public ให้เหลือแค่ role "authenticated" เท่านั้น (REVOKE
// สิทธิ์ anon ออกไปหมด กันไม่ให้ใครก็ตามที่ไม่ได้ล็อกอินมาอ่าน/เขียนข้อมูลได้ตรงๆ)
//
// แต่ webhook นี้ไม่มี user session เลย (Meta ยิงมาเรียกเราตรงๆ ไม่ผ่านการล็อกอิน) พอ anon
// หมดสิทธิ์ webhook เลยอ่าน/เขียนไม่ได้ไปด้วย ทำให้คอมเมนต์ใหม่จากเพจไม่เคยถูกบันทึกลง
// feed_items เลยตั้งแต่ล็อก RLS (แต่ตัว handler ไม่เคยเช็ค response ของ Supabase เลย เลยยัง
// ตอบ 200 กลับ Meta เหมือนสำเร็จ ทำให้เงียบไม่มีใครรู้ว่าคอมเมนต์หายไปไหนหมด)
//
// แก้โดยให้ webhook ใช้ service role key แทน (ข้าม RLS ได้ทั้งหมด) เหมาะสมเพราะ endpoint นี้
// ตรวจลายเซ็นของ Meta ก่อนแล้ว (verifySignature) เป็นฝั่งเซิร์ฟเวอร์ที่เชื่อถือได้อยู่แล้ว
// เหมือน api/reply.mjs และไฟล์อื่นๆ ที่ใช้ service key เช่นกัน
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN; // optional for now
const APP_SECRET = process.env.META_APP_SECRET; // optional for now

// แอปเดิม (CB-CMT) โดน Facebook ตัด API เพราะยังไม่ได้ทำ Data Use Checkup ประจำปี (แสดง error
// "API access disrupted... complete Data Use Checkup") — ระหว่างรอแก้ ทีมงานตั้งแอปสำรอง "CB-CMT
// API Connector V.2" ขึ้นมาแทนชั่วคราว อย่างน้อยเพจ Cabal: Ultimate Combo (2026-09-08) เพื่อให้
// คอมเมนต์เพจนี้ยังไหลเข้าได้ระหว่างรอแอปเดิมกลับมาใช้ได้ปกติ — เก็บ verify token/app secret ของ
// แอปสำรองไว้เป็นค่าที่สองในโค้ดนี้เลย (ไม่ผ่าน env var เพราะ endpoint เดียวรับ webhook จากได้
// มากกว่า 1 แอปพร้อมกัน ต้องเช็คได้ทั้งคู่ ไม่ใช่แค่ค่าเดียวจาก env) พอแอปเดิมกลับมาใช้ได้แล้วค่อย
// ลบสองบรรทัดนี้ทิ้งได้
const BACKUP_APP_VERIFY_TOKEN = 'commentgg_cbcmt_v2_9f21ac';
const BACKUP_APP_SECRET = '72e3883e813941fdc7990871124c1ff1';

// verify token ที่ปุ่ม "ผูก Webhook" self-service (api/manage-pages.mjs) ใช้ตอนยิง
// POST /{app-id}/subscriptions ให้แอปไหนก็ตามที่แอดมินผูกเอง — ต้องรับ token นี้ด้วยเสมอ
// ไม่งั้น Facebook จะ handshake ไม่ผ่าน (403) ทุกครั้งที่มีคนกดปุ่มผูก Webhook เพจใหม่
const SELF_SERVICE_VERIFY_TOKEN = 'commentgg_self_service_webhook_v1';

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

const GRAPH_VERSION = 'v23.0';

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

  const tokenOk = !VERIFY_TOKEN || token === VERIFY_TOKEN || token === BACKUP_APP_VERIFY_TOKEN || token === SELF_SERVICE_VERIFY_TOKEN;
  if (mode === 'subscribe' && tokenOk) {
    return res.status(200).send(challenge || '');
  }
  return res.status(403).send('Forbidden');
}

// POST /api/webhook — event จริงจาก Meta (คอมเมนต์ใหม่ / ข้อความ Inbox ใหม่)
async function handleEvent(req, res) {
  try {
    const rawBody = await readRawBody(req);

    // ต้องรู้ก่อนว่า event นี้พูดถึงเพจไหนบ้าง ถึงจะไปหา app_secret เฉพาะของเพจนั้นมาเช็คลายเซ็นได้
    // (ระบบ "ผูก Webhook" self-service ทำให้แต่ละเพจผูกกับแอป Facebook คนละตัวกันได้) — parse body
    // ก่อนตรวจลายเซ็น แต่ยังไม่เชื่อเนื้อหาอะไรในนั้นจนกว่าจะเช็คลายเซ็นผ่านจริง
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return res.status(400).send('Bad Request');
    }

    if (body.object !== 'page') {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const fbPageIds = (body.entry || []).map((e) => String(e.id));
    const pagesInfo = await fetchPagesByFbIds(fbPageIds);

    // เช็คลายเซ็นกับ secret ทุกตัวที่เป็นไปได้: แอปเดิม (env) + แอปสำรอง V.2 (hardcode) + app_secret
    // เฉพาะของแต่ละเพจที่ผูก Webhook ไว้เอง (คอลัมน์ pages.app_secret) — ผ่านแค่ตัวใดตัวหนึ่งก็พอ
    const pageSecrets = pagesInfo.map((p) => p.app_secret).filter(Boolean);
    const candidateSecrets = [APP_SECRET, BACKUP_APP_SECRET, ...pageSecrets].filter(Boolean);
    if (candidateSecrets.length) {
      const validAny = candidateSecrets.some((secret) => verifySignature(req, rawBody, secret));
      if (!validAny) {
        return res.status(401).send('Invalid signature');
      }
    }

    const pageUuidByFbId = {};
    for (const p of pagesInfo) pageUuidByFbId[String(p.page_id)] = p.id;

    for (const entry of body.entry || []) {
      const fbPageId = String(entry.id);
      const pageUuid = pageUuidByFbId[fbPageId];
      if (!pageUuid) continue; // เพจนี้ยังไม่ได้ลงทะเบียนในระบบ

      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'feed' && change.value && change.value.item === 'comment') {
            // ลูกค้าลบคอมเมนต์ตัวเองทิ้ง (หรือคอมเมนต์ถูกลบจาก Facebook ไม่ว่าด้วยเหตุผลอะไรก็ตาม)
            // Meta ส่ง event เดิมกลับมาอีกรอบแต่ verb เป็น "remove" — ให้ลบรายการที่ตรงกันออกจาก
            // feed_items ไปด้วยเลย กันไม่ให้ค้างเป็นคอมเมนต์ "ต้องตอบกลับ" ทั้งที่ลูกค้าลบไปแล้วจริง
            if (change.value.verb === 'remove') {
              await deleteComment(change.value);
              continue;
            }
            // เพจตัวเองเป็นคนคอมเมนต์ — มี 2 กรณี: (1) echo ของคำตอบที่เราเพิ่งส่งไปเองผ่านปุ่มตอบ
            // ในเว็บนี้ (ต้องข้าม ไม่งั้นจะเก็บเป็นรายการ "ต้องตอบกลับ" ซ้ำไปเรื่อยๆ ไม่รู้จบ) หรือ
            // (2) มีคนตอบคอมเมนต์นั้นผ่านเครื่องมืออื่น (เช่นบอท AI อีกตัวที่ทีมใช้คู่กัน) ตรงที่
            // หน้าเพจ Facebook เลย ไม่ผ่านเว็บเรา — กรณีนี้อยากให้คอมเมนต์ต้นทางในเว็บเราขึ้นสถานะ
            // "ตอบแล้ว" ไปด้วย ไม่ใช่ค้างเป็น "ต้องตอบกลับ" ทั้งที่จริงมีคนตอบไปแล้ว (ตามที่ขอ)
            const commenterId = change.value.from && String(change.value.from.id);
            if (commenterId === fbPageId) {
              await handlePageAuthoredComment(pageUuid, change.value);
              continue;
            }
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

// ดึง id (uuid ภายใน) + app_secret เฉพาะของเพจ (ถ้าผูก Webhook แบบ self-service ไว้) จากตาราง pages
// จริง (ไม่ใช่ pages_public) ด้วย service role key — ใช้ทั้งหาเพจปลายทางของ event และหา secret มา
// ตรวจลายเซ็นในคำเดียวกัน กันยิง query ซ้ำสองรอบ
async function fetchPagesByFbIds(fbPageIds) {
  const ids = fbPageIds.filter(Boolean);
  if (!ids.length) return [];
  const idList = ids.map((id) => `"${id}"`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/pages?page_id=in.(${idList})&select=id,page_id,app_secret`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) {
    console.error('webhook error: fetchPagesByFbIds ล้มเหลว', r.status, await r.text().catch(() => ''));
    return [];
  }
  return await r.json();
}

// ถ้า rawId มี post_id ต่อท้ายอยู่แล้ว (บาง reply ที่ซ้อนลึกๆ Facebook ส่งมาเป็นรูปแบบผสมเลย)
// ก็ใช้ตามนั้น ไม่ต้องต่อ post_id ซ้ำอีกที — กันปัญหาแบบเดียวกับที่เจอตอน fb_id ผิดรูปจนตอบไม่สำเร็จ
function toFbId(postId, rawId) {
  if (!rawId) return null;
  const raw = String(rawId);
  return raw.startsWith(`${postId}_`) ? raw : `${postId}_${raw}`;
}

// เพจตัวเองเป็นคนคอมเมนต์ — ถ้าเป็นคอมเมนต์ระดับบนสุด (ไม่มี parent_id เช่นแคปชั่นประกาศของเพจ)
// ไม่เกี่ยวอะไรกับการตอบคอมเมนต์ ข้ามไปเฉยๆ ถ้าเป็น "reply ซ้อนใต้คอมเมนต์อื่น" (มี parent_id)
// ต้องแยกให้ออกว่าเป็น echo ของคำตอบที่เราเพิ่งส่งเองผ่านเว็บนี้ (ข้าม กันลูป) หรือเป็นคำตอบที่มาจาก
// เครื่องมือ/บอทอื่นที่ทีมใช้คู่กันตอบตรงที่หน้าเพจ Facebook เลย (ถ้าใช่ ให้ไปมาร์คคอมเมนต์ต้นทาง
// ในเว็บเราว่า "ตอบแล้ว" ด้วย จะได้ไม่ค้างเป็น "ต้องตอบกลับ" ทั้งที่มีคนตอบไปแล้วจริง)
async function handlePageAuthoredComment(pageUuid, value) {
  if (!value.parent_id) return;

  const replyFbId = toFbId(value.post_id, value.comment_id);
  const alreadyOurs = await isOwnRecordedReply(replyFbId);
  if (alreadyOurs) return; // เราส่งเองผ่านเว็บนี้แล้ว บันทึกไว้แล้ว — แค่ echo กลับมา ไม่ต้องทำอะไรซ้ำ

  const parentFbId = toFbId(value.post_id, value.parent_id);
  await markRepliedExternally(pageUuid, parentFbId, value.message, replyFbId);
}

async function isOwnRecordedReply(replyFbId) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?admin_reply_fb_id=eq.${encodeURIComponent(replyFbId)}&select=id&limit=1`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return false;
  const rows = await r.json();
  return rows.length > 0;
}

// เจอว่ามีคนตอบคอมเมนต์ต้นทางนี้ผ่านเครื่องมืออื่นแล้ว (ไม่ใช่ผ่านเว็บเรา) — มาร์คสถานะเป็น "ตอบแล้ว"
// ให้ตรงกับความจริง เฉพาะรายการที่ยัง pending อยู่เท่านั้น (กันเผลอไปทับของที่จัดการไปแล้วซ้ำ)
async function markRepliedExternally(pageUuid, parentFbId, replyMessage, replyFbId) {
  const url = `${SUPABASE_URL}/rest/v1/feed_items?page_id=eq.${encodeURIComponent(pageUuid)}&fb_id=eq.${encodeURIComponent(parentFbId)}&status=eq.pending`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'replied',
      admin_reply: replyMessage || '(ตอบผ่านเครื่องมืออื่น ไม่มีข้อความให้แสดง)',
      admin_reply_fb_id: replyFbId,
      admin_reply_by: 'บอท/เครื่องมืออื่น (ตอบที่หน้าเพจ)',
    }),
  });
  if (!r.ok) {
    console.error('webhook error: markRepliedExternally ล้มเหลว', r.status, await r.text().catch(() => ''));
  }
}

async function insertComment(pageUuid, value) {
  // เช็ครูปที่แนบมากับคอมเมนต์ (ถ้ามี) ตั้งแต่ตอนรับเข้ามาครั้งแรกเลย เก็บ URL ไว้ให้แดชบอร์ดโชว์
  // เป็น thumbnail ในแถวรายการได้ทันที ไม่ต้องรอกดแว่นขยายเปิดดูทีหลัง (เดิม post-detail.mjs ดึงตอน
  // กดแว่นขยายเท่านั้น — ตอนนี้ยิงคำขอเดียวกันแบบนี้ล่วงหน้าไปเลย ครั้งเดียวตอนคอมเมนต์เข้าใหม่)
  // ทำ best-effort เท่านั้น — ถ้าดึงไม่สำเร็จ (เช่น token ปัญหา/หมดเวลา) ก็แค่ไม่มี thumbnail ให้
  // ไม่ทำให้การบันทึกคอมเมนต์หลักล้มเหลวไปด้วย
  const attachmentImageUrl = await fetchCommentAttachmentImage(pageUuid, value.comment_id).catch((err) => {
    console.error('webhook warning: ดึงรูปแนบคอมเมนต์ไม่สำเร็จ (ไม่กระทบการบันทึกคอมเมนต์หลัก)', err);
    return null;
  });
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
    attachment_image_url: attachmentImageUrl,
  };
  await insertFeedItem(record);
}

// ดึง access_token ของเพจตรงจากตาราง pages จริง (ไม่ใช่ pages_public) — webhook.js ใช้ service role
// key อยู่แล้วเลยข้าม RLS อ่านคอลัมน์ access_token ได้โดยตรง (แพทเทิร์นเดียวกับ api/reply.mjs)
async function fetchPageAccessToken(pageUuid) {
  const url = `${SUPABASE_URL}/rest/v1/pages?id=eq.${encodeURIComponent(pageUuid)}&select=access_token`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] ? rows[0].access_token : null;
}

// ยิง Graph API ดึง attachment ของคอมเมนต์นี้ (รูปเดี่ยวหรือ album หลายรูปก็ได้ เอาแค่รูปแรก) —
// เอาเฉพาะ field attachment เท่านั้น (เบากว่า fetchComment เต็มรูปแบบใน post-detail.mjs ที่ดึง
// message/from/permalink ด้วย เพราะตรงนี้แค่ต้องการรูปอย่างเดียว)
async function fetchCommentAttachmentImage(pageUuid, commentId) {
  const accessToken = await fetchPageAccessToken(pageUuid);
  if (!accessToken) return null;
  const fields = 'attachment{media,type,subattachments}';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) return null;
  const att = data.attachment;
  if (att && att.media && att.media.image && att.media.image.src) return att.media.image.src;
  if (att && att.subattachments && Array.isArray(att.subattachments.data) && att.subattachments.data[0]) {
    const sub = att.subattachments.data[0];
    if (sub.media && sub.media.image && sub.media.image.src) return sub.media.image.src;
  }
  return null;
}

// ลูกค้า/Facebook ลบคอมเมนต์ทิ้ง — ลบแถวที่ตรงกันออกจาก feed_items ไปเลย (ไม่ใช่แค่ย้ายเข้าถัง)
// เพราะต้นทางไม่มีอยู่จริงแล้ว เก็บไว้ก็ตอบกลับไม่ได้ ให้หายไปจากแดชบอร์ดตรงๆ ตามที่ขอ
async function deleteComment(value) {
  const fbId = `${value.post_id}_${value.comment_id}`;
  const url = `${SUPABASE_URL}/rest/v1/feed_items?fb_id=eq.${encodeURIComponent(fbId)}`;
  const r = await fetch(url, { method: 'DELETE', headers: sbHeaders });
  if (!r.ok) {
    console.error('webhook error: deleteComment ล้มเหลว', r.status, await r.text().catch(() => ''));
  }
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(record),
  });
  if (!r.ok) {
    console.error('webhook error: insertFeedItem ล้มเหลว', r.status, await r.text().catch(() => ''));
  }
}
