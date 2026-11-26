const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog } = require('electron');

const { Store } = require('./src/engine/store');
const { Logger } = require('./src/engine/logger');
const auto = require('./src/engine/automation');
const scraperLib = require('./src/engine/scraper');
const { optimizeResume, optimizeWithLlm, cleanResumeText, toneDownClaims } = require('./src/engine/resume');
const scoreLib = require('./src/engine/score');
const { parseResume } = require('./src/engine/parse');
const versionsLib = require('./src/engine/versions');
const atsLib = require('./src/engine/ats');
const feedbackLib = require('./src/engine/feedback');
const autoflow = require('./src/engine/autoflow');
const { enrichResume } = require('./src/engine/persona');
const { generateReplies } = require('./src/engine/replier');
const policy = require('./src/engine/policy');
const tracker = require('./src/engine/tracker');
const scenarios = require('./src/engine/scenarios');
const simulate = require('./src/engine/simulate');
const memoryLib = require('./src/engine/memory');
const llmLib = require('./src/engine/llm');
const guardLib = require('./src/engine/guard');
const knowledgeLib = require('./src/engine/knowledge');
const idleLearn = require('./src/engine/idleLearn');

const PANEL_WIDTH = 476;

let win = null;
let view = null;
let store = null;
let logger = null;

function dataDir() {
  return path.join(__dirname, 'data');
}

function layout() {
  if (!win || !view) return;
  const bounds = win.getContentBounds();
  view.setBounds({
    x: PANEL_WIDTH,
    y: 0,
    width: Math.max(320, bounds.width - PANEL_WIDTH),
    height: Math.max(200, bounds.height),
  });
}

function createBrowserView() {
  view = new WebContentsView({
    webPreferences: {
      partition: 'persist:zhaopin',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  layout();
  // 别让 UA 暴露 Electron，用普通 Chrome 的 UA，减少被当脚本的特征
  view.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      view.webContents.loadURL(url);
      logger.info('browser', '拦截新窗口，改为内嵌打开', { url });
    }
    return { action: 'deny' };
  });
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.warn('browser', `加载失败 ${code} ${desc}`, { url });
  });
  // 单个 did-finish-load 监听器：风控页优先短路，避免风控命中时仍触发自动抓取
  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();
    if (/captcha|verify|security|punish|slide/i.test(url)) {
      const t = guardLib.trip(store, { reason: `跳转到风控页：${url.replace(/^https?:\/\/[^/]+/, '').slice(0, 60)}` });
      logger.error('guard', '检测到风控页，已暂停自动动作', { url: url.slice(0, 120), coolMin: t.waitMin });
      return;
    }
    if (/zhaopin\.com\/jobs/i.test(url)) {
      onJobsPageLoaded(url).catch((err) => logger.warn('jobs', '岗位页自动抓取失败', { msg: err.message }));
      return;
    }
    if (!/zhaopin\.com\/(message|im)/i.test(url)) return;
    onMessagePageLoaded(url).catch((err) => logger.warn('msg', '打开即抓取失败', { msg: err.message }));
  });
  const home = store.get('settings').homeUrl;
  view.webContents.loadURL(home);
  logger.info('browser', '内嵌浏览器启动', { home });
}

let msgAutoBusy = false;
let lastMsgAutoAt = 0;
let lastWorkAt = 0;
let jobsAutoBusy = false;
let lastJobsAutoAt = 0;

