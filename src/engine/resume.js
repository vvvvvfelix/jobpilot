const { AI_TONE_MAP, normalize, findTerms, extractAll } = require('./keywords');

function deAiTone(line) {
  let out = line;
  const changes = [];
  for (const [pattern, replacement] of AI_TONE_MAP) {
    if (pattern.test(out)) {
      const before = out;
      out = out.replace(pattern, replacement);
      if (before !== out) changes.push({ from: pattern.source, to: replacement });
    }
  }
  return { text: out.replace(/\s{2,}/g, ' ').trim(), changes };
}

function splitSentences(line) {
  // 长句拆分：超过 45 字且含逗号时，按第一个逗号断开
  if (line.length <= 45) return [line];
  const parts = line.split(/(?<=[，,；;])/);
  if (parts.length <= 1) return [line];
  const buckets = [];
  let cur = '';
  for (const part of parts) {
    if ((cur + part).length > 45 && cur) {
      buckets.push(cur);
      cur = part;
    } else {
      cur += part;
    }
  }
  if (cur) buckets.push(cur);
  return buckets.map((s) => s.replace(/[，,；;]\s*$/, '').trim()).filter(Boolean);
}

function optimizeBullet(rawLine) {
  const notes = [];
  const original = rawLine.trim();
  if (!original) return { lines: [], notes };
  const { text } = deAiTone(original);
  let line = text;

  // 去掉空洞形容词
  line = line
    .replace(/非常|十分|极其|相当|尤为/g, '')
    .replace(/熟练掌握/g, '熟悉')
    .replace(/精通/g, '熟悉')
    .replace(/丰富的/g, '')
    .replace(/优秀的/g, '')
    .replace(/良好的/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 量化缺失提示
  const hasNumber = /\d/.test(line);
  const hasResult = /(提升|降低|缩短|减少|节省|达到|覆盖|支撑|完成|交付)/.test(line);
  if (!hasNumber && /负责|参与|完成|开发|设计|搭建|调试|维护/.test(line)) {
    notes.push('这条缺量化数据，建议补：数量/规模/指标/周期（例如「支撑 xx 台设备」「问题率降到 x%」）');
  }
  if (!hasResult) {
    notes.push('这条只有动作没有结果，建议补一句「结果是什么」');
  }

  const sentences = splitSentences(line);
  if (sentences.length > 1) notes.push('原句过长，已按语义断成两句，方便 HR 快速扫读');
  return { lines: sentences, notes };
}

function optimizeResume(resume, requirement, options = {}) {
  const raw = normalize(resume.raw || '');
  const reqText = normalize(requirement.text || '');
  if (!raw) {
    return {
      optimizedText: '',
      changes: [],
      suggestions: ['简历原文为空，先在「简历」页粘贴或导入简历内容'],
      keywords: { matched: [], missing: findTerms(reqText) },
    };
  }

  const changes = [];
  const suggestions = [];
  const lines = raw.split('\n');
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }
    // 标题/短行（个人信息、教育、技能等）不做改写
    if (trimmed.length <= 10 || !/[，,。；;]/.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    const prefix = /^(\d+\.|[・·])\s+/.exec(trimmed);
    if (prefix) {
      // 已带编号的条目保持编号，不再套「· 」
      const body = trimmed.slice(prefix[0].length);
      const { lines: newLines, notes } = optimizeBullet(body);
      for (const item of notes) if (!suggestions.includes(item)) suggestions.push(item);
      out.push(...newLines.map((s) => `${prefix[1]} ${s}`));
      continue;
    }
    const { lines: newLines, notes } = optimizeBullet(trimmed);
    for (const item of notes) {
      if (!suggestions.includes(item)) suggestions.push(item);
    }
    if (newLines.join('') !== trimmed) {
      const { changes: toneChanges } = deAiTone(trimmed);
      for (const c of toneChanges) {
        changes.push({ type: '去AI腔', before: c.from, after: c.to });
      }
    }
    out.push(...newLines.map((s) => (s.startsWith('·') ? s : `· ${s}`)));
  }

  const optimizedText = fixFutureDates(dedupeLines(toneDownClaims(out.join('\n').replace(/\n{3,}/g, '\n\n').trim())));
  const resumeTerms = extractAll(`${optimizedText}\n${raw}`);
  const reqTerms = extractAll(reqText);
  const matched = reqTerms.skills.filter((s) => resumeTerms.skills.includes(s));
  const missing = reqTerms.skills.filter((s) => !resumeTerms.skills.includes(s));

  if (missing.length) {
    suggestions.push(`岗位要求里这 ${missing.length} 项简历没提到：${missing.join('、')}。如果确实做过，补一条具体经历；没做过就别编`);
  }
  const levels = reqTerms.levels.filter((l) => !resumeTerms.levels.includes(l));
  if (levels.length) {
    suggestions.push(`岗位写的是 ${levels.join('/')}，简历里最好显式写明自己的学历/年限，方便系统筛`);
  }

  return {
    optimizedText,
    changes: changes.slice(0, 20),
    suggestions: suggestions.slice(0, 12),
    keywords: { matched, missing },
    llmUsed: false,
    source: options.llm && options.llm.enabled ? 'rule+llm' : 'rule',
  };
}

