// 从结构化简历里提炼"人设"，给自动回复用：说话直接、句子短、只用简历里真有的经历
function buildPersona(parsed = {}, requirement = {}) {
  const firstJob = (parsed.experiences || [])[0] || {};
  const industries = (parsed.industries || []).slice(0, 2);
  const years = parsed.totalYears || 0;
  const title = parsed.intent?.title || firstJob.title || '';
  const skills = (parsed.skills || []).slice(0, 4);
  const bullets = (parsed.experiences || []).flatMap((e) => e.bullets || []);
  const proof = bullets.find((b) => /\d/.test(b)) || bullets[0] || '';
  const city = parsed.city || requirement.city || '';

  return {
    name: parsed.name || '',
    years,
    title,
    role: '销售总监',
    industries,
    skills,
    city,
    salary: parsed.intent?.salary || '',
    education: parsed.educationLevel || '',
    proof: String(proof).slice(0, 50),
    // 真实业绩口径，写回复只能用这两条，不许再编别的金额
    salesFacts: ['日化年销售额数千万元', '伟格机械国内事业部数千万元'],
    selfIntro: [years ? `${years}年` : '', industries[0] || '', '销售总监'].filter(Boolean).join(''),
    style: '说话短、给结论、不客套；常年外勤出差，按外面跑的人的口吻',
    banned: ['贵公司', '荣幸', '期待与您', '进一步沟通', '非常', '十分', '赋能', '闭环', '深耕', '助力', '您好', '稍等', '感谢', '麻烦您', '辛苦了', '不好意思', '打扰'],
  };
}

// 把解析结果回填成话术需要的字段（缺字段时才写，不覆盖用户手填）
function enrichResume(resume = {}, parsed = {}) {
  const out = { ...resume };
  if (parsed.name) out.name = parsed.name;
  if (parsed.intent?.title) out.title = parsed.intent.title;
  if (parsed.totalYears) out.years = parsed.totalYears;
  if (parsed.city) out.city = parsed.city;
  if (parsed.educationLevel) out.education = parsed.educationLevel;
  if (parsed.skills?.length) out.skills = parsed.skills;
  out.parsed = parsed;
  return out;
}

module.exports = { buildPersona, enrichResume };
