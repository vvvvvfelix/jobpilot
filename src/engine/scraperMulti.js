// 通用站点抓取脚本：优先用各站点的选择器，抓不到就退回启发式扫描（看薪资格式、卡片尺寸、文本行）。
// 所有导出都是"要在页面里执行"的字符串，主进程用 webContents.executeJavaScript 注入。

const HELPERS = `
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ') : '');
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const byText = (regex, tags = 'button,a,div,span') =>
    $$(tags).filter((el) => visible(el) && regex.test(txt(el))).sort((a, b) => txt(a).length - txt(b).length);
  const cfg = SITE_CFG;
`;

const SALARY_RE =
  '/(\\d+(?:\\.\\d+)?\\s*[kK千万]?\\s*[-–—~至]\\s*\\d+(?:\\.\\d+)?\\s*[kK万千元]|\\d+\\s*[kK万]\\s*以上|面议|薪资面议)/';

const CITY_RE =
  '/(广州|深圳|上海|北京|杭州|成都|武汉|南京|东莞|佛山|珠海|惠州|中山|苏州|长沙|厦门|西安|重庆|天津|青岛|郑州|合肥|福州|南宁|昆明|南昌|贵阳|海口|济南|沈阳|大连|哈尔滨|长春|石家庄|太原|兰州|乌鲁木齐|宁波|温州|无锡|常州|嘉兴|金华|台州|泉州|汕头|湛江|江门|肇庆|清远|韶关|茂名|阳江|潮州|揭阳|梅州|河源|汕尾|柳州|桂林|株洲|湘潭|衡阳|岳阳|宜昌|襄阳|洛阳|开封|新乡|烟台|潍坊|淄博|临沂|徐州|盐城|扬州|泰州|镇江|芜湖|蚌埠|包头|三亚)/';

const withCfg = (site, body) =>
  body.replace('SITE_CFG', JSON.stringify({
    key: site.key,
    name: site.name,
    card: site.card || [],
    title: site.title || [],
    salary: site.salary || [],
    company: site.company || [],
    location: site.location || [],
    tags: site.tags || [],
    detailBody: site.detailBody || [],
    imItem: site.imItem || [],
  }));

const JOBS = (site) => withCfg(site, `(() => {
  ${HELPERS}
  const SAL = ${SALARY_RE};
  const CITY = ${CITY_RE};
  const pick = (root, sels) => {
    for (const s of sels) {
      const el = root.querySelector(s);
      if (el) { const t = txt(el); if (t) return t; }
    }
    return '';
  };
  // 先按站点选择器找卡片，不够就用启发式
  let cards = [];
  for (const s of cfg.card) {
    const found = $$(s).filter(visible);
    if (found.length > cards.length) cards = found;
  }
  if (cards.length < 2) {
    const cand = $$('div,li,article,section').filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 44 || r.height > 460) return false;
      const t = txt(el);
      if (t.length < 8 || t.length > 900) return false;
      return SAL.test(t);
    });
    cards = cand.filter((el) => !cand.some((o) => o !== el && el.contains(o)));
  }
  const classPick = (root, words, maxLen = 40) => {
    for (const el of root.querySelectorAll('[class]')) {
      const cls = String(el.className || '').toLowerCase();
      if (!cls || !words.some((w) => cls.includes(w))) continue;
      const t = txt(el);
      if (t && t.length <= maxLen) return t;
    }
    return '';
  };
  const ROLE_RE = /(经理|主管|总监|销售|工程|顾问|专员|助理|代表|BD|运营|产品|技术|渠道|客户|大客户|讲师|策划|设计|开发|招商)/;
  const BADGE_RE = /^(名企|急招|热招|新招|高新技术企业|财富中国500强|创新企业100强|制造业500强|专精特新|独角兽|NEW|本周活跃|回复率高|喜欢聊天|今日活跃|\\d+天内处理简历|刚刚活跃|在线)$/;
  const COMPANY_RE = /(公司|集团|科技|有限|实业|贸易|网络|信息|电子|银行|保险|证券|物流|机械|品牌|教育|医疗|地产|传媒|咨询|材料|设备|自动化|软件)/;
  const items = cards.map((card, index) => {
    const lines = (card.innerText || '').split('\\n').map((l) => l.trim()).filter(Boolean);
    const joined = lines.join(' ');
    const salary = pick(card, cfg.salary) || (joined.match(SAL) || [])[0] || '';
    let rawTitle = pick(card, cfg.title) || '';
    if (!rawTitle || rawTitle.length < 4 || !ROLE_RE.test(rawTitle) || BADGE_RE.test(rawTitle)) {
      rawTitle = lines.find((l) => ROLE_RE.test(l) && l.length <= 44 && !SAL.test(l) && !BADGE_RE.test(l)) || rawTitle;
    }
    const title = rawTitle.replace(salary, '').replace(/\\[[^\\]]*\\]$/, '').trim();
    const jobLocation = pick(card, cfg.location)
      || classPick(card, ['area', 'city', 'dq', 'address', 'locat', 'addr'], 20)
      || (rawTitle.match(/\\[[^\\]]*\\]$/) ? rawTitle.match(/\\[[^\\]]*\\]$/)[0].replace(/[\\[\\]]/g, '') : '')
      || (joined.match(CITY) || [])[0]
      || '';
    const company = pick(card, cfg.company)
      || lines.find((l) => l !== rawTitle && l !== salary && l !== jobLocation
        && l.length >= 3 && l.length <= 40
        && COMPANY_RE.test(l)
        && !SAL.test(l))
      || classPick(card, ['companyname', 'compname', 'company-name', 'company_name', 'brand'], 40)
      || '';
    const tags = $$('span,li,a,em', card).map(txt).filter((t) => t && t.length <= 12 && /(\\d+[-–]\\d+年|\\d+年以上|经验不限|应届|学历不限|大专|本科|硕士|博士|中专|高中)/.test(t));
    return { index, title, salary, tags, company, location: jobLocation, text: joined.slice(0, 400) };
  }).filter((j) => j.title || j.company);
  return JSON.stringify({ url: location.href, site: cfg.key, count: items.length, jobs: items });
})()`);

