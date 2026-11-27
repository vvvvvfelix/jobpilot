// 多站点适配：不同招聘站点的入口地址、搜索模板、DOM 选择器、IM 能力。
// 选择器只是首选猜测，真正的兜底在 scraperMulti.js 里的启发式扫描。

const CITY = {
  guangzhou: '广州',
  shenzhen: '深圳',
  shanghai: '上海',
  beijing: '北京',
  hangzhou: '杭州',
  chengdu: '成都',
  wuhan: '武汉',
  nanjing: '南京',
};

const SITES = {
  zhaopin: {
    key: 'zhaopin',
    name: '智联招聘',
    hosts: ['zhaopin.com'],
    home: 'https://www.zhaopin.com/',
    resumeUrl: 'https://i.zhaopin.com/resume',
    messageUrl: 'https://i.zhaopin.com/im',
    searchTpl: 'https://www.zhaopin.com/jobs/?jl=763&kw={kw}',
    apply: true,
    chat: true,
    risk: '低',
    card: ['.job-card'],
    title: ['.job-card__title-main', '.job-card__title'],
    salary: ['.job-card__salary'],
    company: ['.job-card__company-name'],
    location: ['.job-card__location'],
    tags: ['.job-card__skill-tag'],
    detailBody: ['.job-detail-modules__detail', '.job-detail-panel'],
    imItem: ['.im-session-item'],
  },
  job51: {
    key: 'job51',
    name: '前程无忧 51job',
    hosts: ['51job.com', '51job.cn'],
    home: 'https://we.51job.com/pc/index',
    resumeUrl: 'https://www.51job.com/resume/center',
    // 51job 没有网页版 IM，站内沟通只给「微信扫码与HR沟通」，所以消息入口只给投递记录
    messageUrl: 'https://i.51job.com/userset/my_apply.php',
    searchTpl: 'https://we.51job.com/pc/search?keyword={kw}&jobArea=030200&searchType=2',
    apply: true,
    chat: false,
    risk: '低',
    card: ['.joblist-item', '.job-item', '.e'],
    title: ['.joblist-item-jobname', '.job-name', '.joblist-item .job-name'],
    salary: ['.joblist-item-salary', '.job-salary'],
    company: ['.joblist-item-compname', '.company-name'],
    location: ['.joblist-item-area', '.job-area'],
    tags: ['.joblist-item-tags', '.tags', '.joblist-item-labels'],
    detailBody: ['.job-detail', '.job-detail-box', '#jobdetail'],
    imItem: [],
  },
  liepin: {
    key: 'liepin',
    name: '猎聘',
    hosts: ['liepin.com'],
    home: 'https://www.liepin.com/',
    resumeUrl: 'https://h.liepin.com/resume/showresumedetail/',
    // 猎聘没有网页 IM：点「我的沟通」只给微信二维码，所以只做搜索+投递
    messageUrl: 'https://c.liepin.com/',
    searchTpl: 'https://www.liepin.com/zhaopin/?key={kw}&city=050020&dqs=050020',
    apply: true,
    chat: false,
    risk: '中',
    card: ['.job-list-item', '.job-card', '.job-list-box .job-card-pc'],
    title: ['.search-job-card-name', '.job-title-box .job-title', '.job-title', '.job-name'],
    salary: ['.search-job-card-salary', '.job-salary', '.job-salary-box'],
    company: ['.search-job-card-comp-name', '.search-job-card-company', '.company-name', '.company-name-box'],
    location: ['.search-job-card-location', '.job-dq', '.job-area', '.job-address'],
    tags: ['.search-job-card-tag', '.job-labels .label', '.labels .label', '.tag-list .tag'],
    detailBody: ['.job-intro-container', '.job-detail-box', '#job-intro-container'],
    imItem: ['.chat-item', '.session-item', '.conversation-item'],
  },
  boss: {
    key: 'boss',
    name: 'BOSS 直聘',
    hosts: ['zhipin.com', 'bosszhipin.com'],
    home: 'https://www.zhipin.com/web/geek/job',
    resumeUrl: 'https://www.zhipin.com/web/geek/resume',
    messageUrl: 'https://www.zhipin.com/web/geek/chat',
    searchTpl: 'https://www.zhipin.com/web/geek/job?query={kw}&city=101280100',
    apply: true,
    chat: true,
    risk: '高（风控严，建议低频）',
    card: ['.job-card-wrap', '.job-card-box'],
    title: ['.job-name', '.job-title'],
    salary: ['.job-salary'],
    company: ['.boss-name', '.company-name', '.boss-info'],
    location: ['.company-location', '.job-area'],
    tags: ['.tag-list li', '.tag-list span', '.tag-list'],
    detailBody: ['.job-sec-text', '.job-detail-section', '.job-detail'],
    imItem: ['.friend-content-warp', '.user-list-content', '.geek-item', '.chat-item'],
  },
  lagou: {
    key: 'lagou',
    name: '拉勾',
    hosts: ['lagou.com'],
    home: 'https://www.lagou.com/wn/jobs',
    messageUrl: 'https://www.lagou.com/im/',
    resumeUrl: 'https://www.lagou.com/wn/resume/myresume',
    searchTpl: 'https://www.lagou.com/wn/jobs?kd={kw}&city={city}',
    apply: true,
    chat: true,
    risk: '中',
    card: ['.item__content', '.position-item', '.item'],
    title: ['.position__name', '.position-name', '.position_link h3'],
    salary: ['.position__sal', '.salary', '.money'],
    company: ['.company-name', '.company'],
    location: ['.position__address', '.address', '.position_link .add'],
    tags: ['.position__labels .label', '.labels .label', '.li_b_l'],
    detailBody: ['.job-detail', '.position-detail', '.job_bt'],
    imItem: ['.chat-item', '.session-item', '.conversation-item'],
  },
};

const GENERIC = {
  key: 'generic',
  name: '其他站点（通用启发式）',
  hosts: [],
  home: '',
  apply: true,
  chat: true,
  risk: '未知',
  card: [],
  title: [],
  salary: [],
  company: [],
  location: [],
  tags: [],
  detailBody: [],
  imItem: [],
};

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function detect(url) {
  const host = hostOf(url);
  if (!host) return GENERIC;
  for (const site of Object.values(SITES)) {
    if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site;
  }
  return GENERIC;
}

function list() {
  return [...Object.values(SITES), GENERIC].map((s) => ({
    key: s.key,
    name: s.name,
    home: s.home || '',
    apply: Boolean(s.apply),
    chat: Boolean(s.chat),
    risk: s.risk || '',
  }));
}

function searchUrl(key, kw = '销售', city = '广州') {
  const site = SITES[key];
  if (!site || !site.searchTpl) return '';
  const cityKey = Object.keys(CITY).find((k) => CITY[k] === city) || 'guangzhou';
  return site.searchTpl
    .replace('{kw}', encodeURIComponent(kw))
    .replace('{city}', encodeURIComponent(city))
    .replace('{cityKey}', cityKey);
}

module.exports = { SITES, GENERIC, CITY, detect, list, searchUrl, hostOf };
