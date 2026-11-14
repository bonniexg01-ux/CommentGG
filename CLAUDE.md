# CommentGG — หมายเหตุสำหรับ Claude

## ขีดจำกัดฟังก์ชันของ Vercel (สำคัญ)
- โปรเจกต์นี้ใช้ Vercel แพ็กเกจ Hobby ซึ่งจำกัด Serverless Functions ไว้ 12 ตัวต่อ deployment
  (ทุกไฟล์ในโฟลเดอร์ `api/` = 1 ฟังก์ชัน) — ตอนนี้ใช้ครบ 12 ตัวแล้ว
- **ห้ามเพิ่มไฟล์ใหม่ใน `api/` โดยไม่ถามเจ้าของก่อน** ต้องเตือนและขออนุญาตก่อนทุกครั้ง
- ทางเลือกที่ไม่ต้องเพิ่มฟังก์ชัน: รวม action เข้าไฟล์เดิม (เช่น post-detail รองรับ `pagePostId`)
  หรือวางโค้ดที่ใช้ร่วมกันไว้ใน `lib/` (ไฟล์นอก `api/` ไม่นับ)

## เลขเวอร์ชัน
- `APP_VERSION` ใน index.html โชว์ท้ายเมนูผู้ใช้ ใช้เช็คว่ามือถือโหลดเวอร์ชันล่าสุดหรือยัง — อัปเดตเป็นวันเวลา (เวลาไทย) ทุกครั้งที่ deploy

## Cloudflare Workers (ตั้งแต่ 14/11/2026)
- เว็บจริง: https://commentgg.cs-exe.workers.dev (Webhook ของแอป Facebook ทั้ง 3 แอปชี้มาที่ /api/webhook ของลิงก์นี้)
- Vercel แผนฟรีโดนระงับเพราะใช้โควตาเกิน — ย้ายไป Cloudflare Workers: ไฟล์เว็บ static ฟรีไม่จำกัด, `/api/*` วิ่งผ่าน `worker.js` ที่เรียกโค้ดเดิมใน `api/` (โควตาฟรี 100,000 ครั้ง/วัน)
- แก้ logic ที่ `api/*` ตามเดิม ใช้ได้ทั้ง Vercel และ Cloudflare; ถ้าเพิ่ม endpoint ใหม่ต้องเพิ่มใน `worker.js` ด้วย
- `lib/push.cjs` ส่ง Web Push เองด้วย Web Crypto (ไม่ใช้ไลบรารี web-push แล้ว); `lib/node-adapter.mjs` แปลง Request ให้ฟังก์ชันแบบ (req,res)
- ตั้งค่าใน `wrangler.toml` (nodejs_compat, assets) + `.assetsignore` — ค่าลับตั้งใน Cloudflare dashboard: SUPABASE_SERVICE_ROLE_KEY, META_VERIFY_TOKEN/META_APP_SECRET (ไม่บังคับ)