// 明显夸大的表述，统一压回可核实的说法（广交会这种量级不可能"独立操盘"）
const CLAIM_FIXES = [
  [/独立操盘广交会[、,，]?\s*(行业)?专业展?全流程/g, '参与广交会及行业展会'],
  [/独立操盘广交会/g, '参与广交会及行业展会'],
  [/操盘广交会/g, '参与广交会'],
  [/主导广交会/g, '参与广交会'],
  [/独立负责广交会/g, '参与广交会'],
  [/走通/g, '处理'],
  [/主导/g, '负责'],
  [/全权负责|全流程操盘/g, '负责'],
];

// 反吹牛门禁（对应优化规范 §5.4）：模型输出必须能追回原文事实，否则打回规则改写
const BANNED_HYPE_RE = /行业领先|业界首个|国内首个|彻底解决|完全消除|100%|零故障|革命性|颠覆|独家|唯一|顶级|极致/;
const ESCALATION_VERB_RE = /主导|统筹|带领|全权|亲自操盘/;
const SCALE_CLAIM_RE = /公司级|集团级|行业级|全站|全集团|全公司/;

function truthGate(rawBullet, outBullet) {
  const raw = String(rawBullet || '');
  const out = String(outBullet || '');
  const rawNums = new Set(numbersIn(raw));
  if (numbersIn(out).some((n) => !rawNums.has(n))) {
    return { text: cleanBullet(raw), violation: 'NO_EVIDENCE_NUMBER' };
  }
  if (BANNED_HYPE_RE.test(out)) {
    return { text: cleanBullet(raw), violation: 'BANNED_HYPE' };
  }
  if (SCALE_CLAIM_RE.test(out) && !SCALE_CLAIM_RE.test(raw)) {
    return { text: cleanBullet(raw), violation: 'SCALE_EXAGGERATION' };
  }
  if (/参与|协助|配合/.test(raw) && ESCALATION_VERB_RE.test(out)) {
    return { text: cleanBullet(out.replace(/主导|统筹|带领|全权负责|全权|亲自操盘/g, '参与')), violation: 'VERB_ESCALATION' };
  }
  return { text: out, violation: null };
}

function toneDownClaims(text) {
  let out = String(text || '');
  for (const [re, rep] of CLAIM_FIXES) out = out.replace(re, rep);
  return out;
}

// 智联简历页把右侧栏和底部导航一起抓下来了，这里切掉页面外壳，只留简历正文
function cleanResumeText(text) {
  let t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return '';
  const tailMarkers = [/\n简历管理\s*\n/, /\n招聘方主动查看权限/, /\n有\s*\d+\s*条新的投递进展/];
  for (const re of tailMarkers) {
    const m = re.exec(t);
    if (m && m.index > t.length * 0.4) {
      t = t.slice(0, m.index);
      break;
    }
  }
  t = t
    .replace(/^职场人\s*\n/m, '')
    .replace(/\n个人作品\s*您最多可在此上传\s*\d+\s*个附件\s*$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}

function stripNoise(text) {
  return String(text || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/g, '')
    .replace(/Thinking Process[\s\S]*?\n\n/gi, '')
    .replace(/\r/g, '')
    .trim();
}

// 按行切块，每块不超过 limit 字，避免一次让模型吐 5000 字被截断
function chunkByLines(text, limit = 1200) {
  const lines = String(text || '').split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > limit && cur) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

const FILLER_FIXES = [
  [/非常|十分|极其|相当|尤为/g, ''],
  [/熟练掌握/g, '熟悉'],
  [/丰富的/g, ''],
  [/优秀的/g, ''],
  [/良好的/g, ''],
  [/带头|领衔/g, ''],
];

// 单条 bullet：去 AI 腔、去空洞形容词，保持一条一句话，加了编号由外层负责
function cleanBullet(text) {
  let t = deAiTone(String(text || '')).text;
  for (const [re, rep] of FILLER_FIXES) t = t.replace(re, rep);
  t = t.replace(/\s{2,}/g, ' ').replace(/[，,；;]\s*$/, '').replace(/^\s*[・·]\s*/, '').trim();
  if (t && !/[。！？]$/.test(t)) t += '。';
  return t;
}

function numbersIn(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) || []).map((x) => x.replace(/\.0$/, ''));
}