// 岗位页一打开就自动抓取并打分，省掉手点「抓取当前页岗位并打分」
async function onJobsPageLoaded(url) {
  const settings = store.get('settings');
  if (settings.autoScrapeOnOpen === false) return;
  if (jobsAutoBusy) return;
  if (Date.now() - lastJobsAutoAt < 5 * 60 * 1000) return;
  jobsAutoBusy = true;
  lastJobsAutoAt = Date.now();
  try {
    for (let i = 0; i < 15; i += 1) {
      const n = await view.webContents.executeJavaScript('document.querySelectorAll(".job-card").length', true).catch(() => 0);
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const jobs = await auto.scrapeJobs(view.webContents, logger);
    lastJobs = jobs.jobs || [];
    const ranked = scoreLib.rankJobs(lastJobs, scoreCtx());
    const matches = topMatches(ranked);
    if (matches.length) store.patch('resume', { matches, title: matches[0].title });
    logger.info('match', '岗位页自动打分', { count: ranked.length, matches: matches.length, url });
    win.webContents.send('jobs:auto', { page: jobs, ranked, matches });
  } finally {
    jobsAutoBusy = false;
  }
}

// 消息页一打开就自动抓会话 + 按人设生成/发送回复，不用再手点「抓取会话」
async function onMessagePageLoaded(url) {
  const settings = store.get('settings');
  if (settings.autoReplyOnOpen === false) return;
  if (msgAutoBusy) return;
  if (Date.now() - lastMsgAutoAt < 8 * 60 * 1000) return;
  msgAutoBusy = true;
  lastMsgAutoAt = Date.now();
  lastWorkAt = Date.now();
  const wc = view.webContents;
  const run = logger.startRun('msg-auto-onopen', { url });
  try {
    // 页面刚加载时列表还没渲染出来，先等会话项出现（最多 20 秒）
    for (let i = 0; i < 20; i += 1) {
      const n = await wc.executeJavaScript("document.querySelectorAll('.im-session-item').length", true).catch(() => 0);
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const list = await auto.scrapeMessages(wc, logger);
    run.add('list', { count: list.count || 0 });
    win.webContents.send('msg:auto', { stage: 'list', list, runId: run.runId });
    const res = await autoflow.autoReply({
      wc,
      auto,
      logger,
      store,
      options: { send: settings.autoReplySend === true, max: settings.autoReplyMax || 5 },
    });
    run.add('reply', { count: res.results.length });
    run.finish({ count: res.results.length, memory: res.memory });
    win.webContents.send('msg:auto', { stage: 'reply', res, runId: run.runId });
  } catch (err) {
    run.finish({ error: err.message });
    win.webContents.send('msg:auto', { stage: 'error', error: err.message });
    throw err;
  } finally {
    msgAutoBusy = false;
  }
}

function createWindow() {
  store = new Store(dataDir());
  logger = new Logger(store.get('settings').logDir);
  // 空闲时自己学点东西：不占用内嵌浏览器、不影响投递和回复
  // 参数可在 settings.learn 里改：{ enabled, checkMin, idleMin, gapMin }
  let lastLearnCheck = 0;
  setInterval(() => {
    const learn = store.get('settings').learn || {};
    if (learn.enabled === false) return;
    if (Date.now() - lastLearnCheck < (learn.checkMin || 10) * 60 * 1000) return;
    lastLearnCheck = Date.now();
    if (msgAutoBusy || jobsAutoBusy) return;
    if (!idleLearn.isIdle(lastWorkAt, (learn.idleMin || 15) * 60 * 1000)) return;
    logger.info('learn', '空闲检查通过，开始学一条', { checkMin: learn.checkMin, gapMin: learn.gapMin });
    idleLearn.tick({
      llmCfg: store.get('settings').llm,
      logger,
      minGapMs: (learn.gapMin || 30) * 60 * 1000,
    }).catch(() => {});
  }, 60 * 1000);
  logger.info('app', '启动', { logDir: store.get('settings').logDir });
  logger.cleanup(store.get('settings').logRetentionDays || 30);

  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    title: '智联求职助手',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));
  win.on('resize', layout);
  win.on('closed', () => {
    win = null;
    view = null;
  });

  createBrowserView();
}

function wrap(fn) {
  return async (event, payload) => {
    try {
      const data = await fn(payload, event);
      return { ok: true, data };
    } catch (err) {
      logger.error('ipc', err.message, { stack: err.stack });
      return { ok: false, error: err.message };
    }
  };
}

