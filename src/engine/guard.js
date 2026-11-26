// 防封号护栏：全局限速、冷却、失败退避、话术轮换
// 状态落在 data 的 guard 键里，重启后仍然生效（不会被频繁重启绕过）
const RISK_RE = /验证码|安全验证|滑块|拖动|人机验证|操作过于频繁|账号异常|请完成验证|异常登录|访问受限/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hourKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${dayKey(ts)}-${pad(d.getHours())}`;
}

function blank() {
  return { day: dayKey(), hour: hourKey(), dayCount: { message: 0, apply: 0 }, hourCount: { message: 0, apply: 0 }, coolUntil: 0, trips: [], failStreak: 0, variants: {} };
}

function load(store) {
  const raw = store.get('guard') || {};
  const base = blank();
  const g = { ...base, ...raw };
  // 跨小时/跨天自动归零
  if (g.hour !== hourKey()) {
    g.hour = hourKey();
    g.hourCount = { message: 0, apply: 0 };
  }
  if (g.day !== dayKey()) {
    g.day = dayKey();
    g.dayCount = { message: 0, apply: 0 };
  }
  g.dayCount = { message: 0, apply: 0, ...(g.dayCount || {}) };
  g.hourCount = { message: 0, apply: 0, ...(g.hourCount || {}) };
  if (!Array.isArray(g.trips)) g.trips = [];
  if (!g.variants) g.variants = {};
  return g;
}

function save(store, g) {
  store.set('guard', g);
}

// 每日上限按“当天”固定浮动 ±15%，同一天内多次调用不会变，别让人一天一个样
function dailyLimit(settings, kind) {
  const base = kind === 'apply' ? Number(settings.dailyCap || 40) : Number(settings.msgDailyCap || 30);
  const dk = `${dayKey()}_${kind}`;
  let h = 0;
  for (let i = 0; i < dk.length; i += 1) h = (h * 31 + dk.charCodeAt(i)) % 1000;
  const f = 0.85 + (h % 30) / 100; // 0.85 ~ 1.14
  return Math.max(1, Math.round(base * f));
}

function hourlyLimit(settings, kind) {
  return kind === 'apply' ? Number(settings.applyPerHour || 6) : Number(settings.msgPerHour || 8);
}

function cooling(store, now = Date.now()) {
  const g = load(store);
  const remain = Math.max(0, Number(g.coolUntil || 0) - now);
  return { cooling: remain > 0, remainMs: remain, remainMin: Math.ceil(remain / 60000), until: g.coolUntil || 0 };
}

// 能不能再做一次动作
function allow(store, settings, kind = 'message') {
  const now = Date.now();
  const g = load(store);
  if (g.coolUntil && now < g.coolUntil) {
    return { ok: false, reason: `风控冷却中，还剩 ${Math.ceil((g.coolUntil - now) / 60000)} 分钟`, cooling: true };
  }
  if (g.dayCount[kind] >= dailyLimit(settings, kind)) return { ok: false, reason: `${kind} 今日额度已用完` };
  if (g.hourCount[kind] >= hourlyLimit(settings, kind)) return { ok: false, reason: `${kind} 本小时额度已用完` };
  return { ok: true, dayUsed: g.dayCount[kind], dayCap: dailyLimit(settings, kind), hourUsed: g.hourCount[kind] };
}

function record(store, kind = 'message') {
  const g = load(store);
  g.dayCount[kind] = (g.dayCount[kind] || 0) + 1;
  g.hourCount[kind] = (g.hourCount[kind] || 0) + 1;
  g.lastAt = Date.now();
  save(store, g);
}

function trip(store, { reason = '', minutes } = {}) {
  const g = load(store);
  const prev = g.trips.filter((t) => Date.now() - t.at < 24 * 3600 * 1000).length;
  const wait = Number(minutes || (prev >= 1 ? 1440 : 360)); // 第一次 6 小时，24 小时内再犯 24 小时
  g.coolUntil = Date.now() + wait * 60000;
  g.trips.push({ at: Date.now(), reason: String(reason).slice(0, 120), waitMin: wait });
  g.trips = g.trips.slice(-20);
  save(store, g);
  return { coolUntil: g.coolUntil, waitMin: wait };
}

function success(store) {
  const g = load(store);
  g.failStreak = 0;
  save(store, g);
}

// 连续失败 5 次自动冷却 2 小时，多半是页面改版或被风控
function fail(store, settings, reason = '') {
  const g = load(store);
  g.failStreak = Number(g.failStreak || 0) + 1;
  save(store, g);
  if (g.failStreak >= 5) {
    const r = trip(store, { reason: `连续失败 5 次：${reason}`, minutes: 120 });
    // trip() 内部会重新 load + save，写进 coolUntil/trips。
    // 这里必须重新读一次再清零，否则用旧快照 save 会把冷却状态覆盖掉。
    const fresh = load(store);
    fresh.failStreak = 0;
    save(store, fresh);
    return { tripped: true, ...r };
  }
  return { tripped: false, failStreak: g.failStreak };
}

function detect(text) {
  const hit = String(text || '').match(RISK_RE);
  return hit ? { risk: true, signal: hit[0] } : { risk: false };
}

// 话术轮换：同一条规则准备多句时轮流用，别每次都一模一样
function nextVariant(store, key, total) {
  const g = load(store);
  const n = Math.max(1, Number(total || 1));
  const i = Number(g.variants[key] || 0) % n;
  g.variants[key] = (i + 1) % n;
  save(store, g);
  return i;
}

// 动作间隔：消息比投递更密，都带随机
function gap(settings, kind = 'message') {
  if (kind === 'apply') {
    const base = Number(settings.applyIntervalMs || 24000);
    return Math.round(base * (0.8 + Math.random() * 0.6));
  }
  const base = Number(settings.msgIntervalMs || 6000);
  return Math.round(base * (0.7 + Math.random() * 0.8));
}

module.exports = { load, save, allow, record, trip, success, fail, cooling, detect, nextVariant, gap, dayKey, hourKey };
