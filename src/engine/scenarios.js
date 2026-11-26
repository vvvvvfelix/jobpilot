const { cleanLine } = require('./replier');

// 线上应聘里 HR 真正会发过来的几类话，分类后给对应话术，别用同一句糊所有人
const SCENARIOS = [
  {
    code: 'reject',
    label: '不合适 / 已招满',
    test: /不合适|不匹配|暂不考虑|已招满|岗位已关|已经招到|不合适您|抱歉|谢谢关注/,
    build: (f) => [
      `收到，有${f.skill}的岗位再联系。`,
      `明白，后续有合适机会我再投。`,
      `收到。`,
    ],
  },
  {
    code: 'interview',
    label: '约面试',
    test: /面试|面谈|到面|视频面|线上面|方便过来|什么时候方便|约个时间|来公司聊/,
    build: (f) => [
      `方便，我常年在外跑，${f.city || '广州'}这边能约。您定时间。`,
      `可以，看您时间，我调开外勤过去。`,
      `方便，线上或到公司都行，您定。`,
    ],
  },
  {
    code: 'salary',
    label: '问薪资 / 期望',
    test: /薪资|工资|待遇|期望|多少|package|年包|税后|税前/,
    build: (f) => [
      `总监岗按贵司区间来，${f.salaryRange || '8-16K'}可谈。`,
      `期望${f.salaryRange || '8-16K'}，具体看结构和盘子。您区间多少？`,
      `按岗位定，${f.salaryRange || '8-16K'}能聊。`,
    ],
  },
  {
    code: 'ask_resume',
    label: '要简历 / 要作品',
    test: /简历|附件|发一份|看一下简历|作品|项目资料|发我/,
    build: () => [
      `可以，发您在线简历。`,
      `发了，您看下。`,
      `可以，稍后发附件版。`,
    ],
  },
  {
    code: 'travel',
    label: '出差 / 外勤强度',
    test: /出差|外派|驻场|加班|跑外|外勤|抗压|经常跑|到处飞/,
    build: () => [
      `出差是常态，我一年大半在外跑。`,
      `可以，常年外勤，这个不是问题。`,
      `没问题，我平时就在外面跑。`,
    ],
  },
  {
    code: 'attendance',
    label: '到岗时间',
    test: /到岗|入职|什么时候能来|多久到|几天能到/,
    build: () => [
      `随时能到，看您安排。`,
      `一周内能到，您定时间。`,
    ],
  },
  {
    code: 'info',
    label: '追问经历 / 技能',
    test: /几年|做过|会不会|熟悉|了解|学历|在职|离职|为什么|能不能|是否|经历/,
    build: (f) => [
      `做了${f.years || 15}年${f.skill}，带团队做区域，常年在外跑。`,
      `这块我一直在做，${f.proof || '区域和渠道都跑过'}。`,
      `是，${f.skill}是主业，您想了解哪段？`,
    ],
  },
  {
    code: 'greet',
    label: '打招呼 / 问在不在',
    test: /你好|在吗|方便吗|看到你|看一下|聊聊/,
    build: () => [
      `在，您说。`,
      `在，方便，您问。`,
      `在的。`,
    ],
  },
];

const FALLBACK = {
  code: 'other',
  label: '其他',
  build: () => [
    '您说，我这边答。',
    '您讲具体点，我直接答。',
    '收到。',
  ],
};

function classify(text) {
  const body = String(text || '');
  for (const s of SCENARIOS) {
    if (s.test.test(body)) return { code: s.code, label: s.label };
  }
  return { code: FALLBACK.code, label: FALLBACK.label };
}

function factsOf({ resume, requirement, job }) {
  const resumeText = `${resume?.raw || ''}\n${resume?.optimized || ''}`;
  const parsed = resume?.parsed;
  const firstJob = parsed?.experiences?.[0];
  const skill = (parsed?.skills && parsed.skills[0]) || (resume?.skills && resume.skills[0]) || resume?.title || (firstJob && firstJob.title) || '这个方向';
  const salaryMin = Number(requirement?.salaryMin || 0);
  return {
    skill,
    city: requirement?.city || resume?.city || '',
    years: parsed?.totalYears || resume?.years || 0,
    salaryRange: salaryMin ? `月薪 ${Math.round(salaryMin / 1000)}k 以上` : '',
    lastSalary: '',
    focus: resume?.title || (firstJob && firstJob.title) || skill,
    proof: resumeText.match(/(做过|负责)[^\n，。]{4,20}/)?.[0] || '',
    job: job?.title || '',
  };
}

function draftsFor({ text, resume, requirement, job, count = 3 }) {
  const scenario = classify(text);
  const facts = factsOf({ resume, requirement, job });
  const builder = SCENARIOS.find((s) => s.code === scenario.code) || FALLBACK;
  const all = builder.build(facts).map(cleanLine);
  return {
    scenario,
    facts,
    drafts: all.slice(0, count).map((t) => ({
      text: t,
      length: t.length,
      tooLong: t.length > 90,
      aiSmell: /非常|十分|荣幸|贵公司|期待与您|进一步沟通|赋能|闭环|深耕/.test(t),
    })),
  };
}

module.exports = { SCENARIOS, classify, draftsFor, factsOf };
