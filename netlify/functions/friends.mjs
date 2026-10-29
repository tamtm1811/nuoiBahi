// Bạn bè Nuôi Bahi — kết bạn bằng ID, lời mời, xem tiến trình của nhau. Lưu bằng Netlify Blobs.
// Mỗi mối quan hệ nằm ở một khóa riêng nên hai người thao tác cùng lúc không ghi đè lên nhau:
//   u/<id>          hồ sơ + bản băm mật khẩu thiết bị + mã kết bạn
//   c/<MÃ>          mã kết bạn → id
//   r/<tới>/<từ>    lời mời đang chờ
//   f/<a>/<b>       đã là bạn (luôn ghi đủ 2 chiều)
//   g/<từ>/<ngày>/<tới>   đã tặng quà hôm nay (mỗi người bạn 1 hộp/ngày)
//   gi/<tới>/<khóa>       hộp quà bí ẩn đang chờ mở (độ hiếm tung ở máy chủ lúc gửi)
//   gc/<a>/<b>            số quà a đã tặng b (độ thân thiết)
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/friends" };

const NICK_MAX = 12;
const MAX_FRIENDS = 50;
const MAX_INC = 40; // lời mời đang chờ tối đa của một người
const MAX_OUT = 20; // lời mời mình gửi đi đang chờ tối đa
const MIN_GAP_MS = 8_000; // chống ghi hồ sơ dồn dập
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const ID_RE = /^[a-z0-9]{12,40}$/;
// hộp quà bạn bè: tỉ lệ công khai (phần nghìn) Thường 60% · Hiếm 27% · Sử thi 10% · Huyền thoại 2,5% · Thần thoại 0,5%
const GIFT_ODDS = [600, 270, 100, 25, 5];
const GIFT_INBOX = 60, GIFT_KEEP_MS = 7 * 86400e3, GIFT_UP = 0.3; // quà đôi (hai bên tặng nhau cùng ngày): 30% nâng 1 bậc khi mở
const dayVN = (t) => new Date((t || Date.now()) + 7 * 3600e3).toISOString().slice(0, 10);
function rnd1000() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % 1000; }
function rollGift() { let u = rnd1000(); for (let i = 0; i < GIFT_ODDS.length; i++) { u -= GIFT_ODDS[i]; if (u < 0) return i; } return 0; }
const GKEY_RE = /^[0-9]{13}-[a-z0-9]{12,40}$/;

const clamp = (v, a, b, d = 0) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, Math.round(+v))) : d);
const str = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function genCode() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((x) => ABC[x & 31]).join("");
}

// hồ sơ công khai cho bạn bè (cùng dạng dữ liệu bảng xếp hạng cũ)
function clean(p) {
  p = p && typeof p === "object" ? p : {};
  const gear = Array.isArray(p.gear) ? p.gear.slice(0, 4).map((g) => ({ id: str(g && g.id, 24), r: clamp(g && g.r, 0, 5), s: clamp(g && g.s, 0, 9) })) : [];
  const pet = p.pet && typeof p.pet === "object"
    ? { sp: clamp(p.pet.sp, 0, 999), v: clamp(p.pet.v, 0, 9), br: Array.isArray(p.pet.br) ? p.pet.br.slice(0, 4).map((x) => clamp(x, 0, 9)) : [], lv: clamp(p.pet.lv, 1, 999, 1), r: clamp(p.pet.r, 0, 9) }
    : null;
  return {
    nick: str(p.nick, NICK_MAX),
    floor: clamp(p.floor, 0, 100),
    lv: clamp(p.lv, 1, 5000, 1),
    cp: clamp(p.cp, 0, 1e8),
    coll: clamp(p.coll, 0, 10000),
    bosses: clamp(p.bosses, 0, 10),
    done: !!p.done,
    F: clamp(p.F, 0, 999),
    v: clamp(p.v, 0, 3),
    fr: clamp(p.fr, 0, 5),
    best: clamp(p.best, 0, 100000),
    pets: clamp(p.pets, 0, 10000),
    disc: clamp(p.disc, 0, 1000),
    rb: clamp(p.rb, 0, 999),
    gear,
    pet,
    cos: Array.isArray(p.cos) ? p.cos.slice(0, 3).map((x) => str(x, 24)).filter(Boolean) : [],
  };
}
const pub = (id, u, extra) => (u ? { id, code: u.code, ...u.p, seen: u.last || 0, ...(extra || {}) } : null);

async function keysOf(store, prefix) {
  const { blobs } = await store.list({ prefix });
  return blobs.map((b) => b.key.slice(prefix.length));
}
async function users(store, ids) {
  const list = await Promise.all(ids.map((id) => store.get("u/" + id, { type: "json" }).then((u) => [id, u]).catch(() => [id, null])));
  return list.filter(([, u]) => u);
}

