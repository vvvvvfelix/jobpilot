const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'data', 'knowledge.json');
const CAP = 240;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(raw.items) ? raw.items : [], meta: raw.meta || {}, updatedAt: raw.updatedAt || null };
  } catch (e) {
    return { items: [], meta: {}, updatedAt: null };
  }
}

function save(db) {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
}

function hash(text = '') {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 2147483647;
  return `k_${h.toString(36)}`;
}

function addItem({ source, url, title, points = [], tags = [] }) {
  const db = load();
  const id = hash(url || `${source}:${title}`);
  const clean = points
    .map((p) => String(p || '').trim())
    // 不收入“报百分比/增长率”这类手里没数据支撑的建议
    .filter((p) => p && !/[%％]|增长率|增幅|翻倍/.test(p))
    .slice(0, 4);
  if (!clean.length) return null;
  const item = {
    id,
    source: String(source || '').slice(0, 40),
    url: String(url || '').slice(0, 300),
    title: String(title || '').slice(0, 120),
    points: clean.map((p) => p.slice(0, 160)),
    tags: tags.map((t) => String(t).slice(0, 12)).slice(0, 4),
    ts: new Date().toISOString(),
  };
  db.items = db.items.filter((it) => it.id !== id);
  db.items.push(item);
  db.items = db.items.slice(-CAP);
  db.updatedAt = item.ts;
  save(db);
  return item;
}

function markSource(name) {
  const db = load();
  db.meta.sources = db.meta.sources || {};
  db.meta.sources[name] = { lastAt: new Date().toISOString(), count: (db.meta.sources[name]?.count || 0) + 1 };
  save(db);
}

function markTopic(topic) {
  const db = load();
  db.meta.topics = db.meta.topics || {};
  db.meta.topics[topic] = new Date().toISOString();
  save(db);
}

function brief(max = 6) {
  const db = load();
  const items = db.items.slice(-max);
  if (!items.length) return '';
  return items
    .map((it) => `- ${it.title}：${it.points[0]}`)
    .join('\n');
}

function summary() {
  const db = load();
  return {
    count: db.items.length,
    updatedAt: db.updatedAt,
    sources: db.meta.sources || {},
    latest: db.items.slice(-12).reverse(),
  };
}

module.exports = { load, addItem, markSource, markTopic, brief, summary, FILE };
