const scraper = require('./scraper');

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
  return pageInfo(wc);
}

async function scrapeJobs(wc, logger) {
  const result = await run(wc, scraper.SCRAPE_JOBS);
  logger?.info('scrape', `抓到 ${result.count ?? 0} 个岗位`, { url: result.url });
  return result;
}

async function scrapeDetail(wc, logger) {
  const result = await run(wc, scraper.SCRAPE_DETAIL);
  logger?.info('scrape', '读取职位详情', { title: result.title, hasApply: Boolean(result.applyLabel) });
  return result;
}

async function openJobCard(wc, index, logger) {
  const click = await run(wc, scraper.CLICK_JOB_CARD(index));
  if (!click.ok) {
    logger?.warn('apply', '卡片不存在', { index });
    return { ok: false };
  }
  logger?.info('apply', `选中岗位卡片 #${index}`, { total: click.total });
  // 智联是左右分栏：点卡片只在右侧面板加载详情，不跳页
  await sleep(3000);
  await waitForLoad(wc);
  return pageInfo(wc);
}

async function applyCurrentJob(wc, options, logger) {
  const before = await pageInfo(wc);
  const click = await run(wc, scraper.CLICK_APPLY);
  if (!click.ok) {
    logger?.warn('apply', '没找到申请按钮', { url: before?.url });
    return { ok: false, reason: click.reason, url: before?.url };
  }
  logger?.info('apply', `点了「${click.label}」`, { url: before?.url });
  await sleep(1500);

  // 可能弹确认框 / 选择简历框
  const confirm = await run(wc, scraper.CONFIRM_DIALOG);
  if (confirm.ok) {
    logger?.info('apply', `弹窗确认「${confirm.label}」`, { dialog: confirm.scope });
    await sleep(1500);
  } else {
    logger?.info('apply', '没有弹确认框，按已提交处理');
  }
  return { ok: true, label: click.label, confirmed: confirm.ok, url: before?.url, title: before?.title };
}

async function scrapeMessages(wc, logger) {
  const result = await run(wc, scraper.SCRAPE_MESSAGES);
  logger?.info('message', `会话 ${result.count ?? 0} 个，未读标记 ${result.unreadCount ?? 0}`, { url: result.url });
  return result;
}

async function openConversation(wc, index, logger) {
  const result = await run(wc, scraper.OPEN_CONVERSATION(index));
  logger?.info('message', `打开会话 #${index}`, result);
  await sleep(1200);
  return result;
}

async function readThread(wc) {
  return run(wc, scraper.READ_THREAD);
}

async function sendMessage(wc, text, logger) {
  const result = await run(wc, scraper.SEND_MESSAGE(text));
  logger?.info('message', result.ok ? '已发送回复' : '发送失败', { result, text });
  return result;
}

// 点「同意」发送在线简历；平台会自动挑简历发过去，不需要再发文字
async function agreeResume(wc, logger) {
  const result = await run(wc, scraper.RESUME_AGREE);
  logger?.info('message', result.ok ? '已点同意发送在线简历' : '没找到同意按钮', result);
  await sleep(900);
  return result;
}

// 页面上有没有「同意」按钮：有就说明对方在要简历，直接点同意，不用打字
async function hasAgree(wc) {
  const result = await run(wc, scraper.HAS_AGREE).catch(() => ({ count: 0 }));
  return Number(result.count) > 0;
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
};