// settings 里带 llm.apiKey，日志只留脱敏副本，禁止把密钥写进 app-*.log / events-*.jsonl
function redactSettings(settings) {
  const out = { ...(settings || {}), llm: { ...((settings || {}).llm || {}) } };
  if (out.llm.apiKey) out.llm.apiKey = '***';
  return out;
}

function ctx() {
  return { resume: store.get('resume'), requirement: store.get('requirement') };
}

// 简历解析结果按 raw 文本缓存，避免每抓一次岗位就重解析一遍
let parseCache = { key: '', parsed: null };
function parsedResume() {
  const raw = store.get('resume').raw || '';
  if (parseCache.key !== raw) parseCache = { key: raw, parsed: parseResume(raw) };
  return parseCache.parsed;
}

function scoreCtx() {
  const resume = store.get('resume');
  const requirement = store.get('requirement');
  const settings = store.get('settings');
  const cached = parsedResume();
  const ctxValue = scoreLib.buildCtx({ ...resume, parsed: cached }, requirement, { weights: settings.weights, hardGate: settings.hardGate });
  return ctxValue;
}

let lastJobs = [];

// 从打分结果里取匹配度最高的前 N 个岗位（按标题去重，保留分最高的那个）
function topMatches(ranked, n = 6) {
  const seen = new Set();
  const out = [];
  for (const job of ranked || []) {
    const title = String(job.title || '').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push({
      title,
      company: job.company || '',
      salary: job.salary || '',
      score: job.score,
      reasons: (job.reasons || []).slice(0, 3),
    });
    if (out.length >= n) break;
  }
  return out;
}

ipcMain.handle('app:state', wrap(async () => ({
  settings: store.get('settings'),
  resume: store.get('resume'),
  requirement: store.get('requirement'),
  history: store.get('history'),
  logDir: store.get('settings').logDir,
  page: await auto.pageInfo(view.webContents).catch(() => null),
})));

ipcMain.handle('settings:save', wrap(async (patch) => {
  const next = store.patch('settings', patch || {});
  logger.info('settings', '保存设置', redactSettings(next));
  if (patch?.logRetentionDays) logger.cleanup(next.logRetentionDays);
  return next;
}));

ipcMain.handle('resume:save', wrap(async (patch) => store.patch('resume', patch || {})));

ipcMain.handle('resume:fetch-site', wrap(async () => {
  const settings = store.get('settings');
  const url = settings.resumeUrl || 'https://i.zhaopin.com/resume';
  const run = logger.startRun('resume-fetch', { url });
  await auto.loadUrl(view.webContents, url, logger).catch((err) => logger.warn('resume', '简历页加载异常', { msg: err.message }));
  // 先把所有"查看全部"展开、把页面滚到底，保证抓到的是整份简历而不是折叠后的摘要
  for (let i = 0; i < 3; i += 1) {
    const expanded = await auto.run(view.webContents, scraperLib.EXPAND_RESUME).catch(() => null);
    logger.info('resume', '展开简历折叠块', expanded || {});
    await auto.sleep(1200);
  }
  let res = null;
  for (let i = 0; i < 3; i += 1) {
    await auto.sleep(1500);
    res = await auto.run(view.webContents, scraperLib.SCRAPE_RESUME).catch(() => null);
    if (res && !res.lost && !res.loggedOut && (res.chars || 0) >= 300) break;
  }
  if (!res || res.lost || res.loggedOut || (res.chars || 0) < 300) {
    run.add('fail', res);
    const why = res?.lost
      ? '简历页没打开（跳到了"页面走丢了"），检查设置里的简历地址'
      : res?.loggedOut
        ? '右边浏览器没有登录智联'
        : `只读到 ${res?.chars || 0} 字`;
    throw new Error(`没读到简历：${why}。当前停在 ${res?.url || url}，处理后点一次即可`);
  }
  const cleaned = toneDownClaims(cleanResumeText(res.text));
  store.patch('resume', { raw: cleaned });
  const parsed = {};
  const years = /工作\s*(\d+)\s*年/.exec(cleaned);
  if (years) parsed.years = Number(years[1]);
  const city = /(广州|深圳|上海|北京|杭州|成都|武汉|南京|苏州|东莞|佛山)/.exec(cleaned);
  if (city) parsed.city = city[1];
  const name = /^\s*([\u4e00-\u9fa5·]{2,4})\s*$/m.exec(cleaned);
  if (name) parsed.name = name[1];
  const profile = parseResume(cleaned);
  if (profile.intent?.title) parsed.title = profile.intent.title;
  if (profile.skills?.length) parsed.skills = profile.skills;
  if (profile.intent?.salary) parsed.salary = profile.intent.salary;
  store.patch('resume', { title: parsed.title || store.get('resume').title, skills: parsed.skills || [], salary: parsed.salary || store.get('resume').salary || '' });
  run.finish({ chars: res.chars, url: res.url, parsed });
  logger.info('resume', '读取在线简历', { chars: res.chars, url: res.url });
  return { text: cleaned, url: res.url, chars: cleaned.length, parsed };
}));