// toàn bộ trạng thái bạn bè của một người
async function state(store, id, me) {
  const day = dayVN();
  const [fr, inc, out, sent, gk] = await Promise.all([keysOf(store, "f/" + id + "/"), keysOf(store, "r/" + id + "/"), keysOf(store, "o/" + id + "/"), keysOf(store, "g/" + id + "/" + day + "/"), keysOf(store, "gi/" + id + "/")]);
  // hộp quà: dọn hộp quá hạn / quá nhiều, giữ mới nhất
  gk.sort().reverse();
  const old = gk.filter((k, i) => i >= GIFT_INBOX || Date.now() - +k.slice(0, 13) > GIFT_KEEP_MS);
  if (old.length) await Promise.all(old.map((k) => store.delete("gi/" + id + "/" + k)));
  const live = gk.filter((k) => !old.includes(k));
  const gifts = (await Promise.all(live.map((k) => store.get("gi/" + id + "/" + k, { type: "json" }).then((g) => (g ? { key: k, from: g.from, nick: g.nick, at: g.at } : null)).catch(() => null)))).filter(Boolean);
  const [F, I, O] = await Promise.all([users(store, fr), users(store, inc), users(store, out)]);
  const reqAt = {};
  await Promise.all(inc.map(async (from) => { const r = await store.get("r/" + id + "/" + from, { type: "json" }).catch(() => null); reqAt[from] = (r && r.at) || 0; }));
  return {
    code: me.code,
    friends: F.map(([fid, u]) => pub(fid, u)),
    inc: I.map(([fid, u]) => pub(fid, u, { at: reqAt[fid] || 0 })).sort((a, b) => b.at - a.at),
    out: O.map(([fid, u]) => ({ id: fid, code: u.code, nick: u.p.nick, F: u.p.F, v: u.p.v, fr: u.p.fr, cos: u.p.cos, lv: u.p.lv, floor: u.p.floor })),
    sent, gifts, day,
    at: Date.now(),
  };
}

