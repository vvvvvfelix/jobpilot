// 对话记忆 + 意图分析 + 自动进化
// 目标：不是套模板回话，而是先判断对方这句话背后想知道什么，再用简历里真有的东西回答。
const INTENTS = [
  {
    code: 'stability',
    label: '稳定性',
    patterns: [/离职|跳槽|干多久|待多久|稳定|频繁|换了几?家|为什么走/],
    concern: '怕你干不长、刚培训完就走',
    tip: '先讲年限和这次想长期做，不解释上一家的是非',
    answer: (p) => `做了${p.years || 15}年销售，想做长期的总监岗。`,
  },
  {
    code: 'salary',
    label: '薪资',
    patterns: [/薪资|薪酬|待遇|多少钱|期望|底薪|提成|package|工资/],
    concern: '预算够不够，你是不是只冲着钱来',
    tip: '先给区间再给"可谈"，把话落回岗位本身',
    answer: () => `总监岗按贵司区间，可谈。`,
  },
  {
    code: 'attendance',
    label: '到岗时间',
    patterns: [/到岗|入职|什么时候能来|几天能到|多久到岗|随时/],
    concern: '这岗位是不是急着补人',
    tip: '给确定时间，别含糊说"随时"',
    answer: () => '随时能到，看您安排。',
  },
  {
    code: 'travel',
    label: '出差/强度',
    patterns: [/出差|外派|驻场|加班|单休|双休|跑外|外勤|抗压/],
    concern: '能不能扛住外勤和强度',
    tip: '先给结论"能"，再用过去跑的活证明',
    answer: () => '出差是常态，一年大半在外。',
  },
  {
    code: 'performance',
    label: '业绩真假',
    patterns: [/业绩|指标|完成率|提成|做了多少|数字|KPI|销售额/],
    concern: '数字是不是真的，能不能复制',
    tip: '直接给一个带数字的事实，不吹总量',
    answer: (p) => (p.proof ? `年销售数千万元上下，机械事业部数千万元上下。` : '业绩看数字，面谈可以带报表。'),
  },
  {
    code: 'channel',
    label: '渠道资源',
    patterns: [/渠道|经销商|代理商|客户资源|门店|终端|客户/],
    concern: '你手上的资源能不能带过来',
    tip: '说清做过哪类渠道，别承诺"带客户"',
    answer: () => '经销商、门店、区域我都跑过。',
  },
  {
    code: 'management',
    label: '带团队',
    patterns: [/团队|管理|带人|下属|几个人|管理经验/],
    concern: '管理幅度跟岗位是否匹配',
    tip: '说实际带过几个人、管什么事，不夸大',
    answer: () => '带过区域团队，指标考核都管。',
  },
  {
    code: 'education',
    label: '学历/证书',
    patterns: [/学历|本科|大专|统招|证书|资格/],
    concern: '硬门槛卡不卡',
    tip: '如实说学历，把重点转到能干活上',
    answer: (p) => `学历${p.education || '大专'}，证书有。`,
  },
  {
    code: 'competitor',
    label: '求职动机',
    patterns: [/为什么来|为什么选择|了解我们|同行|竞品|我们公司/],
    concern: '你是只为了钱，还是真想做这行',
    tip: '讲对行业的熟悉 + 想做的方向，不夸公司',
    answer: (p) => `同行熟，想做${p.title || '这一块'}。`,
  },
  {
    code: 'product',
    label: '跨行学习',
    patterns: [/没做过|不熟|跨行|产品|行业经验|学习/],
    concern: '换个产品你能不能快速上手',
    tip: '承认没做过，给"多久能上手"的具体说法',
    answer: () => '产品能快速上手，一两周能独立跑。',
  },
  {
    code: 'interview',
    label: '约面',
    patterns: [/面试|聊聊|电话|方便吗|约个时间|到公司|视频/],
    concern: '你是不是真有意向，别放鸽子',
    tip: '给明确时间段，主动配合对方',
    answer: () => '方便，我常年在外跑，您定时间。',
  },
  {
    code: 'resume_request',
    label: '索要简历',
    patterns: [/发.{0,6}简历|一份.{0,4}简历|简历.{0,4}同意|看.{0,4}简历|附件简历|在线简历/],
    concern: '想先看简历确认真实性，再决定要不要聊',
    tip: '直接同意发简历，别让对方等',
    answer: () => '可以，发您在线简历。',
  },
  {
    code: 'identity',
    label: '身份核实',
    patterns: [/是本人|哪位|姓名是|身份证|核实|真实姓名/],
    concern: '核实身份，确认不是代聊',
    tip: '一句话报清姓名、岗位、年限',
    answer: (p) => `我是${p.name || '本人'}，${p.years || ''}年${p.title || '经验'}。`,
  },
];

function emptyMemory() {
  return {
    version: 1,
    strategyVersion: 1,
    evolvedAt: null,
    stats: { replies: 0, sent: 0, questions: 0, followUps: 0 },
    intents: {},
    hr: {},
    lessons: [],
    lessonCodes: [],
  };
}