ipcMain.handle('resume:import-file', wrap(async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择简历文件',
    properties: ['openFile'],
    filters: [{ name: '简历', extensions: ['docx', 'pdf', 'txt', 'md', 'doc'] }],
  });
  if (picked.canceled || !picked.filePaths?.length) return { canceled: true };
  const file = picked.filePaths[0];
  const ext = path.extname(file).toLowerCase();
  let text = '';

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: file });
    text = result.value;
  } else if (ext === '.pdf') {
    const pdfModule = require('pdf-parse');
    const buffer = fs.readFileSync(file);
    if (typeof pdfModule === 'function') {
      const result = await pdfModule(buffer);
      text = result.text;
    } else if (pdfModule.PDFParse) {
      const parser = new pdfModule.PDFParse({ data: buffer });
      const result = await parser.getText();
      text = result.text;
      if (typeof parser.destroy === 'function') await parser.destroy();
    } else {
      throw new Error('pdf 解析库版本不识别，换 docx 或 txt');
    }
  } else if (ext === '.doc') {
    throw new Error('.doc 老格式读不了，另存为 .docx 再导入');
  } else {
    text = fs.readFileSync(file, 'utf8');
  }

  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 50) throw new Error('文件里没读到足够文字，可能是扫描件或图片型 PDF');
  store.patch('resume', { raw: text });
  logger.info('resume', '导入本地简历文件', { file, chars: text.length });
  return { text, file, chars: text.length };
}));
ipcMain.handle('requirement:save', wrap(async (patch) => {
  const next = { ...store.get('requirement'), ...(patch || {}) };
  // 把用户写的话解析成偏好（出差天数、自驾、管理岗、排除类型），打分和模型判断都用它
  next.prefs = require('./src/engine/intent').parse(next.text || '', next);
  return store.patch('requirement', next);
}));

