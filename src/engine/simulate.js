// 演练：不碰招聘网站，用一批典型岗位 + 典型 HR 消息，把整条链路跑一遍并落日志
const { rankJobs } = require('./matcher');
const policy = require('./policy');
const tracker = require('./tracker');
const scenarios = require('./scenarios');

const MOCK_JOBS = [
  { index: 0, title: '嵌入式软件工程师（STM32）', company: '广州智能硬件有限公司', salary: '15-22K', tags: ['本科', '3-5年', 'C语言', 'STM32', 'FreeRTOS'], location: '广州 黄埔' },
  { index: 1, title: '高级嵌入式工程师（Linux应用）', company: '广州极飞科技股份有限公司', salary: '18-30K', tags: ['本科', '3-5年', 'C++', 'Linux', '驱动'], location: '广州 黄埔' },
  { index: 2, title: '嵌入式开发（外包驻场）', company: '某某人力资源服务有限公司', salary: '12-15K', tags: ['本科', '3-5年', 'C语言', '单片机'], location: '广州 天河' },
  { index: 3, title: '嵌入式软件工程师', company: '黑名单里的那家公司', salary: '8-10K', tags: ['本科', '1-3年', 'C语言'], location: '广州 番禺' },
  { index: 4, title: '嵌入式开发工程师', company: '已投过的科技有限公司', salary: '14-18K', tags: ['本科', '3-5年', 'MCU', 'C语言'], location: '广州 白云' },
  { index: 5, title: '单片机开发工程师', company: '广州家电控制技术有限公司', salary: '10-14K', tags: ['大专', '1-3年', 'PIC单片机', 'C语言'], location: '广州 南沙' },
  { index: 6, title: '嵌入式实习生', company: '广州物联网科技有限公司', salary: '3-5K', tags: ['实习', '在校', 'C语言'], location: '广州 越秀' },
  { index: 7, title: '电机控制软件开发', company: '广州运动控制有限公司', salary: '16-25K', tags: ['本科', '5-10年', 'C语言', 'PWM', '电机'], location: '广州 增城' },
];

const HR_MESSAGES = [
  '你好，这个岗位还在看机会吗？方便发份简历吗',
  '看了下你的经历，之前几年做的是哪块？',
  '我们这边薪资大概 15-18K，你期望多少？',
  '下周二下午方便来公司面谈一下吗？地址在黄埔',
  '抱歉，这个岗位已经招到合适的人了，谢谢关注',
  '在吗',
];

function demo({ resume, requirement, settings, history }) {
  const ctx = { settings, requirement, resume, history };
  const ranked = rankJobs(MOCK_JOBS, { resume, requirement });
  const plan = policy.planRun(ranked, ctx);

  const steps = [];
  steps.push({ step: 'match', count: ranked.length, top: ranked.slice(0, 3).map((j) => ({ title: j.title, score: j.score })) });
  steps.push({ step: 'policy', allowed: plan.allowed.length, blocked: plan.blocked.map((j) => ({ title: j.title, reasons: j.blockReasons })), quota: plan.quota });

  const messages = HR_MESSAGES.map((text) => {
    const d = scenarios.draftsFor({ text, resume, requirement, job: ranked[0] });
    return { text, scenario: d.scenario, draft: d.drafts[0]?.text, alternatives: d.drafts.slice(1).map((x) => x.text) };
  });
  steps.push({ step: 'message', count: messages.length, items: messages });

  // 模拟投递执行（不联网）：按计划里前 3 个
  const appliedResults = plan.plan.slice(0, 3).map((job, i) => {
    const outcome = i === 0 ? 'submitted' : i === 1 ? 'replied' : 'interview';
    return { title: job.title, company: job.company, score: job.score, intervalMs: policy.jitterInterval(settings.applyIntervalMs), outcome };
  });
  steps.push({ step: 'apply-sim', count: appliedResults.length, items: appliedResults });

  // 用模拟结果算漏斗
  const simHistory = JSON.parse(JSON.stringify(tracker.ensure(history || {})));
  appliedResults.forEach((r, i) => {
    simHistory.applied.push({ ts: Date.now() - i * 60000, key: `${r.title}|${r.company}`, title: r.title, company: r.company, status: r.outcome });
  });
  messages.forEach((m, i) => {
    if (['ask_resume', 'salary', 'interview', 'reject', 'info', 'greet'].includes(m.scenario.code)) {
      simHistory.replied.push({ ts: Date.now() - i * 60000, scenario: m.scenario.code, text: m.draft, company: '' });
    }
  });
  const stats = tracker.stats(simHistory);
  steps.push({ step: 'stats', stats });

  return { steps, plan, ranked, messages, appliedResults, stats };
}

module.exports = { demo, MOCK_JOBS, HR_MESSAGES };
