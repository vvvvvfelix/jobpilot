const scraper = require('./scraper');
const multi = require('./scraperMulti');
const sites = require('./sites');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparsable', raw: String(text).slice(0, 200) };
  }
}

async function run(wc, script) {
  const raw = await wc.executeJavaScript(script, true);
  return parseJson(raw);
}

function siteOf(wc) {
  try {
    return sites.detect(wc.getURL());
  } catch {
    return sites.GENERIC;
  }
}

// 智联的 DOM 已经验证过，继续用它原来那套；其他站点走通用适配
function useLegacy(wc) {
  return siteOf(wc).key === 'zhaopin';
}

async function pageInfo(wc) {
  return run(wc, scraper.PAGE_INFO);
}

async function waitForLoad(wc, timeoutMs = 20000) {
  if (wc.isLoading()) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        wc.removeListener('did-stop-loading', done);
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', done);
        resolve();
      };
      wc.once('did-stop-loading', done);
    });
  }
  await sleep(800);
}

async function loadUrl(wc, url, logger) {
  logger?.info('browser', `打开 ${url}`);
  await Promise.race([wc.loadURL(url).catch(() => null), sleep(30000)]);
  await waitForLoad(wc);
  const info = await pageInfo(wc);
  const site = websiteNameSafe(wc);
  logger?.info('browser', `当前站点：${site}`, { url: info?.url });
  return info;
}

function websiteNameSafe(wc) {
  try {
    return siteOf(wc).name;
  } catch {
    return '未知站点';
  }
}

async function scrapeJobs(wc, logger) {
  const site = siteOf(wc);
  const script = useLegacy(wc) ? scraper.SCRAPE_JOBS : multi.JOBS(site);
  const result = await run(wc, script);
  logger?.info('scrape', `${site.name}：抓到 ${result.count ?? 0} 个岗位`, { url: result.url });
  return result;
}

async function scrapeDetail(wc, logger) {
  const site = siteOf(wc);
  const script = useLegacy(wc) ? scraper.SCRAPE_DETAIL : multi.DETAIL(site);
  const result = await run(wc, script);
  logger?.info('scrape', `${site.name}：读取职位详情`, { title: result.title, hasApply: Boolean(result.applyLabel), hasChat: Boolean(result.chatLabel) });
  return result;
}

async function openJobCard(wc, index, logger) {
  const site = siteOf(wc);
  const script = useLegacy(wc) ? scraper.CLICK_JOB_CARD(index) : multi.CLICK_CARD(site, index);
  const click = await run(wc, script);
  if (!click.ok) {
    logger?.warn('apply', '卡片不存在', { index, site: site.key });
    return { ok: false };
  }
  logger?.info('apply', `${site.name}：选中岗位卡片 #${index}`, { total: click.total });
  await sleep(3000);
  await waitForLoad(wc);
  return pageInfo(wc);
}

async function applyCurrentJob(wc, options, logger) {
  const site = siteOf(wc);
  const before = await pageInfo(wc);
  const script = useLegacy(wc) ? scraper.CLICK_APPLY : multi.APPLY(site);
  const click = await run(wc, script);
  if (!click.ok) {
    logger?.warn('apply', `${site.name}：没找到申请按钮`, { url: before?.url });
    return { ok: false, reason: click.reason, url: before?.url, site: site.key };
  }
  logger?.info('apply', `${site.name}：点了「${click.label}」`, { url: before?.url });
  await sleep(1500);

  const confirmScript = useLegacy(wc) ? scraper.CONFIRM_DIALOG : multi.CONFIRM(site);
  const confirm = await run(wc, confirmScript);
  if (confirm.ok) {
    logger?.info('apply', `弹窗确认「${confirm.label}」`, { dialog: confirm.scope });
    await sleep(1500);
  } else {
    logger?.info('apply', '没有弹确认框，按已提交处理');
  }
  return { ok: true, label: click.label, confirmed: confirm.ok, url: before?.url, title: before?.title, site: site.key };
}

async function scrapeMessages(wc, logger) {
  const site = siteOf(wc);
  const script = useLegacy(wc) ? scraper.SCRAPE_MESSAGES : multi.MESSAGES(site);
  const result = await run(wc, script);
  logger?.info('message', `${site.name}：会话 ${result.count ?? 0} 个，未读标记 ${result.unreadCount ?? 0}`, { url: result.url });
  return result;
}

async function openConversation(wc, index, logger) {
  const site = siteOf(wc);
  // 接管 Chrome 时优先用真实鼠标点击：BOSS 聊天列表对 JS click 不响应
  if (!useLegacy(wc) && typeof wc.clickPoint === 'function') {
    const pt = await run(wc, multi.ITEM_POINT(site, index)).catch(() => null);
    if (pt && pt.ok) {
      await wc.clickPoint(pt.x, pt.y);
      logger?.info('message', `${site.name}：真实鼠标打开会话 #${index}`, { preview: pt.preview });
      await sleep(1600);
      return { ok: true, preview: pt.preview, realClick: true };
    }
  }
  const script = useLegacy(wc) ? scraper.OPEN_CONVERSATION(index) : multi.OPEN_CONV(site, index);
  const result = await run(wc, script);
  logger?.info('message', `${site.name}：打开会话 #${index}`, result);
  await sleep(1200);
  return result;
}

async function readThread(wc) {
  const site = siteOf(wc);
  return run(wc, useLegacy(wc) ? scraper.READ_THREAD : multi.READ_THREAD(site));
}

async function sendMessage(wc, text, logger) {
  const site = siteOf(wc);
  const script = useLegacy(wc) ? scraper.SEND_MESSAGE(text) : multi.SEND(site, text);
  const result = await run(wc, script);
  logger?.info('message', result.ok ? `${site.name}：已发送回复` : `${site.name}：发送失败`, { result, text });
  return result;
}

// 点「同意」发送在线简历；平台会自动挑简历发过去，不需要再发文字
async function agreeResume(wc, logger) {
  const site = siteOf(wc);
  const result = await run(wc, useLegacy(wc) ? scraper.RESUME_AGREE : multi.AGREE_RESUME);
  logger?.info('message', result.ok ? `${site.name}：已点同意发送在线简历` : `${site.name}：没找到同意按钮`, result);
  await sleep(900);
  return result;
}

// 页面上有没有「同意」按钮：有就说明对方在要简历，直接点同意，不用打字
async function hasAgree(wc) {
  const site = siteOf(wc);
  const result = await run(wc, useLegacy(wc) ? scraper.HAS_AGREE : multi.HAS_AGREE).catch(() => ({ count: 0 }));
  return Number(result.count) > 0;
}

function currentSite(wc) {
  const site = siteOf(wc);
  return { key: site.key, name: site.name, apply: Boolean(site.apply), chat: Boolean(site.chat), risk: site.risk || '' };
}

module.exports = {
  sleep,
  run,
  pageInfo,
  waitForLoad,
  loadUrl,
  scrapeJobs,
  scrapeDetail,
  openJobCard,
  applyCurrentJob,
  scrapeMessages,
  openConversation,
  readThread,
  sendMessage,
  agreeResume,
  hasAgree,
  currentSite,
};
