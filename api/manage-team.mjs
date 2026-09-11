// api/manage-team.mjs
// ให้เจ้าของ/คนที่มีสิทธิ์ can_manage_team ใน app_metadata จัดการสมาชิกทีมเองจากหน้าเว็บได้เลย:
// เพิ่มบัญชีใหม่ (อีเมล/รหัสผ่าน) + ตั้งสิทธิ์ + เลือกว่าเห็นเพจไหนได้บ้าง โดยไม่ต้องรอให้ Claude
// รัน SQL ให้ทุกครั้งเหมือนเดิม (แพทเทิร์นเดียวกับ api/manage-pages.mjs)
//
// สิทธิ์ที่ตั้งได้ (เก็บใน auth.users.app_metadata — แก้ได้จากฝั่งเซิร์ฟเวอร์เท่านั้น ผู้ใช้เองแก้ค่า
// ตัวเองไม่ได้ กันคนแอบเลื่อนสิทธิ์ตัวเอง):
//   can_view_analytics  — เข้าหน้ารายงานสถิติได้
//   can_manage_pages    — เข้าหน้า "จัดการเพจ" (ตั้งค่า token/webhook) ได้
//   can_manage_team     — เข้าหน้า "จัดการทีม" นี้เองได้ (เพิ่ม/แก้/ลบคนอื่น ตั้งสิทธิ์คนอื่น)
//   can_see_all_pages   — เห็นคอมเมนต์ของ "ทุกเพจ" ใน Inbox/รายงาน ถ้าเป็น false จะเห็นเฉพาะเพจที่
//                         ถูกเลือกไว้ในตาราง user_page_access เท่านั้น (บังคับจริงผ่าน RLS ที่ชั้น
//                         ฐานข้อมูล ไม่ใช่แค่ซ่อนที่ frontend — ต่อให้เปิด DevTools ยิง query ตรงก็ยัง
//                         โดนกรองอยู่ดี)

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acwilhbtdbxhhwlabpes.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_i9A_PqJhrOb8kmP47x2OOg_Ma2AhTRn';

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function requireAuth(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function canManageTeam(user) {
  return !!(user && user.app_metadata && user.app_metadata.can_manage_team);
}

function buildAppMetadataPatch(permissions) {
  return {
    can_view_analytics: !!permissions.canViewAnalytics,
    can_manage_pages: !!permissions.canManagePages,
    can_manage_team: !!permissions.canManageTeam,
    can_see_all_pages: !!permissions.canSeeAllPages,
  };
}

// ดึงรายชื่อทีมทั้งหมดจาก Supabase Auth (GoTrue admin API) + เพจที่แต่ละคนมีสิทธิ์เห็น (ถ้า
// can_see_all_pages เป็น false) มารวมกันเป็นก้อนเดียวส่งกลับให้ frontend
async function listTeam() {
  const usersR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: sbHeaders });
  if (!usersR.ok) throw new Error('โหลดรายชื่อทีมไม่สำเร็จ');
  const usersData = await usersR.json();
  const users = Array.isArray(usersData) ? usersData : usersData.users || [];

  const accessR = await fetch(`${SUPABASE_URL}/rest/v1/user_page_access?select=user_id,page_id`, { headers: sbHeaders });
  const accessRows = accessR.ok ? await accessR.json() : [];
  const pageIdsByUser = {};
  for (const row of accessRows) {
    (pageIdsByUser[row.user_id] || (pageIdsByUser[row.user_id] = [])).push(row.page_id);
  }

  return users
    .map((u) => {
      const meta = u.app_metadata || {};
      const um = u.user_metadata || {};
      return {
        id: u.id,
        email: u.email,
        firstName: um.first_name || '',
        lastName: um.last_name || '',
        createdAt: u.created_at,
        canViewAnalytics: !!meta.can_view_analytics,
        canManagePages: !!meta.can_manage_pages,
        canManageTeam: !!meta.can_manage_team,
        canSeeAllPages: !!meta.can_see_all_pages,
        pageIds: pageIdsByUser[u.id] || [],
      };
    })
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// แทนที่รายการเพจที่มีสิทธิ์เห็นทั้งชุด (ลบของเดิมทิ้งก่อนแล้วใส่ใหม่ — ง่ายกว่า diff เอง เพราะจำนวน
// เพจในระบบมีไม่มาก ไม่ต้องกังวลเรื่องประสิทธิภาพ)
async function replacePageAccess(userId, pageIds) {
  const delR = await fetch(`${SUPABASE_URL}/rest/v1/user_page_access?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: sbHeaders,
  });
  if (!delR.ok) {
    console.error('manage-team error: ลบสิทธิ์เพจเดิมไม่สำเร็จ', delR.status, await delR.text().catch(() => ''));
    return { ok: false, error: 'บันทึกสิทธิ์เพจไม่สำเร็จ (ลบของเดิม)' };
  }
  if (Array.isArray(pageIds) && pageIds.length) {
    const rows = pageIds.map((pid) => ({ user_id: userId, page_id: pid }));
    const insR = await fetch(`${SUPABASE_URL}/rest/v1/user_page_access`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify(rows),
    });
    if (!insR.ok) {
      console.error('manage-team error: บันทึกสิทธิ์เพจใหม่ไม่สำเร็จ', insR.status, await insR.text().catch(() => ''));
      return { ok: false, error: 'บันทึกสิทธิ์เพจไม่สำเร็จ' };
    }
  }
  return { ok: true };
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const user = await requireAuth(request);
  if (!user) return json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' }, 401);
  if (!canManageTeam(user)) return json({ error: 'คุณไม่มีสิทธิ์จัดการทีม' }, 403);

  if (!SERVICE_KEY) {
    console.error('manage-team error: missing SUPABASE_SERVICE_ROLE_KEY env var');
    return json({ error: 'เซิร์ฟเวอร์ตั้งค่าไม่ครบ (ไม่มี service key)' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON ไม่ถูกต้อง' }, 400);
  }
  const { action } = body || {};

  try {
    if (action === 'list') {
      const team = await listTeam();
      return json({ ok: true, team, selfId: user.id });
    }

    if (action === 'create') {
      const { email, password, firstName, lastName, permissions, pageIds } = body || {};
      if (!email || !String(email).trim()) return json({ error: 'อีเมลจำเป็นต้องมี' }, 400);
      if (!password || String(password).length < 6) return json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' }, 400);

      const appMeta = buildAppMetadataPatch(permissions || {});
      const createR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          email: String(email).trim(),
          password: String(password),
          email_confirm: true,
          app_metadata: appMeta,
          user_metadata: { first_name: firstName ? String(firstName).trim() : '', last_name: lastName ? String(lastName).trim() : '' },
        }),
      });
      const createData = await createR.json().catch(() => ({}));
      if (!createR.ok) {
        console.error('manage-team error: สร้างบัญชีไม่สำเร็จ', createR.status, createData);
        const msg = createData.msg || createData.error_description || createData.error || 'สร้างบัญชีไม่สำเร็จ (อีเมลนี้อาจมีอยู่แล้ว)';
        return json({ error: msg }, 400);
      }

      if (!appMeta.can_see_all_pages && Array.isArray(pageIds) && pageIds.length) {
        const accessResult = await replacePageAccess(createData.id, pageIds);
        if (!accessResult.ok) {
          return json({ ok: true, id: createData.id, warning: 'สร้างบัญชีสำเร็จ แต่ตั้งสิทธิ์เพจไม่สำเร็จ ลองแก้ไขอีกครั้ง' });
        }
      }
      return json({ ok: true, id: createData.id });
    }

    if (action === 'update-permissions') {
      const { id, permissions, newPassword } = body || {};
      if (!id) return json({ error: 'ไม่พบผู้ใช้นี้' }, 400);
      if (newPassword && String(newPassword).length < 6) {
        return json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' }, 400);
      }

      // ดึง app_metadata เดิมมาก่อนเพื่อรวมกับของใหม่ (กัน provider/providers ที่ Supabase ใส่ไว้ตอน
      // สมัครหายไปตอนบันทึกทับ)
      const getR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, { headers: sbHeaders });
      if (!getR.ok) return json({ error: 'ไม่พบผู้ใช้นี้' }, 404);
      const userData = await getR.json();
      const merged = { ...(userData.app_metadata || {}), ...buildAppMetadataPatch(permissions || {}) };

      const putBody = { app_metadata: merged };
      // ตั้งรหัสผ่านใหม่ให้สมาชิกคนอื่นได้ในตัวเดียวกัน (ทางเลือก — ไม่ใส่มาก็แค่ไม่แตะรหัสผ่านเดิม)
      if (newPassword && String(newPassword).trim()) {
        putBody.password = String(newPassword).trim();
      }
      const putR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: sbHeaders,
        body: JSON.stringify(putBody),
      });
      if (!putR.ok) {
        const errData = await putR.json().catch(() => ({}));
        console.error('manage-team error: บันทึกสิทธิ์ไม่สำเร็จ', putR.status, errData);
        return json({ error: errData.msg || 'บันทึกสิทธิ์ไม่สำเร็จ' }, 502);
      }

      // ถ้าเปลี่ยนเป็น "เห็นทุกเพจ" ไม่ต้องมีแถวใน user_page_access ค้างอยู่ก็ได้ (ไม่ผิดอะไรถ้าค้าง
      // เพราะฟังก์ชันเช็ค can_see_all_pages ก่อนอยู่แล้ว) แต่ล้างทิ้งให้สะอาดไปเลยกันงง
      if (merged.can_see_all_pages) {
        await fetch(`${SUPABASE_URL}/rest/v1/user_page_access?user_id=eq.${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: sbHeaders,
        }).catch(() => {});
      }

      return json({ ok: true });
    }

    if (action === 'update-page-access') {
      const { id, pageIds } = body || {};
      if (!id) return json({ error: 'ไม่พบผู้ใช้นี้' }, 400);
      const result = await replacePageAccess(id, Array.isArray(pageIds) ? pageIds : []);
      return json(result, result.ok ? 200 : 502);
    }

    if (action === 'delete') {
      const { id } = body || {};
      if (!id) return json({ error: 'ไม่พบผู้ใช้นี้' }, 400);
      if (id === user.id) return json({ error: 'ลบบัญชีตัวเองจากหน้านี้ไม่ได้' }, 400);

      const delR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: sbHeaders,
      });
      if (!delR.ok) {
        const errData = await delR.json().catch(() => ({}));
        console.error('manage-team error: ลบบัญชีไม่สำเร็จ', delR.status, errData);
        return json({ error: errData.msg || 'ลบบัญชีไม่สำเร็จ' }, 502);
      }
      // user_page_access มี on delete cascade ผูกกับ auth.users อยู่แล้ว ไม่ต้องลบเองซ้ำ
      return json({ ok: true });
    }

    return json({ error: `ไม่รู้จัก action: ${action}` }, 400);
  } catch (err) {
    console.error('manage-team error', err);
    return json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' }, 500);
  }
}
