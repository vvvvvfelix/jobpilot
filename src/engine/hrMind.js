// HR 心理分析：先判断对方这句话背后想要什么，再决定怎么答
// 产出结构化结论（意图 / 阶段 / 潜台词 / 风险 / 应答策略），供回复生成和人工复核使用
const llm = require('./llm');

const INTENTS = {
  resume_request: '要简历（多半是系统卡片，点同意即可）',
  interest_check: '群发试探是否对岗位感兴趣',
  salary_probe: '探薪资底线 / 问期望',
  stability_probe: '试探稳定性、离职原因、会不会又走',
  experience_probe: '核实经历真假、年限、业绩含金量',
  travel_probe: '确认出差/驻外/外勤强度能不能扛',
  interview_invite: '约面试，确认时间地点形式',
  offer_talk: '谈薪/录用/背调，进入收口阶段',
  reject: '婉拒或已招满',
  spam: '广告/中介/非招聘',
  info_request: '要微信、要附件、要补充资料',
  chitchat: '寒暄或没有明确诉求',
};

const KEYWORD_INTENT = [
  [/(简历|附件简历|作品|项目资料).*(同意|发)|同意.*(简历)/, 'resume_request'],
  [/简历|发一份|看一下简历/, 'resume_request'],
  [/薪资|工资|待遇|期望|多少钱|年包|税前|税后/, 'salary_probe'],
  [/为什么离开|离职原因|换工作|稳定性|能做多久|会不会走/, 'stability_probe'],
  [/几年|做过|是不是|真的|核实|业绩|销售额|回款|客户资源/, 'experience_probe'],
  [/出差|驻外|外派|外勤|跑外|抗压|能不能长期/, 'travel_probe'],
  [/面试|面谈|到面|视频面|来公司|约个时间|什么时候方便/, 'interview_invite'],
  [/offer|录用|定薪|入职材料|背调|薪资方案/, 'offer_talk'],
  [/不合适|不匹配|暂不考虑|已招满|已经招到/, 'reject'],
  [/广告|推广|代运营|贷款|发票|兼职|刷单|加盟|理财/, 'spam'],
  [/微信|加个微信|电话|联系方式|发我邮箱/, 'info_request'],
  [/感兴趣|考虑一下|看看机会|在吗|方便聊|聊聊/, 'interest_check'],
];

const SUBTEXT = {
  resume_request: '流程动作：他要存档或转给用人部门，点同意最快',
  interest_check: '多半群发或初筛，想知道你是否在找、愿不愿聊，还没细看简历',
  salary_probe: '在探你的底线和区间上限，想判断能不能谈拢、要不要压价',
  stability_probe: '担心你干不长，重点看换工作的动机稳不稳',
  experience_probe: '在核实真假，想听一个能继续追问的细节',
  travel_probe: '确认你扛不扛得住强度，怕到岗就撤',
  interview_invite: '准备往前推，也在看你配合度和时间弹性',
  offer_talk: '进入收口，涉及钱和材料，文字里不谈判',
  reject: '婉拒前兆，留个体面收尾就行',
  spam: '不是真招聘，直接忽略',
  info_request: '想要私下联系方式或附件，别给私人号',
  chitchat: '没有明确诉求，简短回一句就够',
};

function heuristic(text = '') {
  const t = String(text || '');
  const hit = KEYWORD_INTENT.find(([re]) => re.test(t));
  const intent = hit ? hit[1] : 'chitchat';
  return {
    intent,
    stage: /offer|录用|入职|背调/.test(t) ? 'closing' : /面试|面谈|约/.test(t) ? 'interview' : /简历|薪资|经历|出差/.test(t) ? 'screening' : 'opening',
    subtext: SUBTEXT[intent] || '',
    risk: /不合适|暂不考虑|已招满/.test(t) ? '对方可能在收口' : '',
    strategy: {},
    shouldReply: intent !== 'spam',
    confidence: 0.5,
    source: 'rule',
  };
}

const SYSTEM = [
  '你在做招聘对话的心理分析，服务对象是求职者本人，不是 HR。',
  '任务：读出 HR 这句话背后的真实目的，判断他现在处在招聘流程的哪一步，再给出这一步该怎么答、什么先别说。',
  '常见潜台词示例：',
  '- "方便聊聊吗/对岗位感兴趣吗"：多半是系统群发或初筛，他还没细看简历，想知道你是否在找、是否愿意谈，不是在考你。',
  '- "我想要一份你的简历"：流程动作，他要存档/转发给用人部门，直接同意即可，不要写小作文。',
  '- "您期望薪资多少"：在探你的底线和区间上限，先反问区间或给区间，别先报死数。',
  '- "为什么离开上一家/能做多久"：担心你干不长，重点答稳定性和匹配动机，不要吐槽前公司。',
  '- "您做过 XX 吗/业绩多少"：在核实真假，给一个可追问的细节，别报夸张数字。',
  '- "能接受经常出差吗"：确认你能不能扛强度，直接表态即可，不要谈条件换条件。',
  '- "方便什么时候面试"：准备推进，问清时间/地点/形式/对接人。',
  '- "我们先看看/有消息通知你"：可能是婉拒前兆，礼貌收尾，不要追问。',
  '只输出 JSON，不要解释。',
].join('\n');

