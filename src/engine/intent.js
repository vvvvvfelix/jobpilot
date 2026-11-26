// 把「求职需求」里用户自己写的话解析成结构化偏好，供打分和模型判断使用
// 例："想找一年出差 300 天的工作，最好自驾" → travelDays=300, selfDrive=true
const CITY_LIST = ['广州', '深圳', '上海', '北京', '杭州', '成都', '武汉', '南京', '苏州', '东莞', '佛山', '中山', '珠海', '惠州', '厦门', '长沙', '重庆', '西安', '天津', '青岛', '郑州', '合肥', '宁波', '无锡', '泉州', '福州', '海口', '南宁', '昆明', '贵阳', '南昌', '济南', '石家庄', '太原', '沈阳', '大连', '长春', '哈尔滨', '乌鲁木齐', '兰州', '银川', '西宁', '呼和浩特', '拉萨'];

const TYPE_WORDS = [
  { re: /快递|收派员|派件|揽件/, key: '快递' },
  { re: /外卖|骑手|送餐|跑腿/, key: '外卖骑手' },
  { re: /保险|寿险|财险|续保/, key: '保险' },
  { re: /保健品|保健食品|会销/, key: '保健品' },
  { re: /电话销售|电销|外呼/, key: '电话销售' },
];

function parseTravelDays(text) {
  const t = String(text || '');
  const num = /(?:出差|在外|外勤|跑外)[^\d]{0,6}(\d{2,3})\s*天/.exec(t) || /(\d{2,3})\s*天[^\d]{0,4}(?:出差|在外)/.exec(t);
  if (num) {
    const n = Number(num[1]);
    if (n > 0 && n <= 366) return n;
  }
  if (/经常出差|长期出差|常年出差|大半时间在外|到处飞|常年在外/.test(t)) return 200;
  if (/偶尔出差|少量出差/.test(t)) return 30;
  if (/不想出差|少出差|不出差|坐班/.test(t)) return 0;
  return null;
}

function parseSalary(text) {
  const t = String(text || '');
  const k = /(\d+(?:\.\d+)?)\s*[kK千]\s*(?:以上|起|\+)?/.exec(t);
  if (k) return Math.round(Number(k[1]) * 1000);
  const wan = /(\d+(?:\.\d+)?)\s*万\s*(?:\/月|每月|月)?/.exec(t);
  if (wan) return Math.round(Number(wan[1]) * 10000);
  const yuan = /(\d{4,6})\s*元\s*(?:以上|起|\/月)?/.exec(t);
  if (yuan) return Number(yuan[1]);
  return null;
}

function parseRole(text) {
  const t = String(text || '');
  const roles = ['销售总监', '销售经理', '区域经理', '大客户经理', 'KA经理', '渠道经理', '招商经理', '销售工程师', '客户经理'];
  const hit = roles.find((r) => t.includes(r));
  if (hit) return hit;
  if (/渠道/.test(t)) return '渠道销售';
  if (/大客户|KA/i.test(t)) return '大客户销售';
  if (/招商/.test(t)) return '招商';
  if (/销售/.test(t)) return '销售';
  return null;
}

function parse(text, fallback = {}) {
  const t = String(text || '');
  const city = CITY_LIST.find((c) => t.includes(c)) || fallback.city || '';
  const travelDays = parseTravelDays(t);
  const salaryMin = parseSalary(t) || Number(fallback.salaryMin || 0) || null;
  const selfDrive = /自驾|开车|自己有车|有车|油补|车补/.test(t);
  const role = parseRole(t) || fallback.title || '';
  const excludes = TYPE_WORDS.filter((x) => {
    // 只有明确写"不要/不接受/排除"才算排除，避免把"能做电话销售"误判
    const near = new RegExp(`(不|别|排除|拒绝|不考虑|不要)[^，。]{0,8}${x.key === '外卖骑手' ? '外卖|骑手' : x.key}`);
    return near.test(t);
  }).map((x) => x.key);
  const management = /带团队|管理岗|带人|团队管理/.test(t) ? true : /不带人|个人贡献|独立做/.test(t) ? false : null;
  return {
    city,
    salaryMin,
    travelDays,
    selfDrive,
    role,
    management,
    excludes,
    raw: t.slice(0, 200),
    updatedAt: Date.now(),
  };
}

// 岗位文案里是否满足出差/自驾偏好，返回加减分和理由
function scoreAgainstPrefs(job, prefs = {}) {
  const text = `${job.title || ''} ${(job.tags || []).join(' ')} ${job.detail || ''}`;
  const reasons = [];
  let delta = 0;
  const travel = Number(prefs.travelDays);
  const noTravel = /无需出差|不需出差|不用出差|坐班|固定办公/.test(text);
  if (Number.isFinite(travel) && travel >= 120) {
    if (noTravel) {
      delta -= 12;
      reasons.push('岗位偏坐班，不符合你的出差强度');
    } else if (/出差|外派|驻地|外勤|跑市场|跑区域|区域市场|巡店|拜访/.test(text)) {
      delta += 8;
      reasons.push(`岗位有出差/外勤要求，符合你想跑 ${travel} 天`);
    }
  } else if (travel === 0 && /经常出差|长期驻外|常年出差/.test(text)) {
    delta -= 10;
    reasons.push('岗位要长期出差，和你想坐班冲突');
  }
  if (prefs.selfDrive) {
    if (/自驾|车辆|油补|车补|私车|配车/.test(text)) {
      delta += 5;
      reasons.push('岗位提供自驾/车补条件');
    }
  }
  if (prefs.management === true && /经理|主管|总监|负责人|团队/.test(String(job.title || ''))) {
    delta += 3;
  }
  return { delta, reasons };
}

module.exports = { parse, scoreAgainstPrefs, parseTravelDays, parseSalary };