const DETAIL = (site) => withCfg(site, `(() => {
  ${HELPERS}
  const pick = (sels) => {
    for (const s of sels) {
      const el = $(s);
      if (el) { const t = txt(el); if (t) return t; }
    }
    return '';
  };
  let title = pick(cfg.title) || pick(['.cn', '[class*="job-title"]', '[class*="jobTitle"]', 'h1', 'h2']) || document.title.replace(/[-_|].*$/, '').trim();
  let company = pick(cfg.company) || pick(['[class*="company-name"]', '[class*="companyName"]', '[class*="comp-name"]', '.cname']);
  let salary = pick(cfg.salary) || pick(['[class*="salary"]', '.money', '.t1']);
  // 老版详情页把薪资、地点、经验挤在一行（如「8千-1万·13薪 广州-白云区 2年及以上」），整页兜底捞一遍
  if (!salary) {
    const SAL = ${SALARY_RE};
    salary = (txt($('.cn') || document.body).slice(0, 240).match(SAL) || [])[0] || '';
  }
  if (salary && title.includes(salary)) title = title.slice(0, title.indexOf(salary)).trim();
  if (!company) {
    const blockEl = $('[class*="job-corp"] .tmsg') || $('[class*="job-corp"] .bname ~ *, .tcompany, [class*="company-info"], .tCompany');
    const blockTxt = txt(blockEl).replace(/^公司信息\\s*/, '');
    company = (blockTxt.match(/([\\u4e00-\\u9fa5A-Za-z0-9()（）]{2,28}(?:有限公司|公司|集团))/) || [])[1] || '';
  }
  let bodyEl = null;
  for (const s of cfg.detailBody.concat(['[class*="job-detail"]', '[class*="job-desc"]', '[class*="jobdesc"]', '[class*="position-detail"]', 'main', 'article'])) {
    const cand = $$(s).find((c) => txt(c).length > 220);
    if (cand) { bodyEl = cand; break; }
  }
  const body = txt(bodyEl || document.body).slice(0, 20000);
  const applyBtn = byText(/立即申请|申请职位|投递简历|立即投递|我要申请|一键投递|继续沟通/)[0];
  const chatBtn = byText(/立即沟通|聊一聊|和TA聊聊|打个招呼|继续沟通/)[0];
  return JSON.stringify({
    url: location.href, site: cfg.key, title, company, salary,
    body,
    applyLabel: applyBtn ? txt(applyBtn) : null,
    chatLabel: chatBtn ? txt(chatBtn) : null,
  });
})()`);

const CLICK_CARD = (site, index) => withCfg(site, `(() => {
  ${HELPERS}
  const SAL = ${SALARY_RE};
  let cards = [];
  for (const s of cfg.card) {
    const found = $$(s).filter((el) => el.getBoundingClientRect().height > 10);
    if (found.length > cards.length) cards = found;
  }
  if (cards.length < 2) {
    const cand = $$('div,li,article,section').filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 44 || r.height > 460) return false;
      const t = txt(el);
      return t.length >= 8 && t.length <= 900 && SAL.test(t);
    });
    cards = cand.filter((el) => !cand.some((o) => o !== el && el.contains(o)));
  }
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card not found', total: cards.length });
  card.click();
  return JSON.stringify({ ok: true, clicked: true, total: cards.length });
})()`);