function extractJsonArray(text) {
  const i = text.indexOf('[');
  const j = text.lastIndexOf(']');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(text.slice(i, j + 1));
  } catch (e) {
    return null;
  }
}

// 让模型逐条改写一组 bullet，返回条数与原文一致、数字不许凭空出现，否则整组判不合格
async function llmRewriteBullets(llm, llmCfg, exp) {
  const items = exp.bullets || [];
  if (!items.length) return null;
  const origNums = new Set(items.flatMap(numbersIn));
  const prompt = [
    '你是中文简历改写助手。把输入里的每条工作描述改写一遍，只改措辞，不加料。',
    '硬规则（违反即判不合格）：',
    '1) 输出条数必须与输入完全相同，一条对应一条，不许合并、不许拆分、不许漏。',
    '2) 严禁新增原文没有的经历、公司、数字、规模、渠道名、人数、金额、百分比、增幅；原文的数字可保留，但不能编新的。',
    '3) 每条一句话、动词开头、45 字以内、口语但专业；严禁 AI 腔（赋能/闭环/抓手/深耕/显著提升/全方位/赋能式/行业领先/业界首个/国内首个/彻底解决/完全消除/100%/零故障/革命性/颠覆/独家/唯一/顶级/极致/公司级/集团级/行业级/全站/全集团/全公司）。',
    '3b) 保留原文的专业名词（产品名、设备名、行业名、系统名、项目名），严禁泛化成"相关产品""各类设备""相关项目"。',
    '4) 严禁夸大动词升级：原文写「参与/协助/配合/支持」的，改完必须保持参与/协助/配合/支持语态，不许升级成「主导/统筹/带领/负责全局/全权负责/独立操盘/从0到1操盘/走通」。',
    '4b) 展会/活动类：只能写「参与/配合/客户接待/样品跟进/订单跟进」，严禁写「独立操盘/主导/操盘/全流程操盘」。',
    '4c) 原文没有的事实严禁补（人数、金额、规模、渠道名、客户数、覆盖率、转化率、增长率）；宁可写得朴素，也不能加料。',
    '5) 只输出 JSON 数组，形如 ["条目1","条目2"]，不要解释、不要 markdown、不要代码块。',
    '',
    `【公司】${exp.company || ''}  【职位】${exp.title || ''}`,
    '【原始描述】',
    JSON.stringify(items, null, 1),
  ].join('\n');
  let out = '';
  try {
    out = stripNoise(await llm.chat(llmCfg, [{ role: 'user', content: prompt }], { maxTokens: 1200, temperature: 0.3 }));
  } catch (e) {
    return null;
  }
  const arr = extractJsonArray(out);
  if (!arr || arr.length !== items.length) return null;
  const ok = arr.every((b) => {
    if (typeof b !== 'string' || !b.trim()) return false;
    const n = numbersIn(b);
    return n.every((x) => origNums.has(x));
  });
  if (!ok) return null;
  return arr.map(cleanBullet);
}

const SECTION_HEADER_RE = /^(个人优势|求职状态|求职意向|全职期望|工作／实习经历|工作经历|教育经历|项目经历|培训经历|语言能力|专业技能|证书|其他项目|项目描述|基本信息)$/;
const MANY_YEAR_DATE_RE = /^(19|20)\d{2}\.\d{1,2}\s*[-–~]\s*((19|20)\d{2}\.\d{1,2}|至今)/;

// 年限从经历时间线算，不写原文那种"9年B端销售"这种对不上的数
function monthsOfExp(exp, now) {
  if (typeof exp.months === 'number' && exp.months > 0) return exp.months;
  const s = exp.startText || '';
  const e = exp.endText || '';
  const parseYm = (v) => {
    const m = String(v).match(/^(\d{4})\.(\d{1,2})$/);
    return m ? Number(m[1]) * 12 + Number(m[2]) : null;
  };
  const sIdx = parseYm(s);
  if (!sIdx) return 0;
  const eIdx = /至今|今/.test(e) ? now.getFullYear() * 12 + (now.getMonth() + 1) : parseYm(e);
  if (!eIdx || eIdx < sIdx) return 0;
  return eIdx - sIdx;
}

