// 规则六维分只做粗排，模型读 JD 做全量语义精排（可解释、可缓存、可换路由）
// 免费接口有频控，所以：批量判断（一次 6 个岗位）+ 多路由轮换（FreeLLMAPI → OFM → g4f）+ 3 天缓存
const fs = require('fs');
const path = require('path');
const llm = require('./llm');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'matchCache.json');
const CACHE_TTL = 3 * 86400000;
const BATCH_SIZE = 3;
const PARALLEL = 2;
const MAX_JOBS = 60;

// 备用路由：主路由 429 时换一条同局域网的免费服务，避免整轮投递干等
const EXTRA_ROUTES = [
  {
    enabled: true,
    provider: 'ofm',
    baseUrl: 'http://127.0.0.1:18901/v1',
    model: 'combo:auto-failover',
    apiKey: 'YOUR_OFM_KEY',
    fallback: false,
    timeoutMs: 60000,
  },
  {
    enabled: true,
    provider: 'g4f',
    baseUrl: 'http://127.0.0.1:1337/v1',
    model: 'glm-5.3-flash',
    fallback: false,
    timeoutMs: 90000,
  },
];

function routesFor(llmCfg) {
  const primary = { ...llmCfg, fallback: false };
  const [ofm, g4f] = EXTRA_ROUTES;
  // 免费主路由经常 429，先用 OFM 兜住，再回主路由，最后 g4f
  return [ofm, primary, g4f];
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    /* 缓存失败不影响主流程 */
  }
}

function cacheKey(job) {
  return `${job.company || ''}｜${job.title || ''}`.replace(/\s+/g, '');
}

function summarizeResume(resume, parsed) {
  const text = String(resume.optimized || resume.raw || '').replace(/\s+/g, ' ').slice(0, 260);
  const exps = (parsed.experiences || [])
    .slice(0, 3)
    .map((e) => `${e.dates} ${e.company} ${e.title}`)
    .join('；');
  return `${text}\n【经历】${exps}`.trim();
}

function requirementBrief(requirement, parsed) {
  const p = requirement.prefs || {};
  return [
    `目标岗位：${requirement.title || parsed.intent?.title || p.role || ''}`,
    `目标城市：${requirement.city || p.city || parsed.city || ''}`,
    `期望薪资：${requirement.salaryText || parsed.intent?.salary || ''}`,
    p.travelDays != null ? `出差强度：一年约 ${p.travelDays} 天` : '',
    p.selfDrive ? '希望自驾跑，认可车补/私车公用' : '',
    p.management === true ? '要管理岗/带团队' : p.management === false ? '不带人，做个人贡献' : '',
    p.excludes && p.excludes.length ? `明确不要：${p.excludes.join('、')}` : '',
    `补充要求：${String(requirement.text || '').slice(0, 100)}`,
  ].filter(Boolean).join('；');
}

const SYSTEM = '你是求职顾问，站在候选人立场判断岗位值不值得投。看：职责与真实经历重合度、行业与客户类型、职级（做过区域销售经理/渠道销售，不是纯执行也不是集团总监）、薪资是否覆盖期望、地点是否在广州或可外勤、是否快递/外卖/保险/保健品/匿名电销、JD 是否有坑（挂销售名做电销、纯提成无底薪、要求自带资源、长期驻外）。只输出 JSON 数组，不要解释。';

function jobLine(job, idx) {
  return JSON.stringify({
    i: idx,
    t: job.title || '',
    c: job.company || '',
    s: job.salary || '',
    l: job.location || '',
    g: (job.tags || []).join('、'),
    d: String(job.detail || '').slice(0, 200),
  });
}

function parseJsonArray(text) {
  const i = text.indexOf('[');
  const j = text.lastIndexOf(']');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(text.slice(i, j + 1));
  } catch (e) {
    return null;
  }
}

function normalizeVerdict(v, score) {
  if (['fit', 'maybe', 'no'].includes(v)) return v;
  return score >= 60 ? 'maybe' : 'no';
}

