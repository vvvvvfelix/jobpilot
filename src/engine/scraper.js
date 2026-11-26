// 所有函数都是"将在页面内执行"的字符串，主进程通过 webContents.executeJavaScript 注入。

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
`;

const SCRAPE_JOBS = `(() => {
  ${HELPERS}
  const cards = $$('.job-card').filter(visible);
  const items = cards.map((card, index) => {
    const title = txt($('.job-card__title-main', card)) || txt($('.job-card__title', card)) || txt($('[class*="title-main"]', card));
    const salary = txt($('.job-card__salary', card));
    const tagsRaw = $$('.job-card__skill-tag', card).map(txt).filter(Boolean);
    const tags = tagsRaw.length ? tagsRaw : txt($('.job-card__skill-tags', card)).split(' ').filter(Boolean);
    const company = txt($('.job-card__company-name', card)) || txt($('[class*="company-name"]', card));
    const location = txt($('.job-card__location', card));
    return { index, title, salary, tags, company, location, text: txt(card).slice(0, 400) };
  }).filter((j) => j.title || j.company);
  return JSON.stringify({ url: location.href, count: items.length, jobs: items });
})()`;

const SCRAPE_DETAIL = `(() => {
  ${HELPERS}
  const title = txt($('.job-detail-summary__title-text'))
    || txt($('.job-detail-summary__title'))
    || txt($('h1'))
    || txt($('[class*="job-title"], [class*="jobTitle"], [class*="position-title"]'));
  const company = txt($('.job-detail-summary__company'))
    || txt($('[class*="company-name"], [class*="companyName"]'));
  const salary = txt($('.job-detail-summary__salary'))
    || txt($('[class*="salary"]'));
  const body = txt($('.job-detail-modules__detail, .job-detail-panel, [class*="job-detail-describ"], [class*="describ"]'))
    || txt($('[class*="job-detail"]'))
    || txt($('main, body')).slice(0, 20000);
  const applyBtn = $('.job-detail-summary__apply, button[class*="job-detail-summary__apply"]')
    || byText(/立即申请|申请职位|投递简历|立即投递|我要申请/, 'button,a,div,span')[0];
  const chatBtn = byText(/立即沟通|聊一聊|和TA聊聊/, 'button,a,div,span')[0];
  return JSON.stringify({
    url: location.href,
    title, company, salary,
    body: (body || '').slice(0, 20000),
    applyLabel: applyBtn ? txt(applyBtn) : null,
    chatLabel: chatBtn ? txt(chatBtn) : null,
  });
})()`;

const CLICK_JOB_CARD = (index) => `(() => {
  ${HELPERS}
  const cards = $$('.job-card').filter((el) => el.getBoundingClientRect().height > 10);
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card not found' });
  card.click();
  return JSON.stringify({ ok: true, clicked: true, total: cards.length });
})()`;

const CLICK_APPLY = `(() => {
  ${HELPERS}
  const primary = $('.job-detail-summary__apply, button[class*="job-detail-summary__apply"]');
  const candidates = primary ? [primary] : byText(/立即申请|申请职位|投递简历|立即投递|我要申请/, 'button,a,div,span');
  const btn = candidates[0];
  if (!btn) return JSON.stringify({ ok: false, reason: 'apply button not found' });
  const label = txt(btn);
  btn.click();
  return JSON.stringify({ ok: true, label });
})()`;

const CONFIRM_DIALOG = `(() => {
  ${HELPERS}
  const dialogs = $$('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]').filter(visible);
  for (const d of dialogs) {
    const ok = byText(/^确定$|^确认$|^确认投递$|^立即投递$|^投递$|^申请$/, 'button,a,div,span').find((el) => d.contains(el));
    if (ok) {
      const label = txt(ok);
      ok.click();
      return JSON.stringify({ ok: true, label, scope: txt(d).slice(0, 80) });
    }
  }
  return JSON.stringify({ ok: false, reason: 'no confirm button' });
})()`;

const SCRAPE_MESSAGES = `(() => {
  ${HELPERS}
  const im = $$('.im-session-item').filter(visible);
  if (im.length) {
    const items = im.slice(0, 40).map((el, index) => ({
      index,
      name: txt($('.im-session-item__name', el)),
      company: txt($('.im-session-item__company-name', el)) || txt($('.im-session-item__company', el)),
      title: txt($('.im-session-item__job', el)),
      salary: txt($('.im-session-item__salary', el)),
      time: txt($('.im-session-item__time', el)),
      text: txt($('.im-session-item__preview-text', el)) || txt(el).slice(0, 200),
      unread: !!$('[class*="unread"], [class*="badge"]', el),
      preview: txt(el).slice(0, 200),
    }));
    return JSON.stringify({ url: location.href, count: items.length, unreadCount: items.filter((i) => i.unread).length, items, layout: 'im' });
  }
  const list = $$('[class*="conversation"], [class*="chat-item"], [class*="message-item"], [class*="session-item"]').filter(visible);
  const items = list.slice(0, 30).map((el, index) => ({
    index,
    preview: txt(el).slice(0, 200),
    text: txt(el).slice(0, 200),
    unread: !!$('[class*="unread"], [class*="badge"]', el),
  }));
  return JSON.stringify({ url: location.href, count: items.length, unreadCount: items.filter((i) => i.unread).length, items, layout: 'legacy' });
})()`;

const OPEN_CONVERSATION = (index) => `(() => {
  ${HELPERS}
  const im = $$('.im-session-item').filter(visible);
  const item = im[${index}] || $$('[class*="conversation"], [class*="chat-item"], [class*="session-item"]').filter(visible)[${index}];
  if (!item) return JSON.stringify({ ok: false, reason: 'conversation not found' });
  item.click();
  const title = txt($('.im-chat-header__name')) || txt($('.im-chat-header__title-row'));
  return JSON.stringify({ ok: true, title, preview: txt(item).slice(0, 120) });
})()`;

const READ_THREAD = `(() => {
  ${HELPERS}
  const chat = $('.im-main-panel__chat') || document.body;
  const bubbles = $$('.im-message__bubble', chat).filter(visible);
  if (bubbles.length) {
    const cr = chat.getBoundingClientRect();
    const messages = bubbles.slice(-30).map((el) => {
      const r = el.getBoundingClientRect();
      const cls = String(el.className || '');
      const isMine = /mine|self|right|--me/.test(cls) || (r.left + r.width / 2) > cr.left + cr.width * 0.72;
      return { text: txt($('.im-message__bubble-inner', el)) || txt(el), isMine };
    }).filter((m) => m.text);
    return JSON.stringify({ count: messages.length, messages, threadText: messages.map((m) => (m.isMine ? '[我] ' : '[对方] ') + m.text).join('\\n') });
  }
  const legacy = $$('[class*="bubble"], [class*="msg-item"], [class*="message-content"]').filter(visible);
  const messages = legacy.slice(-20).map((el) => ({ text: txt(el).slice(0, 500), isMine: /right|mine|self|own/i.test(el.className || '') }));
  return JSON.stringify({ count: messages.length, messages });
})()`;

const SEND_MESSAGE = (text) => `(async () => {
  ${HELPERS}
  const value = ${JSON.stringify(text)};
  const box = $('.im-sender__input') || $$('textarea, [contenteditable="true"]').filter(visible).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!box) return JSON.stringify({ ok: false, reason: 'input not found' });
  const before = $$('.im-message__bubble').length;
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
  const sendBtn = $$('button,div,span').filter((el) => visible(el) && /^发送$/.test(txt(el)))[0];
  if (sendBtn) sendBtn.click();
  else {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  const after = $$('.im-message__bubble').length;
  const cleared = !box.value || box.value.trim() === '';
  return JSON.stringify({ ok: after > before || cleared, before, after, cleared });
})()`;

// 智联的「我想要一份你的简历，你是否同意？」卡片：点「同意」平台会自动选在线简历发过去
const RESUME_AGREE = `(() => {
  ${HELPERS}
  const bubbles = $$('.im-message__bubble').filter(visible).filter((el) => /简历/.test(txt(el)));
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

const EXPAND_RESUME = `(() => {  ${HELPERS}
  const labels = /^(查看全部|展开全部|查看更多|展开更多)$/;
  let clicked = 0;
  for (const el of $$('a,button,span,div')) {
    const t = txt(el);
    if (!labels.test(t)) continue;
    const box = el.getBoundingClientRect();
    if (!box.height && !box.width) continue;
    try { el.click(); clicked += 1; } catch {}
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  return JSON.stringify({ clicked });
})()`;

const SCRAPE_RESUME = `(() => {
  ${HELPERS}
  const body = txt($('body'));
  const lost = /页面不小心走丢了|页面不存在|404/i.test(body);
  const loggedOut = !/欢迎回来|退出/.test(body) && /登录\\s*\\/?\\s*注册/.test(body);
  const noise = /^(广州站( \\[切换城市\\])?|消息|扫码进公众号|扫码下载APP|首页|职位|刷新简历|Hi，.*|求职快人一步，?|GO|编辑|保存|取消|下载|打印|在线简历|附件简历|预览)$/;
  const order = ['.zp-main-center', '#resume', '[class*="resume-detail"]', '[class*="resume-preview"]', '[class*="resume-content"]'];
  let el = null;
  for (const sel of order) {
    const cand = $$(sel).find((c) => txt(c).length > 250);
    if (cand) { el = cand; break; }
  }
  if (!el) el = $('body')[0];
  const placeholders = /^(收起|展开|必填|添加求职意向|添加工作经验|添加教育经历|添加项目经历|添加培训经历|添加语言能力|添加专业技能|添加证书|添加附件|上传新附件)$/;
  const rawText = String(el.innerText || '').replace(/\\u00a0/g, ' ');
  const lines = rawText
    .split('\\n')
    .map((l) => l.replace(/\\s+/g, ' ').replace(/\\s*必填$/, '').trim())
    .filter((l) => l && !noise.test(l) && !placeholders.test(l));
  const text = lines.join('\\n');
  return JSON.stringify({ url: location.href, title: document.title, chars: text.length, lines: lines.length, loggedOut, lost, text });
})()`;

const PAGE_INFO = `(() => JSON.stringify({ url: location.href, title: document.title }))()`;

module.exports = {
  PAGE_INFO,
  EXPAND_RESUME,
  SCRAPE_JOBS,
  SCRAPE_DETAIL,
  SCRAPE_RESUME,
  CLICK_JOB_CARD,
  CLICK_APPLY,
  CONFIRM_DIALOG,
  SCRAPE_MESSAGES,
  OPEN_CONVERSATION,
  READ_THREAD,
  SEND_MESSAGE,
  RESUME_AGREE,
  HAS_AGREE,
};