ipcMain.handle('resume:apply-optimized', wrap(async () => {
  const resume = store.get('resume');
  const text = String(resume.optimized || '').trim();
  if (text.length < 100) throw new Error('还没有优化结果，先点「优化简历（去 AI 腔）」');
  // 防截断护栏：优化稿明显比原文短，拒绝写回，避免把在线简历写成半截
  const rawLen = String(resume.raw || '').trim().length;
  if (text.length < 300 || (rawLen > 400 && text.length < rawLen * 0.6)) {
    throw new Error(`优化稿只有 ${text.length} 字，原文 ${rawLen} 字，疑似被截断，已拒绝写回。请先「从智联读在线简历」再优化。`);
  }
  // 写回前留一份快照，出问题能回滚
  try {
    const dir = path.join(dataDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `resume-${Date.now()}.json`), JSON.stringify(resume));
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith('resume-')).sort();
    while (olds.length > 10) fs.unlinkSync(path.join(dir, olds.shift()));
  } catch (e) {
    logger.warn('resume', '简历快照失败', { msg: e.message });
  }
  const run = logger.startRun('resume-apply', { chars: text.length });
  store.patch('resume', { raw: text, optimized: text });
  parseCache = { key: '', parsed: null };

  const parsed = parsedResume();
  store.patch('resume', {
    title: parsed.intent?.title || store.get('resume').title,
    years: parsed.totalYears || store.get('resume').years,
    education: parsed.educationLevel || store.get('resume').education,
    city: parsed.city || store.get('resume').city,
    skills: parsed.skills || store.get('resume').skills,
    salary: parsed.intent?.salary || store.get('resume').salary || '',
  });
  const lib = store.get('versionLib');
  const active = (lib.versions || []).find((v) => v.id === lib.activeId);
  const keywords = [...new Set([...(active?.targetTags || []), ...(lastJobs.length ? versionsLib.clusterTags(lastJobs, 8) : [])])].slice(0, 10);
  const ats = atsLib.checkAts(text, parsed, keywords, store.get('settings').atsThreshold || 0.85);

  let rebuilt = null;
  if (lastJobs.length) {
    const built = versionsLib
      .buildVersions({ parsed, raw: text, requirement: store.get('requirement'), jobs: lastJobs })
      .slice(0, store.get('settings').maxVersions || 10);
    rebuilt = { versions: built, activeId: built[0]?.id || '', updatedAt: Date.now() };
    store.set('versionLib', rebuilt);
  }

  run.finish({ chars: text.length, ats: ats.score, coverage: ats.keywords.coverage, versions: rebuilt?.versions.length ?? 0 });
  logger.info('resume', '一键更新（优化稿写回原文）', {
    chars: text.length, ats: ats.score, coverage: ats.keywords.coverage, versions: rebuilt?.versions.length ?? 0,
  });
  return {
    chars: text.length,
    experiences: parsed.experiences?.length || 0,
    ats: { score: ats.score, coverage: ats.keywords.coverage, missing: ats.keywords.missing.slice(0, 8) },
    rebuilt: rebuilt ? { count: rebuilt.versions.length, activeId: rebuilt.activeId, versions: rebuilt.versions } : null,
  };
}));

ipcMain.handle('resume:optimize', wrap(async () => {
  const { resume, requirement } = ctx();
  const settings = store.get('settings');
  const run = logger.startRun('resume-optimize', { name: resume.name, title: resume.title });
  let base = optimizeResume(resume, requirement);
  let final = base;
  if (llmLib.ready(settings.llm)) {
    try {
      final = await optimizeWithLlm(base, resume, requirement, settings.llm);
      run.add('llm', { ok: true });
    } catch (err) {
      run.add('llm', { ok: false, error: err.message });
      final = { ...base, suggestions: [...base.suggestions, `LLM 调用失败：${err.message}`] };
    }
  }
  store.patch('resume', { optimized: final.optimizedText });
  run.finish({ chars: final.optimizedText.length, gaps: final.keywords.missing.length });
  return final;
}));

ipcMain.handle('browser:goto', wrap(async ({ url }) => auto.loadUrl(view.webContents, url, logger)));
ipcMain.handle('browser:home', wrap(async () => auto.loadUrl(view.webContents, store.get('settings').homeUrl, logger)));
ipcMain.handle('browser:search', wrap(async ({ kw, city }) => {
  const tpl = store.get('settings').searchUrlTemplate;
  const url = tpl.replace('{kw}', encodeURIComponent(kw || '嵌入式开发')).replace('{jl}', city || '763');
  return auto.loadUrl(view.webContents, url, logger);
}));
ipcMain.handle('browser:info', wrap(async () => auto.pageInfo(view.webContents)));

ipcMain.handle('jobs:scrape', wrap(async () => {
  const jobs = await auto.scrapeJobs(view.webContents, logger);
  lastJobs = jobs.jobs || [];
  const ranked = scoreLib.rankJobs(lastJobs, scoreCtx());
  const matches = topMatches(ranked);
  if (matches.length) store.patch('resume', { matches, title: matches[0].title });
  logger.info('match', '岗位打分完成', { count: ranked.length, top: ranked[0]?.score ?? null, matches: matches.length });
  return { page: jobs, ranked, matches };
}));

