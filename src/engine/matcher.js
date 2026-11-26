const { findTerms, extractAll, LEVEL_TERMS } = require('./keywords');

const EDU_RANK = { 大专: 1, 本科: 2, 硕士: 3, 博士: 4, '中专': 0, '不限': 0 };

function eduRank(text) {
  const t = String(text || '');
  for (const [key, rank] of Object.entries(EDU_RANK)) if (t.includes(key)) return rank;
  return 0;
}

function yearsFromText(text) {
  const t = String(text || '');
  const range = t.match(/(\d+)\s*-\s*(\d+)\s*年/);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = t.match(/(\d+)\s*年/);
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
}

function scoreJob(job, ctx) {
  const title = String(job.title || '');
  const tagText = Array.isArray(job.tags) ? job.tags.join(' ') : String(job.tags || '');
  const allText = `${title} ${tagText} ${job.company || ''} ${job.location || ''}`;

  const targetSkills = new Set([
    ...findTerms(ctx.requirement?.text || ''),
    ...findTerms(ctx.resume?.raw || ''),
    ...findTerms(ctx.resume?.skills?.join(' ') || ''),
  ]);
  const jobSkills = findTerms(allText);

  // 需求原文按空格/顿号切词，避免词典没收录的岗位名（渠道销售、面销等）永远不命中
  const city = ctx.requirement?.city || '';
  const reqTokens = String(ctx.requirement?.text || '')
    .split(/[\s,，、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/^\d+(\.\d+)?([kK万]|-|$)/.test(s) && s !== city && !EDU_RANK[s]);
  const tokenHits = reqTokens.filter((t) => allText.includes(t));

  const hits = Array.from(new Set([...jobSkills.filter((s) => targetSkills.has(s)), ...tokenHits]));
  const gaps = jobSkills.filter((s) => !targetSkills.has(s));

  const titleHits = Array.from(new Set([
    ...[...targetSkills].filter((s) => title.includes(s)),
    ...reqTokens.filter((t) => title.includes(t)),
  ]));

  const weakTitle = reqTokens.filter((t) => !title.includes(t) && [...new Set(t)].filter((c) => title.includes(c)).length >= 2);

  let score = 0;
  score += Math.min(45, titleHits.length * 12);
  score += Math.min(12, weakTitle.length * 4);
  score += Math.min(40, hits.length * 6);

  // 城市
  if (city && allText.includes(city)) score += 6;

  // 学历
  const needEdu = eduRank(tagText) || eduRank(allText);
  const myEdu = eduRank(ctx.resume?.education || '');
  if (needEdu && myEdu) {
    score += needEdu <= myEdu ? 9 : -8;
  }

  // 年限
  const jobYears = yearsFromText(tagText) || yearsFromText(allText);
  const myYears = Number(ctx.resume?.years || 0);
  if (jobYears && myYears) {
    const [lo, hi] = jobYears;
    if (myYears >= lo && myYears <= hi) score += 6;
    else if (myYears < lo) score -= 6;
    else score += 2;
  }

  // 薪资
  const salaryText = String(job.salary || '');
  const minWanted = Number(ctx.requirement?.salaryMin || 0);
  if (minWanted) {
    const nums = salaryText.match(/(\d+(\.\d+)?)\s*[kK千万元]/g);
    if (nums && nums.length) {
      const lowK = parseFloat(nums[0]) * (nums[0].includes('万') ? 10 : 1);
      if (lowK >= minWanted / 1000) score += 5;
      else score -= 5;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const reasons = [];
  if (titleHits.length) reasons.push(`职位名命中：${titleHits.join('、')}`);
  else if (weakTitle.length) reasons.push(`职位名部分命中：${weakTitle.join('、')}`);
  if (hits.length) reasons.push(`技能重合：${hits.slice(0, 8).join('、')}`);
  if (gaps.length) reasons.push(`简历里没写：${gaps.slice(0, 8).join('、')}`);
  if (needEdu && myEdu && needEdu > myEdu) reasons.push('学历要求高于你的填写');
  if (jobYears && myYears < jobYears[0]) reasons.push(`要求 ${jobYears[0]}-${jobYears[1]} 年，你的年限偏低`);

  return { score, hits, gaps, titleHits, reasons };
}

function rankJobs(jobs, ctx) {
  return jobs
    .map((job) => {
      const result = scoreJob(job, ctx);
      return { ...job, ...result };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = { scoreJob, rankJobs, eduRank, yearsFromText };