function roleBand(title) {
  const t = String(title || '');
  // 先判销售：像"销售工程师""客户经理"这种带工程字样的其实是销售岗
  if (/销售|业务|客户|渠道|经销|大客户|BD|拓展/.test(t)) return 'sales';
  if (/卖场|营业|店长|零售|导购|储备干部/.test(t)) return 'retail';
  if (/技术|工程师|运维|实施|售前|支持|产品/.test(t)) return 'tech';
  return 'sales';
}

function buildSummary(parsed) {
  const now = new Date();
  const band = { retail: 0, tech: 0, sales: 0 };
  for (const e of parsed.experiences || []) band[roleBand(e.title)] += monthsOfExp(e, now);
  const yr = (m) => Math.max(0, Math.round((m / 12) * 2) / 2);
  const parts = [];
  if (band.retail >= 12) parts.push(`约 ${yr(band.retail)} 年家电卖场零售管理`);
  if (band.tech >= 12) parts.push(`约 ${yr(band.tech)} 年通信与 CRM 技术实施/售前`);
  if (band.sales >= 12) parts.push(`约 ${yr(band.sales)} 年 B 端设备与材料渠道销售`);
  const head = parts.length ? `做过${parts.join('、')}。` : '';
  return `${head}擅长从0搭渠道：参与广交会及行业展会；搭过企业抖音号做内容获客。会用 ERP/CRM，能独立做需求梳理、系统对接和一线培训。`;
}

function projectKey(name) {
  return String(name || '').replace(/[（(].*$/, '').trim();
}

function normPoint(text) {
  return String(text || '').replace(/^[・·]\s*/, '').replace(/[\s，,。；;：:]/g, '');
}

// 同名项目合并：条目取并集（两家公司各自记录的同一项目，条目互补而不是重复）
function mergeProjects(projects) {
  const out = [];
  for (const p of projects || []) {
    const key = projectKey(p.name);
    const dup = out.find((x) => projectKey(x.name) === key);
    if (!dup) {
      out.push({ ...p, points: [...(p.points || [])] });
      continue;
    }
    if (String(p.name || '').length > String(dup.name || '').length) dup.name = p.name;
    const seen = new Set((dup.points || []).map(normPoint));
    for (const pt of p.points || []) {
      if (!seen.has(normPoint(pt))) {
        dup.points.push(pt);
        seen.add(normPoint(pt));
      }
    }
    if (p.company && !dup.company) dup.company = p.company;
    if (p.role && !dup.role) dup.role = p.role;
  }
  return out;
}

// 示例公司 / 示例公司 是同一批人、同一个项目，跨两家公司需要一句说明，否则 HR 看着像写错
const CROSS_COMPANY_NOTE = '说明：直属领导在示例公司、示例公司两家公司均有股份，本人人事关系在两公司之间调动，项目由同一团队连续推进。';

// A9 项目本人补充的事实：内部电商体量、疫情期间的电信外呼平台，用来把「2000+ 员工」这种说法坐实
const A9_EXTRA_POINTS = [
  '内部电商业务月流水数亿元，CRM 支撑客服、电销、仓储等 2000+ 名员工日常协同与数据打通。',
  '疫情期间承接中国电信自动外呼平台，应对网课、远程办公带来的宽带业务量激增，支撑大并发外呼稳定运行。',
];

// 去掉全篇重复条目（模型分块改写时最容易出现同一段出现两遍）
function dedupeLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const key = line
      .replace(/^\s*(\d+\.|[・·])\s*/, '')
      .replace(/[\s，,。；;：:]/g, '')
      .trim();
    if (key.length > 12) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  return out.join('\n');
}

// 结束时间不能写到未来（智联那边偶尔会带出 2026.3 这种不存在的结束时间）
function fixFutureDates(text, now = new Date()) {
  const curIdx = now.getFullYear() * 12 + now.getMonth() + 1;
  return String(text || '').replace(/((?:19|20)\d{2})\.(\d{1,2})\s*[-–~]\s*((?:19|20)\d{2})\.(\d{1,2})/g, (m, y1, m1, y2, m2) => {
    const endIdx = Number(y2) * 12 + Number(m2);
    if (endIdx <= curIdx) return m;
    const capped = `${now.getFullYear()}.${now.getMonth() + 1}`;
    return `${y1}.${m1}-${capped}`;
  });
}