ipcMain.handle('jobs:open', wrap(async ({ index }) => auto.openJobCard(view.webContents, index, logger)));
ipcMain.handle('jobs:detail', wrap(async () => auto.scrapeDetail(view.webContents, logger)));

ipcMain.handle('apply:run', wrap(async ({ indexes = [], jobs = [], dryRun = true }) => {
  const settings = store.get('settings');
  const { resume, requirement } = ctx();
  let history = tracker.ensure(store.get('history'));
  const selected = (jobs || []).filter((j) => indexes.includes(j.index));
  const plan = policy.planRun(selected, { settings, requirement, resume, history });
  const run = logger.startRun('apply', { dryRun, requested: indexes.length, blocked: plan.blocked.length, quota: plan.quota });
  lastWorkAt = Date.now();
  run.add('policy', { allowed: plan.allowed.length, blocked: plan.blocked.length, quota: plan.quota });
  const results = [];

  if (!plan.plan.length) {
    run.finish({ reason: plan.quota.overQuota ? '今日投递配额已用完' : '没有通过筛选的岗位' });
    return {
      runId: run.runId,
      file: run.file,
      quota: plan.quota,
      blocked: plan.blocked,
      results: plan.blocked.map((b) => ({ index: b.index, ok: false, blocked: true, reasons: b.blockReasons })),
    };
  }

  for (const job of plan.plan) {
    try {
      await auto.openJobCard(view.webContents, job.index, logger);
      const detail = await auto.scrapeDetail(view.webContents, logger);
      const risk = policy.detectRisk(detail.body);
      if (risk.risk && !dryRun) {
        logger.warn('risk', `页面出现「${risk.signal}」，本轮暂停`, { job: job.title });
        results.push({ index: job.index, ok: false, risk: risk.signal, title: detail.title || job.title });
        run.add('risk-stop', { signal: risk.signal });
        break;
      }
      const liveScore = scoreLib.rankJobs([{
        title: detail.title || job.title,
        tags: job.tags || [],
        company: detail.company || job.company,
        salary: detail.salary || job.salary,
        location: job.location || '',
      }], scoreCtx())[0];

      if (dryRun) {
        results.push({
          index: job.index, ok: true, dryRun: true,
          title: detail.title || job.title, company: detail.company || job.company,
          score: liveScore?.score ?? job.score,
        });
        run.add('dry-run', { index: job.index, title: detail.title || job.title });
      } else {
        const applied = await auto.applyCurrentJob(view.webContents, {}, logger);
        const rec = tracker.addApplied(history, {
          title: detail.title || job.title,
          company: job.company,
          salary: job.salary,
          score: liveScore?.score ?? job.score,
        }, { url: applied.url, versionId: store.get('versionLib').activeId || '' });
        history = rec.history;
        store.set('history', history);
        results.push({ index: job.index, ok: applied.ok, title: detail.title || job.title, company: job.company, applied });
        run.add('apply', results[results.length - 1]);
      }

      const wait = policy.jitterInterval(settings.applyIntervalMs);
      run.add('wait', { ms: wait });
      await auto.sleep(wait);
    } catch (err) {
      logger.error('apply', err.message, { index: job.index });
      results.push({ index: job.index, ok: false, error: err.message });
    }
  }

  run.finish({ results });
  return { runId: run.runId, file: run.file, results, quota: plan.quota, blocked: plan.blocked };
}));

ipcMain.handle('policy:plan', wrap(async ({ jobs = [] }) => {
  const settings = store.get('settings');
  const { resume, requirement } = ctx();
  const history = tracker.ensure(store.get('history'));
  return policy.planRun(jobs, { settings, requirement, resume, history });
}));