const APPLY = (site) => withCfg(site, `(() => {
  ${HELPERS}
  const btn = byText(/立即申请|申请职位|投递简历|立即投递|我要申请|一键投递|继续沟通|立即沟通|聊一聊|和TA聊聊/)[0];
  if (!btn) return JSON.stringify({ ok: false, reason: 'apply button not found' });
  const label = txt(btn);
  btn.click();
  return JSON.stringify({ ok: true, label });
})()`);

const CONFIRM = (site) => withCfg(site, `(() => {
  ${HELPERS}
  const dialogs = $$('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"], [class*="confirm"]').filter(visible);
  for (const d of dialogs) {
    const ok = byText(/^确定$|^确认$|^确认投递$|^立即投递$|^投递$|^申请$|^确认沟通$/, 'button,a,div,span').find((el) => d.contains(el));
    if (ok) {
      const label = txt(ok);
      ok.click();
      return JSON.stringify({ ok: true, label, scope: txt(d).slice(0, 80) });
    }
  }
  return JSON.stringify({ ok: false, reason: 'no confirm button' });
})()`);

const MESSAGES = (site) => withCfg(site, `(() => {
  ${HELPERS}
  let items = [];
  for (const s of cfg.imItem) {
    const found = $$(s).filter(visible);
    if (found.length > items.length) items = found;
  }
  if (!items.length) {
    items = $$('[class*="conversation"], [class*="chat-item"], [class*="session"], [class*="dialog-item"], [class*="friend"]')
      .filter(visible)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 150 && r.height > 40 && r.height < 160;
      });
  }
  const clsPick = (root, words, max = 40) => {
    for (const e of root.querySelectorAll('[class]')) {
      const c = String(e.className || '').toLowerCase();
      if (!c || !words.some((w) => c.includes(w))) continue;
      const s = txt(e);
      if (s && s.length <= max) return s;
    }
    return '';
  };
  const list = items.slice(0, 40).map((el, index) => {
    const lines = (el.innerText || '').split('\\n').map((l) => l.trim()).filter(Boolean);
    const unread = Boolean($('[class*="unread"], [class*="badge"], [class*="red-dot"], [class*="num"]', el));
    const name = clsPick(el, ['name-box', 'nickname', 'user-name'], 30)
      || lines.find((l) => /(先生|女士|HR|招聘|经理|主管|总监|顾问|BD|专员|助理)/i.test(l))
      || lines[0]
      || '';
    const time = clsPick(el, ['time', 'date'], 20) || lines.find((l) => /(今天|昨天|\\d{1,2}:\\d{2}|月.*日)/.test(l)) || '';
    const preview = clsPick(el, ['preview', 'last-msg', 'msg-text'], 120)
      || lines.filter((l) => l !== name && l !== time && !/(今天|昨天|\\d{1,2}:\\d{2}|月.*日)/.test(l)).pop()
      || '';
    return {
      index,
      name,
      company: clsPick(el, ['company', 'brand', 'comp'], 30) || '',
      title: '',
      time,
      text: txt(el).slice(0, 200),
      preview,
      unread,
    };
  }).filter((i) => i.name || i.text);
  return JSON.stringify({
    url: location.href, site: cfg.key, count: list.length,
    unreadCount: list.filter((i) => i.unread).length, items: list, layout: cfg.key,
  });
})()`);

const OPEN_CONV = (site, index) => withCfg(site, `(() => {
  ${HELPERS}
  let items = [];
  for (const s of cfg.imItem) {
    const found = $$(s).filter(visible);
    if (found.length > items.length) items = found;
  }
  if (!items.length) {
    items = $$('[class*="conversation"], [class*="chat-item"], [class*="session"], [class*="dialog-item"], [class*="friend"]').filter(visible);
  }
  const item = items[${index}];
  if (!item) return JSON.stringify({ ok: false, reason: 'conversation not found' });
  item.click();
  return JSON.stringify({ ok: true, preview: txt(item).slice(0, 120) });
})()`);

// 会话条目的屏幕坐标：CDP 下用真实鼠标点击，比 JS click 可靠（BOSS 对合成 click 不响应）
const ITEM_POINT = (site, index) => withCfg(site, `(() => {
  ${HELPERS}
  let items = [];
  for (const s of cfg.imItem) {
    const found = $$(s).filter(visible);
    if (found.length > items.length) items = found;
  }
  const item = items[${index}];
  if (!item) return JSON.stringify({ ok: false, reason: 'conversation not found', count: items.length });
  const r = item.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return JSON.stringify({ ok: false, reason: 'item invisible' });
  return JSON.stringify({
    ok: true,
    x: Math.round(r.left + Math.min(r.width / 2, 60)),
    y: Math.round(r.top + Math.min(r.height / 2, 24)),
    preview: txt(item).slice(0, 120),
  });
})()`);

