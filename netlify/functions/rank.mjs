// Bảng Vàng Nuôi Bahi — lưu bằng Netlify Blobs
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/rank" };

// Mùa giải: tăng số này (cùng SEASON trong index.html) để mở mùa mới → kho dữ liệu mới bahi-…-s<mùa>, bản game cũ bị từ chối
const SEASON = 2;

const KEY = "board";
const NICK_MAX = 12;
const MIN_GAP_MS = 10_000; // chống gửi dồn dập
const clamp = (v, a, b, d = 0) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, Math.round(+v))) : d);
const str = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const json = (o, status = 200, extra) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra || {}) } });
// v58: bản công khai (top 10 + tin mới) được CDN Netlify giữ 3 giây → hàng trăm người cùng xem trực tiếp mà máy chủ chỉ chạy ~20 lần/phút
const PUB_CACHE = { "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, durable, s-maxage=3, stale-while-revalidate=5", "netlify-vary": "query=pub" };
const FEED_MAX = 20;

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

// lực chiến tối đa có thể đạt ở mỗi cấp (đo trong game: hình thái mạnh nhất + trang bị Thần Khí cấp sao tối đa), cộng 25% dư địa
function cpMax(lv) { return Math.round(CP_A + CP_B * lv); }
const CP_A = 12500, CP_B = 1900; // đo v51: tối đa ≈ 9.700 + 1.495 × cấp

function sorted(board, id) {
  // dữ liệu bị chỉnh sửa (tm) không lên bảng, chỉ chủ tài khoản thấy chính mình
  return Object.entries(board.p || {}).map(([k, e]) => ({ id: k, ...e })).filter((e) => !e.tm || e.id === id).sort(cmp);
}
function view(board, id) {
  const list = sorted(board, id);
  const pub = (e, i) => { const { h, last, first, id: pid, fb, lb, tm, cv, ...rest } = e; return { rank: i + 1, ...rest, me: pid === id }; };
  const top = list.slice(0, 10).map(pub);
  let me = null, ahead = null, behind = null;
  const i = id ? list.findIndex((e) => e.id === id) : -1;
  if (i >= 0) { me = pub(list[i], i); if (i > 0) ahead = pub(list[i - 1], i - 1); if (i + 1 < list.length) behind = pub(list[i + 1], i + 1); }
  return { top, me, ahead, behind, total: list.length, at: Date.now(), ver: board.ver || 0, feed: (board.feed || []).slice(0, 12) };
}
function pubView(board) {
  const list = sorted(board, null);
  const top = list.slice(0, 10).map((e, i) => { const { h, last, first, id, fb, lb, tm, cv, ...rest } = e; return { rank: i + 1, ...rest }; });
  return { top, total: list.length, at: Date.now(), ver: board.ver || 0, feed: (board.feed || []).slice(0, 12) };
}
// tin mới cho dải chạy chữ: ai vừa lên tầng, ai vừa vượt mặt ai (không lộ id, bỏ qua tài khoản bị đánh dấu)
function feedEvents(board, id, entry, old) {
  const ev = [];
  if (entry.tm) return ev;
  const of = old ? old.floor || 0 : 0;
  if (entry.floor > of) {
    const before = sorted(board, null), r0 = before.findIndex((e) => e.id === id);
    const after = sorted({ p: { ...board.p, [id]: entry } }, null), r1 = after.findIndex((e) => e.id === id);
    const t = Date.now();
    if (r1 >= 0 && (r0 < 0 || r1 < r0) && after[r1 + 1]) ev.push({ k: r1 === 0 ? "top1" : "pass", n: entry.nick, o: after[r1 + 1].nick, r: r1 + 1, f: entry.floor, t });
    else ev.push({ k: "up", n: entry.nick, f: entry.floor, r: r1 + 1, t });
  }
  return ev;
}