ipcMain.handle('versions:generate', wrap(async () => {
  const settings = store.get('settings');
  const resume = store.get('resume');
  const requirement = store.get('requirement');
  const parsed = parsedResume();
  const jobs = lastJobs.length ? lastJobs : simulate.MOCK_JOBS;
  const run = logger.startRun('versions', { jobs: jobs.length, source: lastJobs.length ? 'real' : 'mock' });
  const built = versionsLib.buildVersions({ parsed, raw: resume.raw, requirement, jobs });
  const capped = built.slice(0, settings.maxVersions || 10);
  const lib = { versions: capped, activeId: capped[0]?.id || '', updatedAt: Date.now() };
  store.set('versionLib', lib);
  run.finish({ count: capped.length, active: lib.activeId });
  logger.info('versions', '生成版本库', { count: capped.length, tags: capped[0]?.targetTags });
  return {
    ...lib,
    funnel: feedbackLib.versionFunnel(store.get('history'), capped),
    alerts: feedbackLib.alerts(store.get('history'), capped),
  };
}));

ipcMain.handle('versions:list', wrap(async () => {
  const lib = store.get('versionLib');
  const versions = lib.versions || [];
  return {
    ...lib,
    versions,
    funnel: feedbackLib.versionFunnel(store.get('history'), versions),
    alerts: feedbackLib.alerts(store.get('history'), versions),
  };
}));

ipcMain.handle('versions:activate', wrap(async ({ id }) => {
  const lib = store.get('versionLib');
  const target = (lib.versions || []).find((v) => v.id === id);
  if (!target) throw new Error('版本不存在，先刷新版本库');
  store.set('versionLib', { ...lib, activeId: id, updatedAt: Date.now() });
  logger.info('versions', '切换投递版本', { id, label: target.label });
  return store.get('versionLib');
}));

ipcMain.handle('ats:check', wrap(async ({ versionId } = {}) => {
  const lib = store.get('versionLib');
  const active = (lib.versions || []).find((v) => v.id === (versionId || lib.activeId));
  const raw = store.get('resume').raw || '';
  const parsed = parsedResume();
  const keywords = [...new Set([...(active?.targetTags || []), ...versionsLib.clusterTags(lastJobs.length ? lastJobs : simulate.MOCK_JOBS, 8)])].slice(0, 10);
  const res = atsLib.checkAts(raw, parsed, keywords, store.get('settings').atsThreshold || 0.85);
  logger.info('ats', 'ATS 自测', { versionId: active?.id || '', score: res.score, coverage: res.keywords.coverage });
  return { versionId: active?.id || '', label: active?.label || '', targetKeywords: keywords, ...res };
}));

ipcMain.handle('auto:apply', wrap(async ({ dryRun = false, max, threshold, keyword } = {}) => {
  const settings = store.get('settings');
  const run = logger.startRun('auto-apply', { dryRun, max, threshold, keyword });
  const res = await autoflow.autoApply({
    wc: view.webContents, auto, logger, store,
    options: { dryRun, max, threshold, keyword },
  });
  for (const step of res.steps) run.add(step.step, step);
  const matches = topMatches(res.ranked, 6);
  if (matches.length) store.patch('resume', { matches, title: matches[0].title });
  run.finish({ applied: res.results.filter((r) => r.ok && !r.dryRun).length, passed: res.passed.length });
  logger.info('auto', '自动投递结束', { file: run.file, applied: res.results.length });
  return {
    runId: run.runId,
    file: run.file,
    keyword: res.keyword,
    steps: res.steps,
    results: res.results,
    matches,
    quota: res.plan.quota,
    blocked: res.plan.blocked,
  };
}));

ipcMain.handle('auto:reply', wrap(async ({ send = false, max } = {}) => {
  const run = logger.startRun('auto-reply', { send, max });
  const res = await autoflow.autoReply({
    wc: view.webContents, auto, logger, store, options: { send, max },
  });
  for (const step of res.steps) run.add(step.step, step);
  run.finish({ drafted: res.results.filter((r) => r.draft).length, sent: res.results.filter((r) => r.sent).length });
  return { runId: run.runId, file: run.file, ...res };
}));