function renderResume(parsed, bulletMap, tailText) {
  const lines = [];
  if (parsed.name) lines.push(parsed.name);
  if (parsed.meta) lines.push(parsed.meta);
  if (parsed.phone) lines.push(parsed.phone);
  if (parsed.email) lines.push(parsed.email);

  lines.push('', '个人优势', buildSummary(parsed));
  if (parsed.status) lines.push('', '求职状态', parsed.status);
  const it = parsed.intent || {};
  if (it.title || it.salary) {
    lines.push('', '求职意向', '全职期望');
    [it.title, it.salary, it.city, it.industry].filter(Boolean).forEach((x) => lines.push(x));
  }

  lines.push('', '工作／实习经历');
  for (const e of parsed.experiences || []) {
    lines.push(e.company || '', e.dates || '', e.title || '');
    if (e.category) lines.push(`职位类别： ${e.category}`);
    if (e.industry) lines.push(`所属行业： ${e.industry}`);
    if ((e.skills || []).length) lines.push('拥有技能：', e.skills.join('、'));
    const bullets = bulletMap.get(e) || (e.bullets || []).map(cleanBullet);
    bullets.forEach((b, i) => lines.push(`${i + 1}. ${b}`));
  }

  if ((parsed.education || []).length) {
    lines.push('', '教育经历');
    for (const ed of parsed.education) lines.push(ed.raw || [ed.school, ed.degree].filter(Boolean).join(' '));
  }

  const projects = mergeProjects(parsed.projects);
  if (projects.length) {
    lines.push('', '项目经历');
    let crossNoted = false;
    for (const pr of projects) {
      const name = String(pr.name || '').trim();
      lines.push(name);
      const meta = [pr.company, pr.role].filter(Boolean).join('｜');
      if (meta) lines.push(meta);
      if (!crossNoted && /示例公司/.test(name) && /示例公司/.test(name)) {
        lines.push(CROSS_COMPANY_NOTE);
        crossNoted = true;
      }
      lines.push('项目描述');
      for (const pt of pr.points || []) lines.push(`・${cleanBullet(pt)}`);
      if (/A9\s*CRM|A9 CRM/i.test(name)) {
        const body = (pr.points || []).join('\n');
        for (const extra of A9_EXTRA_POINTS) {
          if (!/3\s*亿|月流水/.test(body) && extra.includes('数亿元')) lines.push(`・${extra}`);
          if (!/网课|自动外呼平台/.test(body) && extra.includes('网课')) lines.push(`・${extra}`);
        }
      }
    }
  }

  if (tailText) lines.push('', tailText.trim());
  return toneDownClaims(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

// 结构化重建：先解析成分段结构，再把每段 bullet 交给模型逐条改写，
// 条数不一致或凭空冒数字就整段退回规则改写，保证不会把段落写丢、写断
async function optimizeWithLlm(base, resume, requirement, llmCfg) {
  const llm = require('./llm');
  const { parseResume } = require('./parse');
  const raw = String(resume.raw || '').trim();
  const parsed = parseResume(raw);
  const bulletMap = new Map();
  let llmUsed = false;
  const truthViolations = [];

  if (llm.ready(llmCfg)) {
    for (const exp of parsed.experiences || []) {
      const rewritten = await llmRewriteBullets(llm, llmCfg, exp);
      if (rewritten) {
        // 逐条过反吹牛门禁：数字必须有原文依据、动词不许越级、禁用夸大词
        const gated = rewritten.map((b, i) => {
          const r = truthGate((exp.bullets || [])[i], b);
          if (r.violation) truthViolations.push({ code: r.violation, company: exp.company, snippet: b });
          return r.text;
        });
        bulletMap.set(exp, gated);
        llmUsed = true;
      }
    }
  }

  const tailIdx = raw.indexOf('培训经历');
  const tailText = tailIdx > 0 ? raw.slice(tailIdx) : '';
  const built = fixFutureDates(dedupeLines(renderResume(parsed, bulletMap, tailText)));
  if (!built || built.length < raw.length * 0.55) {
    return { ...base, llmUsed: false, source: 'rule', llmNote: '结构化重建结果异常偏短，已回落规则改写' };
  }
  return { ...base, optimizedText: built, llmUsed, source: llmUsed ? 'rule+llm' : 'rule', truthViolations };
}

module.exports = { optimizeResume, optimizeWithLlm, deAiTone, cleanResumeText, toneDownClaims, truthGate, buildSummary };
