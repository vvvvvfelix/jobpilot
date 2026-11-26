// ATS 自测：格式层（解析器能不能读）+ 内容层（岗位关键词覆盖率）
const { norm } = require('./parse');

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function checkFormat(raw, parsed) {
  const lines = String(raw || '').split('\n');
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add('文本层可解析', String(raw).length > 200, `${String(raw).length} 字`);
  add('联系方式在首段', lines.slice(0, 8).some((l) => /@|1\d{10}|1\d{2}\*+/.test(l)), '手机/邮箱应在前 8 行');

  const haveSections = [];
  if (parsed.summary) haveSections.push('摘要');
  if (parsed.skills?.length) haveSections.push('技能');
  if (parsed.experiences?.length) haveSections.push('经历');
  if (parsed.projects?.length) haveSections.push('项目');
  if (parsed.education?.length) haveSections.push('教育');
  const missingSections = ['摘要', '技能', '经历', '项目', '教育'].filter((s) => !haveSections.includes(s));
  add('标准章节齐全', missingSections.length === 0, missingSections.length ? `缺：${missingSections.join('、')}` : '五段齐全');

  const dateLines = lines.filter((l) => /^\s*\d{4}[./-]\d{1,2}\s*[-–—]\s*(\d{4}[./-]\d{1,2}|至今)/.test(l));
  const badDates = dateLines.filter((l) => !/\d{4}\.\d{1,2}/.test(l));
  add('日期格式统一', badDates.length === 0, badDates.length ? `不规范：${badDates.slice(0, 3).join(' / ')}` : `YYYY.M 共 ${dateLines.length} 处`);

  const emojiLines = lines.filter((l) => EMOJI.test(l) || /\t/.test(l));
  add('无表情/制表符', emojiLines.length === 0, emojiLines.length ? `命中 ${emojiLines.length} 行` : '干净');

  add('单栏纯文本', !lines.some((l) => /[│┃]/.test(l)), '无表格分隔符，浏览器解析不会错列');

  return {
    checks,
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    score: Math.round((checks.filter((c) => c.pass).length / checks.length) * 100),
  };
}

function checkKeywords(raw, jdKeywords = [], threshold = 0.85) {
  const text = norm(raw).toLowerCase();
  const found = [];
  const missing = [];
  for (const kw of jdKeywords) {
    const k = String(kw).trim();
    if (!k) continue;
    if (text.includes(k.toLowerCase())) found.push(k);
    else missing.push(k);
  }
  const total = found.length + missing.length;
  const coverage = total ? found.length / total : 1;

  const suggestions = missing.slice(0, 10).map((kw) => {
    if ((raw || '').includes('拥有技能')) return { keyword: kw, where: '技能段最靠前的位置', hint: `若确实会 ${kw}，补进「拥有技能」并以项目/经历佐证` };
    return { keyword: kw, where: '摘要 + 最近一段经历的要点', hint: `若做过与 ${kw} 相关的事，用一条具体动作+结果写出来` };
  });

  return { coverage: Math.round(coverage * 100) / 100, passed: coverage >= threshold, threshold, found, missing, suggestions };
}

function checkAts(raw, parsed, jdKeywords, threshold = 0.85) {
  const format = checkFormat(raw, parsed);
  const keywords = checkKeywords(raw, jdKeywords, threshold);
  const score = Math.round(format.score * 0.4 + keywords.coverage * 100 * 0.6);
  return { score, format, keywords, passed: format.score >= 80 && keywords.passed };
}

module.exports = { checkAts, checkFormat, checkKeywords };
