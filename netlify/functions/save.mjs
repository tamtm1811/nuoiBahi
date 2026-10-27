// Sao lưu & khôi phục tiến trình Nuôi Bahi bằng Mã khôi phục — lưu bằng Netlify Blobs
// Mã khôi phục vừa là "chìa khóa" vừa là tên ô lưu: máy chủ chỉ giữ bản băm SHA-256 của mã, không lưu mã gốc.
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/save" };

const MAX_DATA = 400_000; // ~400KB, bản lưu thực tế chỉ vài chục KB
const MIN_GAP_MS = 4_000; // chống gửi dồn dập
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;
const DEV_RE = /^[a-z0-9]{12,40}$/;
const clamp = (v, a, b, d = 0) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, Math.round(+v))) : d);
const str = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// thông tin tóm tắt để xem trước khi khôi phục
function cleanMeta(m) {
  m = m && typeof m === "object" ? m : {};
  return {
    nick: str(m.nick, 12),
    lv: clamp(m.lv, 1, 5000, 1),
    floor: clamp(m.floor, 0, 100),
    coin: clamp(m.coin, 0, 1e12),
    gem: clamp(m.gem, 0, 1e9),
    coll: clamp(m.coll, 0, 10000),
    pets: clamp(m.pets, 0, 10000),
    F: clamp(m.F, 0, 999),
    v: clamp(m.v, 0, 3),
    fr: clamp(m.fr, 0, 5),
    name: str(m.name, 40),
    cos: Array.isArray(m.cos) ? m.cos.slice(0, 3).map((x) => str(x, 24)).filter(Boolean) : [],
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  const code = normCode(body.code);
  if (!CODE_RE.test(code)) return json({ error: "code" }, 400);
  const store = getStore({ name: "bahi-save", consistency: "strong" });
  const key = "s/" + (await sha("bahi-save:" + code));
  const op = body.op;
  const cur = await store.get(key, { type: "json" });

  // xem trước + tải bản lưu
  if (op === "get") {
    if (!cur) return json({ error: "notfound" }, 404);
    return json({ data: cur.data, meta: cur.meta, at: cur.at });
  }

  const dev = str(body.dev, 40);
  if (!DEV_RE.test(dev)) return json({ error: "dev" }, 400);

  // nhận máy này làm máy chính của mã (sau khi khôi phục, hoặc lấy lại quyền lưu)
  if (op === "claim") {
    if (!cur) return json({ error: "notfound" }, 404);
    await store.setJSON(key, { ...cur, dev, claimAt: Date.now() });
    return json({ ok: true, at: cur.at });
  }

  // ghi bản lưu
  if (op === "put") {
    const data = typeof body.data === "string" ? body.data : "";
    if (!data || data.length > MAX_DATA) return json({ error: "size" }, 413);
    try { const o = JSON.parse(data); if (!o || typeof o !== "object" || Array.isArray(o)) throw 0; } catch { return json({ error: "data" }, 400); }
    // mã đã được khôi phục sang máy khác: chặn máy cũ ghi đè lên tiến trình mới
    if (cur && cur.dev && cur.dev !== dev && !body.force) return json({ error: "moved", at: cur.at, claimAt: cur.claimAt || 0 }, 409);
    const now = Date.now();
    if (cur && cur.dev === dev && now - (cur.at || 0) < MIN_GAP_MS) return json({ ok: true, at: cur.at, skip: true });
    await store.setJSON(key, { data, meta: cleanMeta(body.meta), dev, at: now, claimAt: cur && cur.dev === dev ? cur.claimAt || 0 : now });
    return json({ ok: true, at: now });
  }

  return json({ error: "op" }, 400);
};
