// Bảng Vàng Nuôi Bahi — lưu bằng Netlify Blobs
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/rank" };

const KEY = "board";
const NICK_MAX = 12;
const MIN_GAP_MS = 10_000; // chống gửi dồn dập
const clamp = (v, a, b, d = 0) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, Math.round(+v))) : d);
const str = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// thứ tự: tầng tháp > lực chiến > cấp > bộ sưu tập > ai đạt tầng đó sớm hơn
function cmp(a, b) {
  return b.floor - a.floor || b.cp - a.cp || b.lv - a.lv || b.coll - a.coll || (a.floorT || 9e15) - (b.floorT || 9e15);
}

function clean(p) {
  const gear = Array.isArray(p.gear) ? p.gear.slice(0, 4).map((g) => ({ id: str(g.id, 24), r: clamp(g.r, 0, 5), s: clamp(g.s, 0, 9) })) : [];
  const pet = p.pet && typeof p.pet === "object" ? { sp: clamp(p.pet.sp, 0, 999), v: clamp(p.pet.v, 0, 9), br: Array.isArray(p.pet.br) ? p.pet.br.slice(0, 4).map((x) => clamp(x, 0, 9)) : [], lv: clamp(p.pet.lv, 1, 999, 1), r: clamp(p.pet.r, 0, 9) } : null;
  return {
    nick: str(p.nick, NICK_MAX),
    floor: clamp(p.floor, 0, 100),
    floorT: clamp(p.floorT, 0, 9e15),
    lv: clamp(p.lv, 1, 5000, 1),
    cp: clamp(p.cp, 0, 1e8),
    coll: clamp(p.coll, 0, 10000),
    bosses: clamp(p.bosses, 0, 10),
    done: !!p.done,
    F: clamp(p.F, 0, 999),
    v: clamp(p.v, 0, 3),
    fr: clamp(p.fr, 0, 5),
    best: clamp(p.best, 0, 100000),
    tm: p.tm ? 1 : 0,
    gear,
    pet,
    cos: Array.isArray(p.cos) ? p.cos.slice(0, 3).map((x) => str(x, 24)).filter(Boolean) : [],
  };
}

function view(board, id) {
  // dữ liệu bị chỉnh sửa (tm) không lên bảng, chỉ chủ tài khoản thấy chính mình
  const list = Object.entries(board.p || {}).map(([k, e]) => ({ id: k, ...e })).filter((e) => !e.tm || e.id === id).sort(cmp);
  const pub = (e, i) => { const { h, last, id: pid, fb, lb, tm, ...rest } = e; return { rank: i + 1, ...rest, me: pid === id }; };
  const top = list.slice(0, 10).map(pub);
  let me = null, ahead = null;
  const i = id ? list.findIndex((e) => e.id === id) : -1;
  if (i >= 0) { me = pub(list[i], i); if (i > 0) ahead = pub(list[i - 1], i - 1); }
  return { top, me, ahead, total: list.length, at: Date.now() };
}

const REBUILD_MS = 5 * 60_000;
// mỗi người chơi lưu 1 khóa riêng (p/<id>) — không bao giờ mất dữ liệu khi ghi đồng thời;
// "board" chỉ là bản tổng hợp để đọc nhanh, tự dựng lại định kỳ từ các khóa riêng
async function rebuild(store) {
  const { blobs } = await store.list({ prefix: "p/" });
  const p = {};
  await Promise.all(blobs.map(async (b) => { const e = await store.get(b.key, { type: "json" }); if (e) p[b.key.slice(2)] = e; }));
  const board = { p, rebuilt: Date.now() };
  await store.setJSON(KEY, board);
  return board;
}
async function mergeBoard(store, id, entry) {
  for (let tries = 0; tries < 5; tries++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    if (!cur) return rebuild(store);
    const board = cur.data;
    board.p[id] = entry;
    const res = await store.setJSON(KEY, board, { onlyIfMatch: cur.etag });
    if (res.modified) return board;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  return rebuild(store);
}

export default async (req) => {
  const store = getStore({ name: "bahi-rank", consistency: "strong" });
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("t")) return json({ at: Date.now() }); // giờ chuẩn cho game (chống chỉnh đồng hồ máy)
    let board = await store.get(KEY, { type: "json" });
    if (!board || Date.now() - (board.rebuilt || 0) > REBUILD_MS) board = await rebuild(store);
    return json(view(board, str(url.searchParams.get("id"), 40)));
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  const id = str(body.id, 40), sec = str(body.secret, 80);
  if (!/^[a-z0-9]{12,40}$/.test(id) || sec.length < 16) return json({ error: "id" }, 400);
  const p = clean(body.profile || {});
  if (!p.nick) return json({ error: "nick" }, 400);
  const h = await sha(id + ":" + sec);
  const old = await store.get("p/" + id, { type: "json" });
  if (old && old.h !== h) return json({ error: "owner" }, 403);
  if (old && Date.now() - (old.last || 0) < MIN_GAP_MS && old.nick === p.nick && old.floor === p.floor && old.cp === p.cp) {
    const b = await store.get(KEY, { type: "json" });
    return json(view(b || { p: { [id]: old } }, id));
  }
  // kiểm tra hợp lý: mỗi trận tháp tốn 1 năng lượng (hồi 1 điểm/10 phút, tối đa 10, thêm vài nguồn thưởng),
  // nên số tầng/cấp tăng được bị giới hạn theo thời gian thực (kiểu "xô hạn mức" tự đầy dần).
  // Vượt quá → chỉ ghi nhận đến mức hợp lý. Người chơi bình thường không bao giờ chạm giới hạn này.
  const now = Date.now();
  const F_CAP = 22, F_RATE = 8, L_CAP = 16, L_RATE = 6;
  let fb, lb;
  if (old) {
    const hrs = Math.max(0, (now - (old.last || now)) / 3_600_000);
    fb = Math.min(F_CAP, (old.fb ?? F_CAP) + hrs * F_RATE);
    lb = Math.min(L_CAP, (old.lb ?? L_CAP) + hrs * L_RATE);
    const df = p.floor - (old.floor || 0), dl = p.lv - (old.lv || 1);
    if (df > fb) { p.floor = (old.floor || 0) + Math.floor(fb); p.floorT = now; }
    if (dl > lb) p.lv = (old.lv || 1) + Math.floor(lb);
    fb -= Math.max(0, p.floor - (old.floor || 0));
    lb -= Math.max(0, p.lv - (old.lv || 1));
    if (old.tm && !(p.floor <= 2 && p.lv <= 5)) p.tm = 1; // đã bị đánh dấu thì giữ, trừ khi chơi lại từ đầu
  } else {
    if (p.floor > 40) { p.floor = 40; p.floorT = now; }
    if (p.lv > 60) p.lv = 60;
    fb = Math.max(0, F_CAP - p.floor); lb = Math.max(0, L_CAP - p.lv / 4);
  }
  const entry = { ...p, h, last: now, fb: Math.round(fb * 100) / 100, lb: Math.round(lb * 100) / 100 };
  await store.setJSON("p/" + id, entry);
  const board = await mergeBoard(store, id, entry);
  return json(view(board, id));
};
