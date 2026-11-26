const knowledge = require('./knowledge');
const llm = require('./llm');

// 不刷职Q那种灌水：按“真问题”去搜公开文章/问答，再压缩成一条可用的职场认知
const TOPICS = [
  '销售总监 面试 常见问题 HR 考察点',
  'HR 问期望薪资 潜台词 怎么答 销售',
  'HR 主动要简历 说明什么 招聘流程',
  '猎头 看销售 区域经理 简历 看重什么',
  'B端销售 跳槽 简历 业绩 怎么写 不夸张',
  '面试 问离职原因 销售 怎么回答',
  '渠道销售 面试 问题 代理商 管理',
  '40岁 销售 求职 年龄 怎么应对 HR',
  '面试 追问 销售业绩 数据 怎么讲 真实',
  '面试 问 出差频率 长期驻外 怎么答',
  '销售 空窗期 面试 怎么解释',
  'HR 压薪资 offer 谈判 销售 话术',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const KEYS = /招聘|面试|HR|简历|薪资|职场|销售|渠道|客户|管理|离职|求职|跳槽|绩效|团队|候选人|老板|汇报|谈判|出差|年龄|空窗|offer/i;
const GOOD_DOMAIN = /(36kr\.com|jiemian\.com|sohu\.com|163\.com|sina\.com|sina\.cn|cmmo\.cn|mbalib\.com|liepin\.com|zhaopin\.com|huxiu\.com|iyiou\.com|ceconline\.com|zhihu\.com|douban\.com|cnblogs\.com|jianshu\.com)/i;

function decode(s = '') {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function toText(html = '') {
  return decode(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n'))
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim());
}

function extractLines(html = '') {
  return toText(html).filter((s) => s.length >= 12 && s.length <= 120 && KEYS.test(s));
}

async function fetchPage(url, timeoutMs = 18000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function bingLinks(html = '') {
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const out = [];
  for (const m of String(html).matchAll(re)) {
    const url = m[1];
    const title = decode(m[2].replace(/<[^>]+>/g, '')).trim();
    if (!/^https?:\/\//.test(url) || /bing\.com|microsoft\.com/.test(url)) continue;
    // 只要能真正打开的文章页，不要各站首页
    if (!/^https?:\/\/[^/]+\/.{8,}/.test(url)) continue;
    if (/\.(pdf|jpg|png|zip)$/i.test(url)) continue;
    out.push({ url, title });
  }
  return out.slice(0, 6);
}

// 摘要块：必应把搜索结果摘要放在 b_lineclamp / b_caption 里，比整页正文干净
function snippetLines(html = '') {
  const blocks = [];
  const re = /<(?:p|div)[^>]*class="[^"]*b_(?:lineclamp|caption)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/g;
  for (const m of String(html).matchAll(re)) {
    const t = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  }
  return blocks.filter(goodLine);
}

// 每次只在一个站内搜，避免“B端”这类词被 Bing 拆成 B 站
const SITE_POOL = ['zhihu.com', '36kr.com', 'jiemian.com', 'sohu.com', '163.com', 'liepin.com', 'zhaopin.com'];

function pickSite() {
  return SITE_POOL[Math.floor(Math.random() * SITE_POOL.length)];
}

function goodLine(s = '') {
  const t = String(s);
  if (t.length < 22 || t.length > 160) return false;
  if (/…|\.\.\./.test(t)) return false;
  if ((t.match(/[|｜]/g) || []).length >= 2) return false;
  if (/招聘_找工作|求职_企业招人|登录|注册|首页|下载APP|版权所有|ICP|客户端|导航/.test(t)) return false;
  return KEYS.test(t);
}

function pickTopic() {
  const db = knowledge.load();
  const used = (db.meta.topics || {});
  const fresh = TOPICS.filter((t) => !used[t] || Date.now() - new Date(used[t]).getTime() > 36 * 3600 * 1000);
  const pool = fresh.length ? fresh : TOPICS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function parseInsight(text, fallbackTitle) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    const data = JSON.parse(s.slice(i, j + 1));
    const points = (data.points || []).map((p) => String(p)).filter(Boolean).slice(0, 3);
    if (!points.length) return null;
    return { title: String(data.title || fallbackTitle).slice(0, 40), points, tags: data.tags || [] };
  } catch (e) {
    return null;
  }
}

async function summarize({ topic, lines, llmCfg }) {
  const sample = lines.slice(0, 12).join('\n');
  const messages = [
    { role: 'system', content: '你是销售总监的职场军师，只输出 JSON。' },
    {
      role: 'user',
      content: [
        `这次要弄清的问题：${topic}`,
        '公开资料摘录：',
        sample,
        '',
        '提炼一条对“40岁上下、B端销售/渠道、正在求职、要跟HR和老板周旋”真正有用的认知。',
        '只收真实、经得起追问的说法：资料里教包装、编造、堆数据的，一律改写成老实但有效的做法。',
        '不要收“报增长率/百分比/夸大规模”这类手里没数据支撑的建议。',
        '输出 {"title":"12字内主题","points":["第一点35字内","第二点35字内","第三点35字内"],"tags":["标签"]}',
        '要具体、能落地，别讲大道理。只输出 JSON。',
      ].join('\n'),
    },
  ];
  if (llm.ready(llmCfg)) {
    try {
      const raw = await llm.chatReliable(llmCfg, messages, { maxTokens: 220, temperature: 0.3, timeoutMs: 35000 });
      const hit = parseInsight(raw, topic);
      if (hit) return hit;
    } catch (e) {
      // 局域网路由常 429，下面换 Pollinations 慢速兜底
    }
    try {
      const raw = await llm.chat(
        { enabled: true, provider: 'pollinations', baseUrl: 'https://text.pollinations.ai/openai', model: 'openai', fallback: false },
        messages,
        { maxTokens: 220, temperature: 0.3, timeoutMs: 60000 },
      );
      const hit = parseInsight(raw, topic);
      if (hit) return hit;
    } catch (e) {
      // 都忙就退回原文摘句
    }
  }
  const picked = lines.filter(goodLine).slice(0, 3);
  return { title: topic.slice(0, 30), points: picked.length ? picked : lines.slice(0, 3), tags: ['摘录'] };
}

let queueCursor = 0;
let lastAt = 0;
let running = false;

async function tick({ llmCfg, logger, minGapMs = 30 * 60 * 1000 } = {}) {
  if (running) return { skipped: 'running' };
  if (Date.now() - lastAt < minGapMs) return { skipped: 'cooldown' };
  running = true;
  const topic = pickTopic();
  try {
    let pool = [];
    let article = null;
    let searchUrl = '';
    // 单站内搜索，抓不到就换一个站再试
    for (let attempt = 0; attempt < 2 && pool.length < 3; attempt += 1) {
      const site = pickSite();
      searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(`${topic} site:${site}`)}`;
      const searchHtml = await fetchPage(searchUrl);
      const links = bingLinks(searchHtml);
      const snippets = snippetLines(searchHtml);
      const lines = [...snippets, ...extractLines(searchHtml).filter((l) => l !== topic)].filter(goodLine);
      const candidate = links.find((l) => l.url.includes(site)) || links[0];
      let articleLines = [];
      if (candidate) {
        try {
          const html = await fetchPage(candidate.url, 15000);
          articleLines = toText(html).filter(goodLine);
          if (articleLines.length >= 3) article = candidate;
        } catch (e) {
          article = null;
        }
      }
      pool = (articleLines.length >= 3 ? articleLines : lines).slice(0, 12);
    }
    if (!pool.length) throw new Error('没有抓到可用内容');
    const s = await summarize({ topic, lines: pool, llmCfg });
    const item = knowledge.addItem({
      source: article ? (article.url.match(/https?:\/\/([^/]+)/) || [])[1] || '必应' : '必应摘要',
      url: article ? article.url : searchUrl,
      title: s.title,
      points: s.points,
      tags: s.tags,
    });
    knowledge.markTopic(topic);
    knowledge.markSource(topic.slice(0, 20));
    lastAt = Date.now();
    logger?.info('learn', '空闲学习完成', { topic, title: s.title, points: s.points.length, source: item?.source });
    return { ok: true, topic, item };
  } catch (err) {
    lastAt = Date.now();
    logger?.warn('learn', '空闲学习失败', { topic, msg: String(err.message).slice(0, 80) });
    return { ok: false, topic, error: String(err.message).slice(0, 80) };
  } finally {
    running = false;
  }
}

function isIdle(lastActiveAt = 0, idleMs = 10 * 60 * 1000) {
  return Date.now() - lastActiveAt > idleMs;
}

module.exports = { tick, isIdle, TOPICS, extractLines, fetchPage, bingLinks };
