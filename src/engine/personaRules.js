// 按 felix-auto-reply-persona.md v1.0 落地的人设与红线规则
// 原则：不卑不亢、先结论后补充、不报价、不给未核实数字、不评价前雇主、不承诺绝对时间
const LEVEL = '销售总监';

const BLACKLIST = ['赋能', '抓手', '闭环', '颗粒度', '对齐', '复盘', '赛道', '打法', '私域', '爆款', '亲', '小伙伴', '哈喽', '宝子', '保证', '无条件', '随时到岗', '绝对', '包在我身上', '请问', '了解一下', '进一步', '感谢您', '不好意思'];

const NON_HR = /广告|推广|代运营|贷款|发票|兼职|刷单|返利|加盟|理财|博彩|加微信送|免费领/;
const RISK = /验证码|滑块|安全验证|账号异常|操作过于频繁|设备锁/;
const OFFER = /offer|录用通知|定薪|薪资方案|整体包|入职材料|背调/i;

const RULES = [
  { id: 'R15', priority: 2, match: OFFER, handoff: true },
  {
    id: 'R09',
    priority: 3,
    match: /业绩|销售额|回款多少|客户名单|资源|指标完成/,
    text: () => '业绩涉及前公司口径，文字里不给数字。做法可以电话说。',
  },
  {
    id: 'R11',
    priority: 4,
    match: /改期|换个时间|时间冲突|推迟/,
    handoff: true,
  },
  {
    id: 'R10',
    priority: 5,
    match: /面试|面谈|到面|视频面|来公司|约个时间/,
    text: () => '时间可以，地点、对接人和面试形式发我一下。',
  },
  {
    id: 'R06',
    priority: 6,
    match: /薪资|工资|待遇|期望多少|多少钱|年包|税后|税前/,
    text: [
      () => '薪资按整体包看，细节电话说。',
      () => '薪资我按整体包来看，具体电话里谈。',
      () => '这个电话里说更合适，先聊岗位职责。',
    ],
  },
  {
    id: 'R04',
    priority: 7,
    match: /为什么离开|离职原因|换工作|为什么走/,
    text: () => '想找产品线和决策链更匹配的平台，具体电话说。',
  },
  {
    id: 'R05',
    priority: 8,
    match: /到岗|什么时候能来|入职时间|多久到/,
    text: () => '按交接走，具体时间电话定。',
  },
  {
    id: 'R18',
    priority: 8,
    match: /岗位职责|主要负责|做什么事|日常工作|工作内容|管什么/,
    text: () => '岗位内容我看了，主要是区域客户和渠道。具体分工电话聊。',
  },
  {
    id: 'R07',
    priority: 9,
    match: /常驻|出差|外派|驻场|跑外|外勤/,
    text: [
      () => '出差是常态。常驻外地要看具体城市，电话说。',
      () => '常年在外跑，出差没问题。常驻要看去哪，电话聊。',
    ],
  },
  {
    id: 'R08',
    priority: 10,
    match: /带几个|团队|下属|几个人/,
    text: () => '团队人数和分工电话里说，文字不好讲清。',
  },
  {
    id: 'R03',
    priority: 11,
    match: /在职|离职|目前状态|是否在看机会/,
    text: () => '在看机会，做了15年销售。交接有周期，细节电话说。',
  },
  {
    id: 'R02',
    priority: 12,
    match: /简历|附件|发一份|看一下简历|作品|项目资料/,
    action: 'agreeResume',
  },
  {
    id: 'R01',
    priority: 13,
    match: /在吗|方便吗|聊聊|看到你|看机会|沟通一下/,
    text: [
      () => '在，您说岗位和汇报关系，我看下。',
      () => '在，岗位情况和汇报关系发我，我这边看匹配度。',
      () => '在的，您把岗位重点说一下，我判断下合不合适。',
    ],
  },
  {
    id: 'R13',
    priority: 16,
    match: /不合适|不匹配|暂不考虑|已招满|已经招到/,
    text: () => '明白，后面有更匹配的再联系。',
  },
];

function hasBlacklist(text) {
  return BLACKLIST.some((w) => String(text).includes(w));
}

function polish(text) {
  let out = String(text || '').replace(/[!！]{2,}/g, '。').replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
  out = out.replace(/\s+/g, ' ').trim();
  if (hasBlacklist(out)) return '';
  if (/[0-9][0-9,.]*\s*(万|亿)/.test(out) || /[%％]/.test(out)) return '';
  // 最多三句
  const parts = out.split(/(?<=[。！？])/).filter(Boolean);
  return parts.slice(0, 3).join('').trim();
}

// 返回 {id, action, text, handoff}
// action: reply 直接发 text / agreeResume 点同意发简历 / skip 不回 / handoff 转人工
function fallbackReply(body) {
  const t = String(body || '');
  if (/公司|做什么|业务|产品线|规模/.test(t)) return '公司情况我大致看过，产品线和客户群电话里说。';
  if (/职责|负责|做什么事|岗位内容/.test(t)) return '岗位职责我看了，主要是区域客户和渠道，电话聊细节。';
  if (/年龄|多大|几年|工作多久/.test(t)) return '做销售15年，一直在一线带区域。';
  if (/学历|什么学校|文凭/.test(t)) return '大专，做销售看结果，学历这块不占优。';
  if (/广州|本地|住哪|哪人/.test(t)) return '在广州，常年在外面跑。';
  return '在，您说岗位和重点，我看下匹配度。';
}

function decide({ text = '', isMine = false, pick = null } = {}) {
  const body = String(text || '');
  if (isMine) return { id: 'none', action: 'skip' };
  if (/已发送附件简历|已将在线简历发至|发您在线简历|^(同意了|已同意)/.test(body)) return { id: 'none', action: 'skip' };
  if (RISK.test(body)) return { id: 'R17', action: 'pause', handoff: true };
  if (NON_HR.test(body)) return { id: 'R16', action: 'skip' };
  for (const rule of RULES) {
    if (!rule.match.test(body)) continue;
    if (rule.handoff) return { id: rule.id, action: 'handoff', handoff: true, text: '' };
    if (rule.action === 'agreeResume') return { id: rule.id, action: 'agreeResume', text: '' };
    const raw = rule.text;
    const list = Array.isArray(raw) ? raw : [raw];
    const idx = typeof pick === 'function' ? pick(rule.id, list.length) : 0;
    const item = list[Math.abs(Number(idx) || 0) % list.length];
    const text2 = polish(typeof item === 'function' ? item() : item);
    return { id: rule.id, action: 'reply', text: text2 };
  }
  const f = polish(fallbackReply(body));
  if (!f) return { id: 'R99', action: 'handoff', handoff: true, text: '' };
  return { id: 'R99', action: 'reply', text: f };
}

function inWorkHours(hour = new Date().getHours()) {
  return hour >= 9 && hour < 22;
}

module.exports = { decide, polish, inWorkHours, BLACKLIST, LEVEL };