async function makeFriends(store, a, b) {
  const at = Date.now();
  await Promise.all([
    store.setJSON("f/" + a + "/" + b, { at }),
    store.setJSON("f/" + b + "/" + a, { at }),
    store.delete("r/" + a + "/" + b), store.delete("o/" + b + "/" + a),
    store.delete("r/" + b + "/" + a), store.delete("o/" + a + "/" + b),
  ]);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  const id = str(body.id, 40), sec = str(body.secret, 80);
  if (!ID_RE.test(id) || sec.length < 16) return json({ error: "id" }, 400);
  const store = getStore({ name: "bahi-friend", consistency: "strong" });
  const h = await sha(id + ":" + sec);
  let me = await store.get("u/" + id, { type: "json" });
  if (me && me.h !== h) return json({ error: "owner" }, 403);
  const op = String(body.op || "sync");

  // đăng ký / cập nhật hồ sơ, cấp mã kết bạn nếu chưa có
  if (!me || body.profile) {
    const p = clean(body.profile || (me && me.p) || {});
    if (!p.nick) return json({ error: "nick" }, 400);
    const now = Date.now();
    if (!me) {
      let code = "";
      for (let k = 0; k < 8; k++) { const c = genCode(); if (!(await store.get("c/" + c, { type: "json" }))) { code = c; break; } }
      if (!code) return json({ error: "busy" }, 503);
      await store.setJSON("c/" + code, { id });
      me = { h, code, p, last: now, created: now };
      await store.setJSON("u/" + id, me);
    } else if (now - (me.last || 0) >= MIN_GAP_MS || JSON.stringify(me.p) !== JSON.stringify(p)) {
      me = { ...me, p, last: now };
      await store.setJSON("u/" + id, me);
    }
  }

  if (op === "sync") return json(await state(store, id, me));

  // gửi lời mời theo mã kết bạn
  if (op === "req") {
    const code = normCode(body.code);
    if (!CODE_RE.test(code)) return json({ error: "code" }, 400);
    if (code === me.code) return json({ error: "self" }, 400);
    const c = await store.get("c/" + code, { type: "json" });
    const tid = c && c.id;
    const them = tid ? await store.get("u/" + tid, { type: "json" }) : null;
    if (!them) return json({ error: "notfound" }, 404);
    if (await store.get("f/" + id + "/" + tid, { type: "json" })) return json({ error: "already", nick: them.p.nick }, 409);
    const myFriends = await keysOf(store, "f/" + id + "/");
    if (myFriends.length >= MAX_FRIENDS) return json({ error: "full" }, 409);
    // người kia đã mời mình trước → thành bạn luôn
    if (await store.get("r/" + id + "/" + tid, { type: "json" })) {
      const theirs = await keysOf(store, "f/" + tid + "/");
      if (theirs.length >= MAX_FRIENDS) return json({ error: "tfull", nick: them.p.nick }, 409);
      await makeFriends(store, id, tid);
      return json({ ok: true, auto: true, nick: them.p.nick, ...(await state(store, id, me)) });
    }
    if (await store.get("r/" + tid + "/" + id, { type: "json" })) return json({ error: "pending", nick: them.p.nick }, 409);
    const [inc, out] = await Promise.all([keysOf(store, "r/" + tid + "/"), keysOf(store, "o/" + id + "/")]);
    if (inc.length >= MAX_INC) return json({ error: "tfull", nick: them.p.nick }, 409);
    if (out.length >= MAX_OUT) return json({ error: "outfull" }, 409);
    const at = Date.now();
    await Promise.all([store.setJSON("r/" + tid + "/" + id, { at }), store.setJSON("o/" + id + "/" + tid, { at })]);
    return json({ ok: true, nick: them.p.nick, ...(await state(store, id, me)) });
  }

  // mở hộp quà: độ hiếm đã định sẵn lúc gửi; quà đôi có thể được nâng 1 bậc
  if (op === "open" || op === "openall") {
    let keys = op === "open" ? [str(body.key, 60)] : (await keysOf(store, "gi/" + id + "/")).slice(0, 30);
    keys = keys.filter((k) => GKEY_RE.test(k));
    const res = [];
    for (const k of keys) {
      const g = await store.get("gi/" + id + "/" + k, { type: "json" });
      if (!g) continue;
      await store.delete("gi/" + id + "/" + k);
      let tier = Math.min(4, Math.max(0, +g.tier || 0)), up = false;
      if (tier < 4 && (await store.get("g/" + id + "/" + g.day + "/" + g.from, { type: "json" })) && rnd1000() < GIFT_UP * 1000) { tier++; up = true; }
      res.push({ key: k, from: g.from, nick: g.nick, tier, up });
    }
    if (op === "open" && !res.length) return json({ error: "gone", ...(await state(store, id, me)) }, 404);
    return json({ ok: true, opened: res, ...(await state(store, id, me)) });
  }

  const other = str(body.other, 40);
  if (!ID_RE.test(other) || other === id) return json({ error: "other" }, 400);

  if (op === "accept") {
    if (!(await store.get("r/" + id + "/" + other, { type: "json" }))) return json({ error: "gone", ...(await state(store, id, me)) }, 404);
    const [mine, theirs] = await Promise.all([keysOf(store, "f/" + id + "/"), keysOf(store, "f/" + other + "/")]);
    if (mine.length >= MAX_FRIENDS) return json({ error: "full" }, 409);
    if (theirs.length >= MAX_FRIENDS) return json({ error: "tfull" }, 409);
    await makeFriends(store, id, other);
    return json({ ok: true, ...(await state(store, id, me)) });
  }
  if (op === "decline") { // từ chối lời mời gửi tới mình
    await Promise.all([store.delete("r/" + id + "/" + other), store.delete("o/" + other + "/" + id)]);
    return json({ ok: true, ...(await state(store, id, me)) });
  }
  if (op === "cancel") { // rút lại lời mời mình đã gửi
    await Promise.all([store.delete("r/" + other + "/" + id), store.delete("o/" + id + "/" + other)]);
    return json({ ok: true, ...(await state(store, id, me)) });
  }
  if (op === "gift") { // tặng 1 hộp quà bí ẩn, mỗi người bạn 1 lần/ngày
    if (!(await store.get("f/" + id + "/" + other, { type: "json" }))) return json({ error: "notfriend" }, 409);
    const day = dayVN(), mk = "g/" + id + "/" + day + "/" + other;
    if (await store.get(mk, { type: "json" })) return json({ error: "gifted", ...(await state(store, id, me)) }, 409);
    const at = Date.now(), tier = rollGift();
    await store.setJSON(mk, { at });
    await store.setJSON("gi/" + other + "/" + at + "-" + id, { from: id, nick: me.p.nick, tier, day, at });
    const c = (await store.get("gc/" + id + "/" + other, { type: "json" })) || { n: 0 };
    await store.setJSON("gc/" + id + "/" + other, { n: (c.n || 0) + 1 });
    return json({ ok: true, ...(await state(store, id, me)) });
  }
  if (op === "remove") { // hủy kết bạn (xóa cả 2 chiều)
    await Promise.all([store.delete("f/" + id + "/" + other), store.delete("f/" + other + "/" + id)]);
    return json({ ok: true, ...(await state(store, id, me)) });
  }
  return json({ error: "op" }, 400);
};
