// 六维加权匹配评分（技能/经验/关键词/项目/学历/薪资）+ 负面信号扣分，权重可配。
const { DEGREES } = require('./parse');

const DEFAULT_WEIGHTS = { skill: 0.3, experience: 0.2, keyword: 0.15, project: 0.2, education: 0.1, salary: 0.05 };
const NON_SKILL_TAG = /本科|大专|硕士|博士|中专|高中|\d+\s*[-~]\s*\d+\s*年|\d+\s*年|应届|五险|双休|年终|提成|补助|奖金|薪|节假|包吃|包住|住宿|体检|培训|晋升|弹性|周末|法定|全勤|试用|绩效|出差|加班|上市|国企|外资|民营|合资|港澳台|学历|经验|不限/;

function nrm(s) {
  return String(s || '').toLowerCase().replace(/[\s\u00a0]/g, '');
}

function eduRank(text) {
  const idx = DEGREES.indexOf(String(text || '').trim());
  return idx < 0 ? 0 : DEGREES.length - idx;
}

function salaryRange(text) {
  const t = String(text || '');
  const unitOf = (u) => (u === '万' ? 10 : u === '元' ? 0.001 : 1);
  const m = /(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*([kK万]|元)?/.exec(t);
  if (m) {
    const unit = unitOf(m[3] || (/\d+\s*万/.test(t) ? '万' : 'k'));
    return [parseFloat(m[1]) * unit, parseFloat(m[2]) * unit];
  }
  const single = /(\d+(?:\.\d+)?)\s*([kK万]|元)/.exec(t);
  if (!single) return null;
  const v = parseFloat(single[1]) * unitOf(single[2]);
  return [v, v];
}

function jobSkills(job) {
  const tags = Array.isArray(job.tags) ? job.tags : String(job.tags || '').split(/[\s/、,，]+/);
  return [...new Set(tags.map((t) => String(t).trim()).filter((t) => t && !NON_SKILL_TAG.test(t)))];
}

function jobKeywords(job) {
  const titleTokens = String(job.title || '').split(/[\s/、,，（）()·—-]+/).filter((t) => t.length >= 2 && !/招聘|急招|双休|应届/.test(t));
  return [...new Set([...jobSkills(job), ...titleTokens])];
}

function jobYears(job) {
  const text = `${job.title || ''} ${(job.tags || []).join(' ')}`;
  const range = /(\d+)\s*[-~]\s*(\d+)\s*年/.exec(text);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = /(\d+)\s*年/.exec(text);
  return single ? [Number(single[1]), Number(single[1])] : null;
}

function resumePenalty(parsed, raw) {
  const items = [];
  let total = 0;
  const now = 2026 * 12 + 11;

  const recent = (parsed.experiences || []).filter((e) => e.start != null && now - e.start <= 36);
  const shortJobs = recent.filter((e) => e.months != null && e.months < 12);
  if (recent.length >= 3 && shortJobs.length >= 1) {
    items.push({ signal: '频繁跳槽', detail: `近 3 年 ${recent.length} 份工作，${shortJobs.length} 份不足 12 个月`, penalty: -10 });
    total -= 10;
  }

  const sorted = [...(parsed.experiences || [])].filter((e) => e.start != null).sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = sorted[i - 1].end;
    if (prevEnd == null || prevEnd === Infinity) continue;
    const gap = sorted[i].start - prevEnd;
    if (gap >= 6) {
      items.push({ signal: '空窗期', detail: `${sorted[i - 1].company} 与 ${sorted[i].company} 之间约 ${gap} 个月无记录`, penalty: -8 });
      total -= 8;
      break;
    }
  }

  if (/外包|劳务派遣/.test(raw)) {
    items.push({ signal: '外包/派遣标记', detail: '简历正文出现"外包/派遣"字样', penalty: -15 });
    total -= 15;
  }

  const bulletCount = (parsed.experiences || []).reduce((n, e) => n + (e.bullets || []).length, 0);
  const bulletText = (parsed.experiences || []).flatMap((e) => e.bullets || []).join(' ');
  const metricBullets = (parsed.experiences || []).flatMap((e) => e.bullets || []).filter((b) => /\d/.test(b)).length;
  if (bulletCount < 3 || metricBullets === 0) {
    items.push({ signal: '简历模板化', detail: `量化要点 ${metricBullets}/${bulletCount} 条`, penalty: -8 });
    total -= 8;
  }

  return { total: Math.min(0, total), items };
}

function buildCtx(resume, requirement, opts = {}) {
  const raw = String(resume.raw || '');
  const { parseResume } = require('./parse');
  const parsed = resume.parsed || parseResume(raw);
  const intentSalary = salaryRange(parsed.intent?.salary || requirement.salaryText || '');
  return {
    parsed,
    raw,
    rawNorm: nrm(raw),
    requirement: requirement || {},
    expected: intentSalary,
    penalty: resumePenalty(parsed, raw),
    opts,
  };
}