ipcMain.handle('funnel:get', wrap(async () => {
  const lib = store.get('versionLib');
  const history = tracker.ensure(store.get('history'));
  return {
    funnel: feedbackLib.versionFunnel(history, lib.versions || []),
    alerts: feedbackLib.alerts(history, lib.versions || []),
    stats: tracker.stats(history),
    activeId: lib.activeId || '',
  };
}));

ipcMain.handle('stats:get', wrap(async () => tracker.stats(tracker.ensure(store.get('history')))));

ipcMain.handle('msg:classify', wrap(async ({ text = '', job = {} }) => {
  const { resume, requirement } = ctx();
  return scenarios.draftsFor({ text, resume, requirement, job });
}));

ipcMain.handle('sim:run', wrap(async () => {
  const settings = store.get('settings');
  const { resume, requirement } = ctx();
  const history = tracker.ensure(store.get('history'));
  const run = logger.startRun('simulate', { jobs: simulate.MOCK_JOBS.length });
  const result = simulate.demo({ resume, requirement, settings, history });
  for (const step of result.steps) run.add(step.step, step);
  run.finish({ applied: result.appliedResults.length, messages: result.messages.length, stats: result.stats });
  logger.info('simulate', '演练完成', { file: run.file });
  return { runId: run.runId, file: run.file, steps: result.steps, stats: result.stats, messages: result.messages, blocked: result.plan.blocked, applied: result.appliedResults, quota: result.plan.quota };
}));

ipcMain.handle('message:scrape', wrap(async () => auto.scrapeMessages(view.webContents, logger)));
ipcMain.handle('message:open', wrap(async ({ index }) => auto.openConversation(view.webContents, index, logger)));
ipcMain.handle('message:thread', wrap(async () => auto.readThread(view.webContents)));
ipcMain.handle('message:drafts', wrap(async ({ job, hrMessage }) => {
  const { resume, requirement } = ctx();
  return generateReplies({ job: job || {}, resume, requirement, hrMessage });
}));
ipcMain.handle('message:send', wrap(async ({ text }) => {
  const settings = store.get('settings');
  const res = await auto.sendMessage(view.webContents, text, logger);
  if (res.ok) {
    const history = store.get('history');
    history.replied.push({ ts: new Date().toISOString(), text });
    store.set('history', history);
  }
  return res;
}));

ipcMain.handle('log:tail', wrap(async ({ lines = 200 } = {}) => logger.tail(lines)));
ipcMain.handle('log:open', wrap(async () => {
  await shell.openPath(store.get('settings').logDir);
  return store.get('settings').logDir;
}));

ipcMain.handle('llm:test', wrap(async (patch) => {
  const cfg = { ...store.get('settings').llm, ...(patch || {}) };
  const result = await llmLib.test(cfg);
  logger.info('llm', '模型连通性测试', result);
  return result;
}));
ipcMain.handle('llm:info', wrap(async () => ({ presets: llmLib.PRESETS, current: llmLib.pick(store.get('settings').llm), ready: llmLib.ready(store.get('settings').llm) })));
ipcMain.handle('memory:summary', wrap(async () => memoryLib.summary(store)));
ipcMain.handle('memory:evolve', wrap(async () => { const m = memoryLib.evolve(store); logger.info('memory', '手动触发进化', { v: m.strategyVersion }); return memoryLib.summary(store); }));

ipcMain.handle('knowledge:summary', wrap(async () => knowledgeLib.summary()));
ipcMain.handle('knowledge:config', wrap(async (patch) => {
  if (patch && typeof patch === 'object') {
    const learn = { ...(store.get('settings').learn || {}), ...patch };
    store.patch('settings', { learn });
    return learn;
  }
  return store.get('settings').learn || {};
}));
ipcMain.handle('knowledge:open', wrap(async () => {
  await shell.openPath(path.join(dataDir(), 'knowledge.json'));
  return knowledgeLib.FILE;
}));
ipcMain.handle('knowledge:learn', wrap(async () => {
  const res = await idleLearn.tick({ llmCfg: store.get('settings').llm, logger, minGapMs: 0 });
  lastWorkAt = Date.now();
  return { res, summary: knowledgeLib.summary() };
}));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