async function chatWithRoutes(messages, options) {
  let lastErr = null;
  for (const route of routesFor(options.llmCfg)) {
    try {
      return await llm.chat(route, messages, options.chat || {});
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('模型都不可用');
}

// 一次问一批岗位，返回与输入等长的结果数组；数量对不上或解析失败就整批退回单条判断
async function judgeBatch({ jobs, resumeText, reqBrief, llmCfg, retryOne }) {
  const user = [
    '候选人：',
    resumeText,
    '诉求：' + reqBrief,
    '',
    `要判断的岗位（共 ${jobs.length} 个，i 是编号）：`,
    jobs.map((job, idx) => jobLine(job, idx + 1)).join('\n'),
    '',
    '每个岗位输出一个对象：{"i":编号,"score":0-100,"verdict":"fit|maybe|no","reason":"20字内","gaps":["最多2条"]}',
    '80+高度匹配、60-79可投、40-59边缘、40以下不投；快递/外卖/保险/保健品/匿名公司电销直接 no+10分。',
    '只输出 JSON 数组，数量必须与输入相同。',
  ].join('\n');
  const raw = await chatWithRoutes(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    { llmCfg, chat: { maxTokens: 150 + jobs.length * 60, temperature: 0.2, timeoutMs: 45000 } },
  );
  const arr = parseJsonArray(String(raw || ''));
  if (!arr || arr.length !== jobs.length) throw new Error('批量判断返回条数不符');
  return arr.map((item) => {
    const score = Math.max(0, Math.min(100, Math.round(Number(item.score) || 0)));
    return {
      llmScore: score,
      verdict: normalizeVerdict(item.verdict, score),
      reason: String(item.reason || '').slice(0, 40),
      gaps: Array.isArray(item.gaps) ? item.gaps.slice(0, 2).map((g) => String(g).slice(0, 20)) : [],
    };
  });
}

async function judgeOne(llmCfg, { job, resumeText, reqBrief }) {
  const user = [
    '候选人：',
    resumeText,
    '诉求：' + reqBrief,
    '',
    '岗位：',
    `${job.title || ''} | ${job.company || ''} | ${job.salary || ''} | ${job.location || ''}`,
    `标签：${(job.tags || []).join('、')}`,
    job.detail ? `正文：${String(job.detail).slice(0, 300)}` : '',
    '',
    '输出 JSON：{"score":0-100,"verdict":"fit|maybe|no","reason":"20字内","gaps":["最多2条"]}',
    '80+高度匹配、60-79可投、40-59边缘、40以下不投；快递/外卖/保险/保健品/匿名公司电销直接 no+10分。',
  ].filter(Boolean).join('\n');
  const raw = await chatWithRoutes(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    { llmCfg, chat: { maxTokens: 120, temperature: 0.2, timeoutMs: 30000 } },
  );
  const text = String(raw || '');
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('模型没有返回 JSON');
  const data = JSON.parse(text.slice(i, j + 1));
  const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
  return {
    llmScore: score,
    verdict: normalizeVerdict(data.verdict, score),
    reason: String(data.reason || '').slice(0, 40),
    gaps: Array.isArray(data.gaps) ? data.gaps.slice(0, 2).map((g) => String(g).slice(0, 20)) : [],
  };
}

// 全量精排：默认对本次抓到的所有岗位都判断，批量 + 缓存 + 路由轮换
async function rerank({ jobs, resume, parsed, requirement, llmCfg, logger, limit = MAX_JOBS, budgetMs = 240000 }) {
  if (!llm.ready(llmCfg) || !jobs.length) return { jobs, llmUsed: false, failed: 0, skipped: jobs.length };
  const resumeText = summarizeResume(resume, parsed);
  const reqBrief = requirementBrief(requirement, parsed);
  const cache = loadCache();
  const out = [];
  const pending = [];
  let cachedCount = 0;

  for (const job of jobs.slice(0, Math.max(limit, 1))) {
    const key = cacheKey(job);
    const hit = cache[key];
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      out.push({ ...job, ...hit.value, cached: true });
      cachedCount += 1;
    } else {
      pending.push(job);
    }
  }
  for (const job of jobs.slice(Math.max(limit, 1))) {
    out.push({ ...job, llmScore: null, verdict: 'maybe', reason: '', gaps: [] });
  }

  let judged = 0;
  let failed = 0;
  let skipped = 0;
  const deadline = Date.now() + Math.max(30000, budgetMs);
  // 规则分高的先让模型看：时间不够时，把模型判断留给最值得的岗位
  pending.sort((a, b) => (b.score || 0) - (a.score || 0));
  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));

  const runBatch = async (batch) => {
    if (Date.now() > deadline) {
      skipped += batch.length;
      batch.forEach((job) => out.push({ ...job, llmScore: null, verdict: 'maybe', reason: '', gaps: [], deferred: true }));
      return;
    }
    try {
      const rs = await judgeBatch({ jobs: batch, resumeText, reqBrief, llmCfg });
      batch.forEach((job, k) => {
        cache[cacheKey(job)] = { at: Date.now(), value: rs[k] };
        out.push({ ...job, ...rs[k] });
        judged += 1;
      });
    } catch (err) {
      logger?.warn('match', '批量判断失败，改单条判断', { msg: err.message.slice(0, 80) });
      for (const job of batch) {
        try {
          const r = await judgeOne(llmCfg, { job, resumeText, reqBrief });
          cache[cacheKey(job)] = { at: Date.now(), value: r };
          out.push({ ...job, ...r });
          judged += 1;
        } catch (err2) {
          failed += 1;
          logger?.warn('match', '模型判断岗位失败，保留规则分', { title: job.title, msg: err2.message.slice(0, 80) });
          out.push({ ...job, llmScore: null, verdict: 'maybe', reason: '', gaps: [] });
        }
      }
    }
  };

  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      await runBatch(batch);
    }
  }));
  saveCache(cache);

  const merged = out
    .map((job) => {
      const finalScore = job.llmScore == null ? job.score : Math.round(job.score * 0.45 + job.llmScore * 0.55);
      return { ...job, finalScore };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
  return { jobs: merged, llmUsed: judged > 0, failed, judged, cached: cachedCount, deferred: skipped };
}

function blockedByModel(job) {
  return job.verdict === 'no' && job.llmScore != null && job.llmScore < 40;
}

module.exports = { rerank, judgeOne, judgeBatch, blockedByModel };