function load(store) {
  const raw = store.get('memory');
  const base = emptyMemory();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    stats: { ...base.stats, ...(raw.stats || {}) },
    intents: raw.intents || {},
    hr: raw.hr || {},
    lessons: raw.lessons || [],
    lessonCodes: raw.lessonCodes || [],
  };
}

function save(store, mem) {
  store.set('memory', mem);
  return mem;
}

function analyze(text, persona = {}) {
  const src = String(text || '');
  if (!src) return [];
  const hits = [];
  for (const it of INTENTS) {
    if (it.patterns.some((re) => re.test(src))) {
      hits.push({
        code: it.code,
        label: it.label,
        concern: it.concern,
        tip: it.tip,
        answer: it.answer(persona),
      });
    }
  }
  return hits.slice(0, 3);
}

// 在模板回复后面补一句，专门回答对方真正担心的事；只补一句，整体不超过 60 字
function enhance(draft, analyses, persona = {}) {
  const base = String(draft || '').trim();
  const extra = (analyses || []).map((a) => a.answer).filter(Boolean);
  if (!extra.length) return base;
  if (base.length >= 25) return base;
  let text = base;
  const strip = (s) => String(s).replace(/[，。！？、；：\s]/g, '');
  for (const line of extra.slice(0, 1)) {
    if (text.includes(line.slice(0, 8))) continue;
    // 底稿已经回答了同一件事（字符重合度高）就不再补，避免重复啰嗦
    const a = new Set([...strip(line)]);
    const b = new Set([...strip(text)]);
    let hit = 0;
    for (const ch of a) if (b.has(ch)) hit += 1;
    if (hit / Math.max(1, a.size) > 0.55) continue;
    if (text.length + line.length > 60) break;
    const joiner = /[。！？]$/.test(text) ? '' : '，';
    text = `${text}${joiner}${line}`;
  }
  return text;
}

function hrKey(company) {
  return String(company || '未知公司').replace(/\s+/g, '').slice(0, 24);
}

function remember(store, { company, question, analyses, draft, sent }) {
  const mem = load(store);
  const key = hrKey(company);
  const hr = mem.hr[key] || { company, intents: {}, questions: [], lastAt: null };
  hr.company = company || hr.company;
  hr.lastAt = new Date().toISOString();
  if (question) {
    hr.questions.push({ text: String(question).slice(0, 200), intents: (analyses || []).map((a) => a.code), ts: hr.lastAt });
    hr.questions = hr.questions.slice(-20);
    mem.stats.questions += 1;
  }
  for (const a of analyses || []) {
    hr.intents[a.code] = (hr.intents[a.code] || 0) + 1;
    const g = mem.intents[a.code] || { count: 0, sent: 0 };
    g.count += 1;
    if (sent) g.sent += 1;
    mem.intents[a.code] = g;
  }
  mem.stats.replies += 1;
  if (sent) mem.stats.sent += 1;
  mem.hr[key] = hr;
  return save(store, mem);
}

// 自动进化：某类问题反复出现就沉淀成一条经验，策略版本 +1
function evolve(store) {
  const mem = load(store);
  const known = new Set(mem.lessonCodes || []);
  let changed = false;
  for (const it of INTENTS) {
    const g = mem.intents[it.code];
    if (!g || g.count < 3 || known.has(it.code)) continue;
    mem.lessons.unshift({
      code: it.code,
      text: `${it.label}类问题出现 ${g.count} 次（对方在意：${it.concern}）→ ${it.tip}`,
      evidence: { count: g.count, sent: g.sent },
      ts: new Date().toISOString(),
    });
    mem.lessonCodes.push(it.code);
    changed = true;
  }
  mem.lessons = mem.lessons.slice(0, 20);
  if (changed) {
    mem.strategyVersion = (mem.strategyVersion || 1) + 1;
    mem.evolvedAt = new Date().toISOString();
  }
  return save(store, mem);
}

function summary(store) {
  const mem = load(store);
  const tops = Object.entries(mem.intents)
    .map(([code, g]) => ({ code, label: (INTENTS.find((i) => i.code === code) || {}).label || code, count: g.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    strategyVersion: mem.strategyVersion,
    evolvedAt: mem.evolvedAt,
    hrCount: Object.keys(mem.hr).length,
    stats: mem.stats,
    handoffPending: (store.get('handoff') || []).filter((h) => !h.done).length,
    guard: (() => {
      try {
        const g = require('./guard').cooling(store);
        return { cooling: g.cooling, remainMin: g.remainMin };
      } catch (e) {
        return { cooling: false, remainMin: 0 };
      }
    })(),
    topIntents: tops,
    lessons: mem.lessons.slice(0, 5),
    hr: Object.values(mem.hr)
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
      .slice(0, 8)
      .map((h) => ({ company: h.company, lastAt: h.lastAt, intents: Object.keys(h.intents || {}), questions: (h.questions || []).slice(-2).map((q) => q.text) })),
  };
}

module.exports = { analyze, enhance, remember, evolve, summary, load, save, INTENTS, hrKey };