function strategyFor(intent) {
  switch (intent) {
    case 'resume_request':
      return { answerNow: ['直接同意发在线简历'], holdBack: ['不要写自我推荐长文', '不要报薪资'], askBack: [], tone: '配合' };
    case 'interest_check':
      return { answerNow: ['简单表态在看机会', '一句话点出最相关的经历'], holdBack: ['不要一次把履历全说完', '不要先报薪资'], askBack: ['岗位的汇报关系和区域范围'], tone: '干脆' };
    case 'salary_probe':
      return { answerNow: ['给区间或反问对方区间'], holdBack: ['不要报死数', '不要报上一份工资'], askBack: ['薪资结构和提成比例'], tone: '稳' };
    case 'stability_probe':
      return { answerNow: ['给一个合理的换工作动机'], holdBack: ['不要吐槽前公司', '不要承诺干很久'], askBack: [], tone: '坦诚' };
    case 'experience_probe':
      return { answerNow: ['给一个能追问的具体细节'], holdBack: ['不要报夸大数字', '不要报客户名单'], askBack: [], tone: '务实' };
    case 'travel_probe':
      return { answerNow: ['直接表态能扛'], holdBack: ['不要附加条件'], askBack: ['常驻城市和频率'], tone: '直接' };
    case 'interview_invite':
      return { answerNow: ['表态可以'], holdBack: ['不要先问薪资'], askBack: ['时间、地点、形式、对接人'], tone: '配合' };
    case 'offer_talk':
      return { answerNow: [], holdBack: ['文字里不谈数字'], askBack: [], tone: '转人工', handoff: true };
    case 'reject':
      return { answerNow: ['礼貌收尾一句'], holdBack: ['不要追问原因'], askBack: [], tone: '克制' };
    case 'spam':
      return { answerNow: [], holdBack: ['不回'], askBack: [], tone: '无视', skip: true };
    case 'info_request':
      return { answerNow: ['给可公开的联系方式或说明平台内沟通'], holdBack: ['不要给私人手机号和住址'], askBack: [], tone: '克制' };
    default:
      return { answerNow: ['就字面问题简短回应'], holdBack: ['不要长篇自我介绍'], askBack: [], tone: '平实' };
  }
}

async function analyzeWithLlm(llmCfg, { text, thread, job }) {
  const user = [
    `【岗位】${job?.title || ''}｜${job?.company || ''}`,
    '【最近对话】',
    String(thread || text || '').slice(-600),
    '',
    '【HR 最后一句】',
    String(text || '').slice(0, 300),
    '',
    '输出 JSON：',
    '{',
    ' "intent":"resume_request|interest_check|salary_probe|stability_probe|experience_probe|travel_probe|interview_invite|offer_talk|reject|spam|info_request|chitchat",',
    ' "stage":"opening|screening|interview|closing",',
    ' "subtext":"他真实想要什么，30字内，站在HR立场说",',
    ' "risk":"对方可能在收口/敷衍/套信息的迹象，没有就留空",',
    ' "strategy":{"answerNow":["这一步该说什么"],"holdBack":["先别说什么"],"askBack":["可以反问什么"]},',
    ' "shouldReply":true/false',
    '}',
    '判断要克制：信息不足就按最常见解释，不要脑补。',
  ].join('\n');
  const raw = await llm.chatReliable(llmCfg, [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { maxTokens: 200, temperature: 0.2, timeoutMs: 40000 });
  const t = String(raw || '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('模型没有返回 JSON');
  const d = JSON.parse(t.slice(i, j + 1));
  const intent = INTENTS[d.intent] ? d.intent : 'chitchat';
  return {
    intent,
    intentLabel: INTENTS[intent],
    stage: ['opening', 'screening', 'interview', 'closing'].includes(d.stage) ? d.stage : 'screening',
    subtext: String(d.subtext || '').slice(0, 60),
    risk: String(d.risk || '').slice(0, 60),
    strategy: {
      answerNow: Array.isArray(d.strategy?.answerNow) ? d.strategy.answerNow.slice(0, 3) : [],
      holdBack: Array.isArray(d.strategy?.holdBack) ? d.strategy.holdBack.slice(0, 3) : [],
      askBack: Array.isArray(d.strategy?.askBack) ? d.strategy.askBack.slice(0, 2) : [],
    },
    shouldReply: d.shouldReply !== false,
    confidence: 0.8,
    source: 'llm',
  };
}

// 模型不可用时退回关键词判断，策略仍按意图给
async function analyze({ text, thread, job, llmCfg }) {
  let base;
  if (llm.ready(llmCfg)) {
    try {
      base = await analyzeWithLlm(llmCfg, { text, thread, job });
    } catch (e) {
      base = heuristic(text);
      base.llmError = String(e.message || '').slice(0, 80);
    }
  } else {
    base = heuristic(text);
    base.llmError = '模型未启用';
  }
  const strategy = strategyFor(base.intent);
  base.intentLabel = base.intentLabel || INTENTS[base.intent];
  base.subtext = base.subtext || SUBTEXT[base.intent] || '';
  base.strategy = { ...strategy, ...(base.strategy || {}) };
  if (strategy.skip) base.shouldReply = false;
  if (strategy.handoff) base.shouldReply = false;
  return base;
}

module.exports = { analyze, INTENTS, strategyFor };