const REBUILD_MS = 5 * 60_000;
// mỗi người chơi lưu 1 khóa riêng (p/<id>) — không bao giờ mất dữ liệu khi ghi đồng thời;
// "board" chỉ là bản tổng hợp để đọc nhanh, tự dựng lại định kỳ từ các khóa riêng
async function rebuild(store, prev) {
  const { blobs } = await store.list({ prefix: "p/" });
  const p = {};
  await Promise.all(blobs.map(async (b) => { const e = await store.get(b.key, { type: "json" }); if (e) p[b.key.slice(2)] = e; }));
  if (!prev) prev = await store.get(KEY, { type: "json" }).catch(() => null);
  const board = { p, rebuilt: Date.now(), ver: ((prev && prev.ver) || 0) + 1, feed: (prev && prev.feed) || [] };
  await store.setJSON(KEY, board);
  return board;
}
async function mergeBoard(store, id, entry, old) {
  for (let tries = 0; tries < 5; tries++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    if (!cur) return rebuild(store);
    const board = cur.data;
    const ev = feedEvents(board, id, entry, old);
    board.p[id] = entry;
    board.ver = (board.ver || 0) + 1;
    if (ev.length) board.feed = ev.concat(board.feed || []).slice(0, FEED_MAX);
    const res = await store.setJSON(KEY, board, { onlyIfMatch: cur.etag });
    if (res.modified) return board;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  return rebuild(store);
}

export default async (req) => {
  const store = getStore({ name: "bahi-rank-s" + SEASON, consistency: "strong" });
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("t")) return json({ at: Date.now(), season: SEASON }); // giờ chuẩn cho game (chống chỉnh đồng hồ máy)
    let board = await store.get(KEY, { type: "json" });
    if (!board || Date.now() - (board.rebuilt || 0) > REBUILD_MS) board = await rebuild(store, board);
    if (url.searchParams.get("pub")) return json(pubView(board), 200, PUB_CACHE);
    const v = url.searchParams.get("v");
    if (v != null && +v === (board.ver || 0)) return json({ same: 1, ver: board.ver || 0, at: Date.now() }); // không có gì mới: trả gói rất nhẹ
    return json(view(board, str(url.searchParams.get("id"), 40)));
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  if (body.season !== SEASON) return json({ error: "season" }, 426); // bản game mùa cũ: không cho ghi vào mùa mới
  const id = str(body.id, 40), sec = str(body.secret, 80);
  if (!/^[a-z0-9]{12,40}$/.test(id) || sec.length < 16) return json({ error: "id" }, 400);
  const h = await sha(id + ":" + sec);
  // tuổi tài khoản do MÁY CHỦ ghi nhận (game "chào" máy chủ ngay lần mở đầu tiên, trước cả khi ghi danh)
  const acc = await store.get("a/" + id, { type: "json" });
  if (acc && acc.h !== h) return json({ error: "owner" }, 403);
  const now = Date.now();
  if (body.op === "hello") {
    if (!acc) await store.setJSON("a/" + id, { h, first: now });
    return json({ ok: true, at: now });
  }
  const p = clean(body.profile || {});
  if (!p.nick) return json({ error: "nick" }, 400);
  const old = await store.get("p/" + id, { type: "json" });
  if (old && old.h !== h) return json({ error: "owner" }, 403);
  if (old && now - (old.last || 0) < MIN_GAP_MS && old.nick === p.nick && old.floor === p.floor && old.cp === p.cp) {
    const b = await store.get(KEY, { type: "json" });
    return json(view(b || { p: { [id]: old } }, id));
  }
  const first = Math.min(acc ? acc.first : now, old && old.first ? old.first : now);
  if (!acc) await store.setJSON("a/" + id, { h, first });
  // KIỂM TRA HỢP LÝ (v58b — nới để KHÔNG BAO GIỜ cắt điểm người chơi thật).
  // Bản cũ giới hạn tầng = 12 + 2,5 × số ngày: người chơi thật đã lên tầng 35 sau ~4 ngày nhưng bị ghi 21 → sai.
  // Giới hạn vật lý thật: mỗi trận lên tối đa 1 tầng, năng lượng hồi 6 điểm/giờ (+ vật phẩm năng lượng tích trữ).
  // 1) "xô hạn mức" theo giờ: tầng chứa 30, hồi 8/giờ (> 6 năng lượng/giờ); cấp chứa 40, hồi 12/giờ
  // 2) trần theo tuổi tài khoản rất rộng: tầng 40 + 15 × ngày, cấp 50 + 25 × ngày (tài khoản giả vẫn cần ~4 ngày mới chạm tầng 100)
  // 3) lực chiến không vượt mức tối đa của cấp. Vượt quá → chỉ ghi đến mức hợp lý; lần đồng bộ sau tự ghi tiếp phần còn lại.
  const days = Math.max(0, (now - first) / 86_400_000);
  const F_AGE = Math.min(100, Math.floor(40 + 15 * days)), L_AGE = Math.floor(50 + 25 * days);
  const F_CAP = 30, F_RATE = 8, L_CAP = 40, L_RATE = 12;
  const of = old ? old.floor || 0 : 0, ol = old ? old.lv || 1 : 1;
  let fb = F_CAP, lb = L_CAP;
  if (old) {
    const hrs = Math.max(0, (now - (old.last || now)) / 3_600_000);
    const fresh = old.cv !== 2; // bản ghi từ trước v58b (đã bị cắt oan) → nạp đầy hạn mức để ghi đúng ngay lần đồng bộ đầu tiên
    fb = fresh ? F_CAP : Math.min(F_CAP, (old.fb ?? F_CAP) + hrs * F_RATE);
    lb = fresh ? L_CAP : Math.min(L_CAP, (old.lb ?? L_CAP) + hrs * L_RATE);
    if (p.floor - of > fb) p.floor = of + Math.floor(fb);
    if (p.lv - ol > lb) p.lv = ol + Math.floor(lb);
    fb -= Math.max(0, p.floor - of);
    lb -= Math.max(0, p.lv - ol);
    if (old.tm && !(p.floor <= 2 && p.lv <= 5)) p.tm = 1; // đã bị đánh dấu thì giữ, trừ khi chơi lại từ đầu
  }
  p.floor = Math.min(p.floor, Math.max(F_AGE, old ? of : 0));
  p.lv = Math.max(1, Math.min(p.lv, Math.max(L_AGE, old ? ol : 1)));
  p.cp = Math.min(p.cp, cpMax(p.lv));
  p.bosses = Math.min(p.bosses, Math.floor(p.floor / 10));
  p.done = p.floor >= 100 && p.done;
  p.best = Math.min(p.best, Math.ceil(60 * (days + 1)));
  if (p.pet) p.pet.lv = Math.min(p.pet.lv, p.lv + 5);
  // thời điểm đạt tầng do máy chủ ghi (không tin giờ của máy người chơi)
  p.floorT = old && p.floor <= of ? old.floorT || now : now;
  const entry = { ...p, h, first, last: now, cv: 2, fb: Math.round(fb * 100) / 100, lb: Math.round(lb * 100) / 100 };
  await store.setJSON("p/" + id, entry);
  const board = await mergeBoard(store, id, entry, old);
  return json(view(board, id));
};