const READ_THREAD = (site) => withCfg(site, `(() => {
  ${HELPERS}
  let bubbles = $$('[class*="message-item"], [class*="msg-item"], [class*="chat-msg"], [class*="bubble"]')
    .filter(visible)
    .filter((el) => txt(el).length > 0);
  if (!bubbles.length) {
    bubbles = $$('[class*="message-content"], [class*="msg-content"]').filter(visible).filter((el) => txt(el).length > 0);
  }
  const cr = ($$('[class*="chat-content"], [class*="chat-panel"], [class*="message-panel"], main').find(visible) || document.body).getBoundingClientRect();
  const messages = bubbles.slice(-30).map((el) => {
    const r = el.getBoundingClientRect();
    const cls = String(el.className || '');
    const isMine = /item-myself|item-me|myself|mine|self|right|--me|own/.test(cls)
      || (!/item-friend|friend/.test(cls) && r.width > 0 && (r.left + r.width / 2) > cr.left + cr.width * 0.7);
    return { text: txt(el).slice(0, 500), isMine };
  }).filter((m) => m.text);
  return JSON.stringify({
    count: messages.length,
    messages,
    threadText: messages.map((m) => (m.isMine ? '[我] ' : '[对方] ') + m.text).join('\\n'),
  });
})()`);

const SEND = (site, text) => withCfg(site, `(async () => {
  ${HELPERS}
  const value = ${JSON.stringify(String(text || ''))};
  const box = $$('textarea, [contenteditable="true"], [class*="input"] textarea').filter(visible)
    .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!box) return JSON.stringify({ ok: false, reason: 'input not found' });
  const before = $$('[class*="bubble"], [class*="message-item"], [class*="chat-msg"]').length;
  box.focus();
  if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    document.execCommand('insertText', false, value);
  }
  await new Promise((r) => setTimeout(r, 400));
  const sendBtn = $$('button,div,span,a').filter((el) => visible(el) && /^(发送|发送消息|发出)$/.test(txt(el)))[0];
  if (sendBtn) sendBtn.click();
  else {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  const after = $$('[class*="bubble"], [class*="message-item"], [class*="chat-msg"]').length;
  const cleared = !box.value || box.value.trim() === '';
  return JSON.stringify({ ok: after > before || cleared, before, after, cleared });
})()`);

const AGREE_RESUME = `(() => {
  ${HELPERS}
  const bubbles = $$('[class*="bubble"], [class*="message-item"], [class*="chat-msg"]').filter(visible).filter((el) => /简历/.test(txt(el)));
  for (const el of bubbles.reverse()) {
    const agree = $$('button, div, span, a', el).filter((b) => visible(b) && /^同意$/.test(txt(b)))[0];
    if (agree) {
      agree.click();
      return JSON.stringify({ ok: true, text: txt(el).slice(0, 60) });
    }
  }
  return JSON.stringify({ ok: false, reason: 'no agree button' });
})()`;

const HAS_AGREE = `(() => {
  ${HELPERS}
  const btns = $$('button,div,span,a').filter((b) => visible(b) && /^同意$/.test(txt(b)));
  return JSON.stringify({ count: btns.length });
})()`;

// 自检用：把页面上像卡片/会话的元素类名吐出来，方便按真实 DOM 校准选择器
const DOM_DUMP = (site) => withCfg(site, `(() => {
  ${HELPERS}
  const SAL = ${SALARY_RE};
  const t = (e) => (e ? (e.innerText || '').trim().replace(/\\s+/g, ' ') : '');
  const cand = $$('div,li,section,article').filter((el) => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 44 || r.height > 460) return false;
    const s = txt(el);
    return s.length >= 8 && s.length <= 900 && (SAL.test(s) || /公司|集团|有限|经理|主管|销售/.test(s));
  }).slice(0, 6);
  const chat = $$('[class*="chat"], [class*="session"], [class*="conversation"], [class*="message"], [class*="user-list"], [class*="item"]')
    .filter(visible)
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height > 40 && r.height < 160; })
    .slice(0, 6);
  const brief = (list) => list.map((el) => ({
    cls: String(el.className || '').slice(0, 90),
    text: t(el).slice(0, 60),
    kids: [...el.querySelectorAll('[class]')].slice(0, 8).map((k) => String(k.className || '').slice(0, 50) + '=' + t(k).slice(0, 18)),
  }));
  return JSON.stringify({ url: location.href, site: cfg.key, jobLike: brief(cand), chatLike: brief(chat) });
})()`);

module.exports = { JOBS, DETAIL, CLICK_CARD, APPLY, CONFIRM, MESSAGES, OPEN_CONV, ITEM_POINT, READ_THREAD, SEND, AGREE_RESUME, HAS_AGREE, DOM_DUMP };
