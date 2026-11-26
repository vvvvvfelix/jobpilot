// 真实线上应聘的"该不该投"判断：黑名单、猎头、重复、薪资、配额、风控
const HEADHUNTER_RE = /猎头|人力资源服务|人才服务|劳务派遣|人力外包|岗位外包|中介机构/;
const RISK_RE = /验证码|安全验证|滑块|拖动|人机验证|操作过于频繁|账号异常|请完成验证/;

// 用户明确不要的岗位类型
const TYPE_EXCLUDE = [
  { re: /快递|收派员|派件员|揽件员|快递员/, reason: '快递岗' },
  { re: /外卖|骑手|送餐|跑腿|同城配送员/, reason: '外卖/骑手岗' },
  { re: /保险|寿险|财险|续保|保险代理|保险经纪|保险顾问/, reason: '保险岗' },
  { re: /保健品|保健食品|保健用品|营养品会销/, reason: '保健品岗' },
];
const PHONE_SALES_RE = /电话销售|电销|电话营销|电话邀约|话务员|外呼/;
const ANON_COMPANY_RE = /^某|某(公司|集团|科技|企业|大型公司|上市公司)|保密|未公开|不详|(大型|上市|知名|优质)公司$/;

function splitList(text) {
  return String(text || '')
    .split(/\n|,|，|;|；/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function jobKey(job) {
  return `${(job.title || '').trim()}|${(job.company || '').trim()}`;
}

function salaryRangeK(text) {
  const t = String(text || '');
  const range = t.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*(k|K|万|千|元)/);
  if (range) {
    const unit = range[3];
    const mul = unit === '万' ? 10 : unit === '元' ? 0.001 : 1;
    return [Number(range[1]) * mul, Number(range[2]) * mul];
  }
  const single = t.match(/(\d+(?:\.\d+)?)\s*(k|K|万|千)/);
  if (single) {
    const mul = single[2] === '万' ? 10 : 1;
    return [Number(single[1]) * mul, Number(single[1]) * mul];
  }
  return null;
}

function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayAppliedCount(history) {
  const today = dayKey(Date.now());
  return (history?.applied || []).filter((a) => dayKey(a.ts) === today).length;
}

function evaluateJob(job, ctx) {
  const settings = ctx.settings || {};
  const requirement = ctx.requirement || {};
  const history = ctx.history || { applied: [] };
  const reasons = [];

  const blacklist = splitList(settings.blacklist);
  if (blacklist.some((b) => (job.company || '').includes(b))) reasons.push(`黑名单：${job.company}`);

  const tagText = `${(job.tags || []).join(' ')} ${job.company || ''} ${job.title || ''}`;
  if (settings.excludeHeadhunter !== false && HEADHUNTER_RE.test(tagText)) reasons.push('猎头/中介/外包岗');

  // 硬性类型过滤：快递、外卖骑手、保险、保健品
  for (const t of TYPE_EXCLUDE) {
    if (t.re.test(tagText)) reasons.push(`不要的岗位类型：${t.reason}`);
  }
  // 没有公司具体信息的电话销售
  if (PHONE_SALES_RE.test(tagText) && ANON_COMPANY_RE.test(String(job.company || '').trim())) {
    reasons.push(`电话销售且公司信息不透明：${job.company || '未写公司'}`);
  }

  const key = jobKey(job);
  if ((history.applied || []).some((a) => a.key === key)) reasons.push('之前已投过');

  const minK = Number(requirement.salaryMin || 0) / 1000;
  const range = salaryRangeK(job.salary);
  if (minK && range && range[1] < minK) reasons.push(`薪资上限 ${range[1].toFixed(0)}k < 期望 ${minK}k`);

  const text = `${job.title} ${(job.tags || []).join(' ')}`;
  if (/实习|在校|应届生优先|兼职/.test(text) && Number(ctx.resume?.years || 0) >= 2) {
    reasons.push('实习/兼职岗，和你年限不匹配');
  }

  return { key, blocked: reasons.length > 0, reasons };
}

function planRun(jobs, ctx) {
  const settings = ctx.settings || {};
  const dailyCap = Number(settings.dailyCap || 40);
  const used = todayAppliedCount(ctx.history);
  const remaining = Math.max(0, dailyCap - used);

  const allowed = [];
  const blocked = [];
  for (const job of jobs) {
    const verdict = evaluateJob(job, ctx);
    if (verdict.blocked) blocked.push({ ...job, blockReasons: verdict.reasons, key: verdict.key });
    else allowed.push({ ...job, key: verdict.key });
  }

  return {
    allowed,
    blocked,
    quota: { dailyCap, used, remaining, overQuota: remaining === 0 },
    plan: allowed.slice(0, Math.min(remaining, Number(settings.maxApplyPerRun || 10))),
  };
}

function jitterInterval(baseMs, ratio = 0.35) {
  const base = Math.max(2000, Number(baseMs || 12000));
  const low = base * (1 - ratio);
  const high = base * (1 + ratio);
  return Math.round(low + Math.random() * (high - low));
}

function detectRisk(text) {
  const body = String(text || '');
  const hit = body.match(RISK_RE);
  return hit ? { risk: true, signal: hit[0] } : { risk: false };
}

module.exports = { jobKey, salaryRangeK, todayAppliedCount, evaluateJob, planRun, jitterInterval, detectRisk, splitList };