function scoreJD(job, ctx, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.opts?.weights || {}), ...(opts.weights || {}) };
  const subs = {};
  const reasons = [];
  const kws = jobKeywords(job);
  const skills = jobSkills(job);
  const jdText = nrm([job.title, ...(job.tags || []), job.company, job.location].join(' '));

  // 1 技能覆盖
  if (skills.length) {
    const covered = skills.filter((s) => ctx.rawNorm.includes(nrm(s)));
    subs.skill = Math.round((covered.length / skills.length) * 100);
    if (covered.length) reasons.push(`技能命中 ${covered.length}/${skills.length}：${covered.slice(0, 6).join('、')}`);
    const missing = skills.filter((s) => !covered.includes(s));
    if (missing.length) reasons.push(`缺口：${missing.slice(0, 6).join('、')}`);
  } else {
    const covered = kws.filter((k) => ctx.rawNorm.includes(nrm(k)));
    subs.skill = kws.length ? Math.round((covered.length / kws.length) * 100) : 50;
  }

  // 2 经验对标
  let expScore = 0;
  const yrs = jobYears(job);
  const myYears = Number(ctx.parsed.totalYears || 0);
  if (yrs) {
    if (myYears >= yrs[0]) expScore += 40;
    else expScore += Math.max(0, Math.round((40 * myYears) / Math.max(1, yrs[0])));
    if (myYears < yrs[0]) reasons.push(`要求 ${yrs[0]}-${yrs[1]} 年，你 ${myYears} 年`);
    else if (yrs[1] && myYears > yrs[1] + 5) reasons.push(`岗位上限 ${yrs[1]} 年，你可能偏资深`);
  } else expScore += 20;
  const indHit = (ctx.parsed.industries || []).filter((ind) => jdText.includes(nrm(ind)));
  if (indHit.length) { expScore += 30; reasons.push(`同行业：${indHit[0]}`); }
  else if (ctx.parsed.industries?.length) expScore += 10;
  const isMgr = /经理|主管|总监|负责人/.test(job.title || '');
  const wasMgr = (ctx.parsed.experiences || []).some((e) => /经理|主管|总监|负责人/.test(e.title || ''));
  if (isMgr && wasMgr) { expScore += 25; reasons.push('有同级管理经历'); }
  else if (isMgr && !wasMgr) expScore += 8;
  else expScore += 20;
  subs.experience = Math.min(100, expScore);

  // 3 关键词密度
  const kwTotal = kws.length || 1;
  const kwHit = kws.filter((k) => ctx.rawNorm.includes(nrm(k)));
  subs.keyword = Math.round((kwHit.length / kwTotal) * 100);

  // 4 项目相关度（无向量，用关键词重合做近似）
  const projects = ctx.parsed.projects || [];
  let bestProj = 0;
  let bestName = '';
  for (const p of projects) {
    const pn = nrm(p.text);
    const hit = kws.filter((k) => pn.includes(nrm(k))).length;
    const sim = kws.length ? hit / kws.length : 0;
    if (sim > bestProj) { bestProj = sim; bestName = p.name; }
  }
  subs.project = Math.round(Math.min(1, bestProj) * 100);
  if (bestProj > 0) reasons.push(`最相关项目：${bestName}`);

  // 5 学历
  const needEdu = (job.tags || []).find((t) => DEGREES.includes(String(t).trim()));
  const myEdu = ctx.parsed.educationLevel;
  if (needEdu && myEdu) {
    const a = eduRank(needEdu);
    const b = eduRank(myEdu);
    subs.education = b >= a ? 100 : Math.max(0, 100 - (a - b) * 30);
    if (b < a) reasons.push(`学历要求 ${needEdu}，你是 ${myEdu}`);
  } else subs.education = 70;

  // 6 薪资
  const jobSal = salaryRange(job.salary);
  const expSal = ctx.expected || [0, 0];
  if (jobSal && expSal[0]) {
    if (jobSal[0] >= expSal[0] * 0.9) subs.salary = 100;
    else if (jobSal[1] >= expSal[0]) subs.salary = 80;
    else subs.salary = Math.max(20, Math.round((jobSal[0] / expSal[0]) * 70));
    if (jobSal[0] < expSal[0] * 0.9) reasons.push(`薪资 ${job.salary} 低于期望 ${ctx.parsed.intent?.salary || ''}`);
  } else subs.salary = 60;

  const hardGate = Boolean(opts.hardGate ?? ctx.opts?.hardGate);
  const hardBlocked = hardGate && skills.length > 3 && subs.skill < 100;

  let score = 0;
  for (const [k, w] of Object.entries(weights)) score += (subs[k] || 0) * w;
  score += ctx.penalty.total;

  // 7 偏好贴合：出差强度、自驾、管理岗（来自求职需求里用户自己的话）
  let prefDelta = 0;
  try {
    const { scoreAgainstPrefs } = require('./intent');
    const pref = scoreAgainstPrefs(job, ctx.requirement?.prefs || {});
    prefDelta = pref.delta;
    if (pref.reasons.length) reasons.push(...pref.reasons);
  } catch (e) {
    prefDelta = 0;
  }
  score += prefDelta;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    subscores: subs,
    prefDelta,
    penalty: ctx.penalty.total,
    penaltyItems: ctx.penalty.items,
    reasons,
    hardBlocked,
    keywords: kws,
  };
}

function rankJobs(jobs, ctx, opts = {}) {
  return jobs
    .map((job) => ({ ...job, ...scoreJD(job, ctx, opts) }))
    .sort((a, b) => b.score - a.score);
}

module.exports = { DEFAULT_WEIGHTS, scoreJD, rankJobs, buildCtx, jobKeywords, jobSkills, jobYears, resumePenalty, salaryRange };
