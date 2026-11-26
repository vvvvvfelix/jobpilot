const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null;
let lastJobs = [];
let lastRanked = [];
let applyQueue = [];

function toast(text, ms = 3200) {
  const node = $('#toast');
  node.textContent = text;
  if (ms) setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, ms);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function busy(ids, on) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = on;
  }
}

async function call(channel, payload, tag) {
  const res = await window.api.invoke(channel, payload);
  if (!res || !res.ok) {
    toast(`${tag || channel} 失败：${res?.error || '未知错误'}`);
    return null;
  }
  return res.data;
}

function debounce(fn, ms = 600) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function persistResume() {
  return call('resume:save', {
    name: $('#rName').value.trim(),
    title: $('#rTitle').value.trim(),
    years: Number($('#rYears').value || 0),
    education: $('#rEdu').value,
    city: $('#rCity').value.trim(),
    raw: $('#rRaw').value,
  }, '保存简历');
}

async function persistNeed() {
  return call('requirement:save', {
    text: $('#nText').value,
    city: $('#nCity').value.trim(),
    salaryMin: Number($('#nSalary').value || 0),
  }, '保存需求');
}

const saveResume = debounce(() => persistResume());
const saveNeed = debounce(() => persistNeed());

function fillForms(data) {
  const { resume, requirement, settings } = data;
  $('#rName').value = resume.name || '';
  $('#rTitle').value = resume.title || '';
  $('#rYears').value = resume.years || 0;
  $('#rEdu').value = resume.education || '本科';
  $('#rCity').value = resume.city || '';
  $('#rRaw').value = resume.raw || '';
  $('#rOpt').value = resume.optimized || '';

  $('#nText').value = requirement.text || '';
  $('#nCity').value = requirement.city || '';
  $('#nSalary').value = requirement.salaryMin || 0;

  $('#sLogDir').value = settings.logDir || '';
  $('#sMaxApply').value = settings.maxApplyPerRun || 10;
  $('#sInterval').value = settings.applyIntervalMs || 12000;
  $('#sDailyCap').value = settings.dailyCap || 40;
  $('#sExcludeHead').checked = settings.excludeHeadhunter !== false;
  $('#sBlacklist').value = settings.blacklist || '';
  $('#sConfirmApply').checked = Boolean(settings.confirmBeforeApply);
  $('#sConfirmSend').checked = Boolean(settings.confirmBeforeSend);
  $('#sMsgUrl').value = settings.messageUrl || '';
  $('#sResumeUrl').value = settings.resumeUrl || '';
  $('#sSearchTpl').value = settings.searchUrlTemplate || '';
  $('#sLlmOn').checked = Boolean(settings.llm?.enabled);
  $('#sLlmProvider').value = settings.llm?.provider || 'pollinations';
  $('#sLlmBase').value = settings.llm?.baseUrl || '';
  $('#sLlmModel').value = settings.llm?.model || '';
  $('#sLlmKey').value = settings.llm?.apiKey || '';
  const w = settings.weights || {};
  $('#wSkill').value = w.skill ?? 0.3;
  $('#wExp').value = w.experience ?? 0.2;
  $('#wKw').value = w.keyword ?? 0.15;
  $('#wProj').value = w.project ?? 0.2;
  $('#wEdu').value = w.education ?? 0.1;
  $('#wSal').value = w.salary ?? 0.05;
  $('#sHardGate').checked = Boolean(settings.hardGate);
  $('#sAutoScore').value = settings.autoThreshold ?? 55;
  $('#sAutoMax').value = settings.autoApplyMax ?? 5;
  $('#sReplyMax').value = settings.autoReplyMax ?? 5;
  $('#sReplySend').checked = Boolean(settings.autoReplySend);
  $('#sAutoOpen').checked = settings.autoReplyOnOpen !== false;
  $('#sLogDays').value = settings.logRetentionDays || 30;

  const persona = [
    `姓名 ${resume.name || '—'}`,
    `年限 ${resume.years || '—'} 年`,
    `学历 ${resume.education || '—'}`,
    `城市 ${resume.city || '—'}`,
    `目标岗位 ${resume.title || '—'}`,
    `期望薪资 ${resume.salary || '—'}`,
  ];
  $('#needPersona').innerHTML = `<div class="job-meta">个人信息（来自简历，下面不用重复填）：${persona.map(escapeHtml).join(' · ')}</div>`;
  renderMatches(resume.matches || []);
}

function renderMatches(matches) {
  const box = $('#matchList');
  const list = (matches || []).filter((m) => m && m.title);
  if (!list.length) {
    box.innerHTML = '<p class="hint">抓取岗位后，这里会列出匹配度最高的 6 个岗位，点一下即可设为目标岗位。</p>';
    return;
  }
  box.innerHTML = '<div class="job-meta">匹配度最高的 6 个岗位（点一下设为「目标岗位」）：</div>';
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const m of list) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = `${m.title} ${m.score}分`;
    chip.title = `${m.company || ''} ${m.salary || ''}`;
    chip.addEventListener('click', async () => {
      $('#rTitle').value = m.title;
      await persistResume();
      toast(`目标岗位设为 ${m.title}`);
    });
    wrap.appendChild(chip);
  }
  box.appendChild(wrap);
}

async function refreshPage() {
  const info = await call('browser:info', null, '读取页面');
  if (info?.url) $('#pageUrl').textContent = `${info.title || ''} — ${info.url}`;
}

function renderJobs(ranked, plan) {
  const box = $('#jobList');
  box.innerHTML = '';
  applyQueue = [];
  if (!ranked.length) {
    box.innerHTML = '<p class="hint">没抓到岗位。确认右边是智联搜索结果页。</p>';
    return;
  }
  const blockedMap = new Map((plan?.blocked || []).map((b) => [b.index, b.blockReasons || []]));
  for (const job of ranked) {
    const blockReasons = blockedMap.get(job.index);
    const blocked = Array.isArray(blockReasons) && blockReasons.length > 0;
    const div = document.createElement('div');
    div.className = blocked ? 'job blocked' : 'job';
    const cls = job.score >= 70 ? 'score high' : 'score';
    const s = job.subscores || {};
    const num = (v) => escapeHtml(v ?? 0);
    div.innerHTML = `
      <div class="job-head">
        <input type="checkbox" data-index="${escapeHtml(job.index)}" ${blocked ? 'disabled' : ''} />
        <span class="job-name">${escapeHtml(job.title || '(无标题)')}</span>
        <span class="${cls}">${num(job.score)}分</span>
      </div>
      <div class="job-meta">${escapeHtml(job.company || '')} · ${escapeHtml(job.location || '')} · ${escapeHtml(job.salary || '')}</div>
      <div class="job-meta">${(job.tags || []).map(escapeHtml).join(' / ')}</div>
      ${job.subscores ? `<div class="job-meta">技能${num(s.skill)} 经验${num(s.experience)} 关键词${num(s.keyword)} 项目${num(s.project)} 学历${num(s.education)} 薪资${num(s.salary)}${job.penalty ? `｜扣分${num(job.penalty)}` : ''}</div>` : ''}
      <div class="job-why">${(job.reasons || []).map(escapeHtml).join('；')}</div>
      ${blocked ? `<div class="job-block">跳过：${blockReasons.map(escapeHtml).join('；')}</div>` : ''}`;
    box.appendChild(div);
  }
}

function collectSelection() {
  const indexes = $$('#jobList input[type=checkbox]').filter((c) => c.checked).map((c) => Number(c.dataset.index));
  return indexes;
}

async function runApply(dryRun) {
  const indexes = collectSelection();
  if (!indexes.length) {
    toast('先在列表里勾选岗位');
    return;
  }
  const settings = state?.settings || {};
  if (!dryRun && settings.confirmBeforeApply) {
    const ok = window.confirm(`将真实投递 ${indexes.length} 个岗位，每单间隔 ${(settings.applyIntervalMs || 12000) / 1000}s，确认继续？`);
    if (!ok) return;
  }
  busy(['btnDryRun', 'btnApply'], true);
  toast(dryRun ? '预演中……' : '投递中，别关窗口');
  const res = await call('apply:run', { indexes, jobs: lastRanked, dryRun }, '投递');
  busy(['btnDryRun', 'btnApply'], false);
  if (res) {
    const okCount = res.results.filter((r) => r.ok).length;
    const blocked = res.results.filter((r) => r.blocked).length;
    $('#jobNotes').textContent = `本轮选中 ${res.results.length} 个，成功 ${okCount} 个，被规则拦掉 ${blocked} 个\n日志：${res.file}`;
    toast(`${dryRun ? '预演' : '投递'}结束：${okCount}/${res.results.length}`);
  }
}

$('#btnHome').addEventListener('click', async () => { await call('browser:home', null, '回首页'); await refreshPage(); });
$('#btnRefresh').addEventListener('click', refreshPage);
$('#btnSearch').addEventListener('click', async () => {
  const kw = state?.requirement?.text?.slice(0, 20) || '嵌入式开发';
  await call('browser:search', { kw }, '搜索');
  await refreshPage();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#pane-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'log') loadLog();
    if (tab.dataset.tab === 'kb') loadKb();
  });
});

$('#rRaw').addEventListener('input', saveResume);
['rName', 'rTitle', 'rYears', 'rEdu', 'rCity'].forEach((id) => {
  $(`#${id}`).addEventListener('change', saveResume);
});

$('#btnFetchResume').addEventListener('click', async () => {
  busy(['btnFetchResume'], true);
  toast('正在读取智联在线简历……');
  const res = await call('resume:fetch-site', null, '读取在线简历');
  busy(['btnFetchResume'], false);
  if (!res) return;
  $('#rRaw').value = res.text;
  if (res.parsed?.name) $('#rName').value = res.parsed.name;
  if (res.parsed?.years) $('#rYears').value = res.parsed.years;
  if (res.parsed?.city) $('#rCity').value = res.parsed.city;
  await persistResume();
  toast(`读到 ${res.chars} 字，已填进简历原文并自动补了年限/城市`);
});

$('#btnImportResume').addEventListener('click', async () => {
  const res = await call('resume:import-file', null, '导入简历');
  if (!res || res.canceled) return;
  $('#rRaw').value = res.text;
  toast(`已导入 ${res.file}，${res.chars} 字`);
});

$('#btnSaveResume').addEventListener('click', async () => {
  await persistResume();
  toast('已保存');
});

$('#btnOptimize').addEventListener('click', async () => {
  await persistResume();
  busy(['btnOptimize'], true);
  const res = await call('resume:optimize', null, '优化简历');
  busy(['btnOptimize'], false);
  if (!res) return;
  $('#rOpt').value = res.optimizedText || '';
  const lines = [];
  lines.push(`改动 ${res.changes.length} 处（去AI腔/拆长句）`);
  for (const c of res.changes.slice(0, 8)) lines.push(`· ${c.before} → ${c.after}`);
  lines.push('');
  lines.push('建议：');
  for (const s of res.suggestions) lines.push(`· ${s}`);
  if (res.keywords?.missing?.length) lines.push('', `岗位要求里简历没写：${res.keywords.missing.join('、')}`);
  $('#rNotes').textContent = lines.join('\n');
  toast('简历已优化');
});

['nText', 'nCity', 'nSalary'].forEach((id) => $(`#${id}`).addEventListener('change', saveNeed));
$('#btnSaveNeed').addEventListener('click', async () => { await persistNeed(); toast('需求已保存'); });

$('#btnApplyOpt').addEventListener('click', async () => {
  busy(['btnApplyOpt'], true);
  toast('写回原文、刷新 ATS 与版本库……');
  const res = await call('resume:apply-optimized', null, '一键更新');
  busy(['btnApplyOpt'], false);
  if (!res) return;
  $('#rRaw').value = $('#rOpt').value;
  const lines = [`原文已换成优化稿：${res.chars} 字，解析出 ${res.experiences} 段经历`];
  lines.push(`ATS ${res.ats.score} 分｜关键词覆盖 ${Math.round(res.ats.coverage * 100)}%`);
  if (res.ats.missing?.length) lines.push(`仍缺：${res.ats.missing.join('、')}`);
  if (res.rebuilt) {
    lines.push(`版本库按新稿重建 ${res.rebuilt.count} 个，当前用 ${res.rebuilt.activeId}`);
    renderVersions(res.rebuilt);
  } else {
    lines.push('还没抓过岗位，版本库这次没重建；去「岗位」页抓一页再点一次即可');
  }
  $('#rNotes').textContent = lines.join('\n');
  toast('已一键更新');
});
$('#btnSearchNeed').addEventListener('click', async () => {
  await persistNeed();
  await call('browser:search', { kw: $('#nText').value.slice(0, 24), city: '763' }, '搜索');
  await refreshPage();
});

$('#btnScrape').addEventListener('click', async () => {
  busy(['btnScrape'], true);
  const res = await call('jobs:scrape', null, '抓取岗位');
  if (!res) {
    busy(['btnScrape'], false);
    return;
  }
  lastJobs = res.page.jobs || [];
  lastRanked = res.ranked || [];
  const plan = await call('policy:plan', { jobs: lastRanked }, '筛选');
  busy(['btnScrape'], false);
  renderJobs(lastRanked, plan);
  if (res.matches) renderMatches(res.matches);
  const q = plan?.quota;
  toast(`抓到 ${lastJobs.length} 个，通过筛选 ${plan?.allowed?.length ?? 0} 个`);
  if (q) {
    $('#jobNotes').textContent = `今日已投 ${q.used}/${q.dailyCap}，今天还能投 ${q.remaining} 个；本轮计划投 ${plan.plan.length} 个`;
  }
});

$('#btnDryRun').addEventListener('click', () => runApply(true));

$('#btnAuto').addEventListener('click', async () => {
  const threshold = Number($('#sAutoScore').value || 55);
  const max = Number($('#sAutoMax').value || 5);
  busy(['btnAuto'], true);
  toast('自动模式运行中，别关窗口……');
  const res = await call('auto:apply', { dryRun: false, max, threshold }, '一键自动投递');
  busy(['btnAuto'], false);
  if (!res) return;
  const lines = [`关键词「${res.keyword}」`];
  for (const s of res.steps) {
    if (s.step === 'scrape') lines.push(`抓到 ${s.count} 个岗位`);
    if (s.step === 'score') lines.push(`≥${s.threshold} 分的有 ${s.passed} 个`);
    if (s.step === 'policy') lines.push(`规则放行 ${s.allowed}、拦掉 ${s.blocked}`);
    if (s.step === 'apply') lines.push(`投递：${s.title} ${s.ok ? '成功' : '失败'}`);
    if (s.step === 'risk-stop') lines.push(`风控命中「${s.signal}」，已中止`);
  }
  const ok = res.results.filter((r) => r.ok).length;
  lines.push(`\n本轮投出 ${ok} 个；今日配额 ${res.quota?.used ?? 0}/${res.quota?.dailyCap ?? 0}`);
  lines.push(`日志：${res.file}`);
  $('#jobNotes').textContent = lines.join('\n');
  if (res.matches) renderMatches(res.matches);
  toast(`自动投递结束：${ok} 个成功`);
});

$('#btnAutoReply').addEventListener('click', () => runAutoReply());

async function runAutoReply() {
  const send = $('#sReplySend').checked;
  busy(['btnAutoReply'], true);
  toast(send ? '批量回复并发送中……' : '批量生成回复草稿……');
  const res = await call('auto:reply', { send, max: Number($('#sReplyMax').value || 5) }, '批量自动回复');
  busy(['btnAutoReply'], false);
  if (!res) return;
  showReplyResult(res);
  toast(`处理 ${res.results.length} 个会话`);
}

function showReplyResult(res) {
  const lines = [`人设：${res.persona?.selfIntro || '—'}｜${res.persona?.city || ''}`];
  for (const r of res.results) {
    if (r.error) { lines.push(`・${r.company || '?'}：失败 ${r.error}`); continue; }
    const intent = (r.intents || []).map((i) => i.label).join('/');
    lines.push(`・${r.company || '?'}［${r.scenario || '其他'}］${intent ? `对方想知道：${intent}｜` : ''}${r.sent ? '已发送' : '草稿'}：${r.draft}`);
  }
  if (!res.results.length) lines.push('没抓到会话。确认右边停在消息页、且已登录。');
  $('#msgNotes').textContent = lines.join('\n');
  if (res.memory) renderMemory(res.memory);
}

function renderMemory(mem) {
  const box = $('#memBox');
  if (!mem) { box.innerHTML = ''; return; }
  const tops = (mem.topIntents || []).map((t) => `${escapeHtml(t.label)} ${escapeHtml(t.count)}次`).join(' · ') || '还没积累';
  const lessons = (mem.lessons || []).map((l) => `· ${escapeHtml(l.text)}`).join('<br>') || '· 同类问题出现 3 次以上会自动沉淀经验';
  const hrs = (mem.hr || []).slice(0, 4)
    .map((h) => `· ${escapeHtml(h.company)}：${(h.intents || []).map(escapeHtml).join('/') || '暂无意图'}`).join('<br>');
  box.innerHTML = `<div class="job-meta">记忆与进化（策略 v${escapeHtml(mem.strategyVersion)}｜聊过 ${escapeHtml(mem.hrCount)} 个 HR｜记录 ${escapeHtml(mem.stats?.questions)} 个问题）</div>
    <div class="job-meta">${mem.guard?.cooling ? `风控冷却中，还剩 ${escapeHtml(mem.guard.remainMin)} 分钟（不自动发消息/投递）` : '限速正常（消息/投递按每小时、每日额度走）'}</div>
    <div class="job-meta">待人工 ${escapeHtml(mem.handoffPending || 0)} 条${mem.handoffPending ? '（在「设置」看日志或手动回）' : ''}</div>
    <div class="job-meta">对方最在意：${tops}</div>
    <div class="hint">${lessons}</div>
    ${hrs ? `<div class="hint">${hrs}</div>` : ''}`;
}

$('#btnEvolve')?.addEventListener('click', async () => {
  const mem = await call('memory:evolve', null, '进化');
  if (mem) { renderMemory(mem); toast(`策略已进化到 v${mem.strategyVersion}`); }
});

window.api.on('jobs:auto', async (payload) => {
  if (!payload) return;
  lastJobs = payload.page?.jobs || [];
  lastRanked = payload.ranked || [];
  if (payload.matches) renderMatches(payload.matches);
  const plan = await call('policy:plan', { jobs: lastRanked }, '自动筛选');
  renderJobs(lastRanked, plan);
  toast(`岗位页已自动抓取 ${lastRanked.length} 个并打分`);
});

window.api.on('msg:auto', async (payload) => {
  if (!payload) return;
  if (payload.stage === 'list') {
    const items = payload.list?.items || [];
    $('#msgList').innerHTML = items.length
      ? items.map((it) => `<div class="job-item"><div class="job-title">${escapeHtml(it.company || it.title || '会话')}</div><div class="job-meta">${escapeHtml(it.text || '')}</div></div>`).join('')
      : '<div class="hint">没读到会话，可能需要登录或页面结构变了。</div>';
    toast(`已自动抓取 ${items.length} 个会话`);
  }
  if (payload.stage === 'reply') {
    showReplyResult(payload.res);
    const mem = await window.api.invoke('memory:summary');
    if (mem?.data) renderMemory(mem.data);
  }
  if (payload.stage === 'error') toast(`自动回复失败：${payload.error}`);
});

$('#btnFillNeed').addEventListener('click', async () => {
  const fresh = await window.api.invoke('app:state');
  const r = (fresh?.data?.resume) || state?.resume || {};
  const matches = (r.matches || []).slice(0, 3).map((m) => m.title);
  const skills = (r.skills || []).slice(0, 4);
  const parts = [r.city || '', ...matches, ...skills];
  $('#nText').value = parts.filter(Boolean).join(' ');
  await persistNeed();
  toast('已按简历和匹配岗位填好需求，可再改');
});
$('#btnApply').addEventListener('click', () => runApply(false));

$('#btnMsgOpen').addEventListener('click', async () => {
  const url = state?.settings?.messageUrl || 'https://www.zhaopin.com/message/';
  await call('browser:goto', { url }, '打开消息页');
  await refreshPage();
});

async function loadLog() {
  const text = await call('log:tail', { lines: 200 }, '读取日志');
  $('#logView').textContent = text || '（今天还没有日志）';
}
$('#btnLogReload').addEventListener('click', loadLog);
$('#btnLogOpen').addEventListener('click', () => call('log:open', null, '打开日志目录'));

// 知识库面板：看已学到的内容、改学习节奏、手动学一条
function renderKb(sum) {
  const box = $('#kbList');
  const head = $('#kbSummary');
  if (!sum) {
    head.textContent = '';
    box.innerHTML = '';
    return;
  }
  const when = sum.updatedAt ? new Date(sum.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '还没学过';
  head.innerHTML = `共 <b>${escapeHtml(sum.count || 0)}</b> 条 · 最近更新 ${escapeHtml(when)}`;
  const items = sum.latest || [];
  box.innerHTML = items.length
    ? items.map((it) => [
      `<div class="job"><div class="job-title">${escapeHtml(it.title || '')}</div>`,
      `<div class="job-meta">${escapeHtml(it.source || '')} · ${escapeHtml((it.ts || '').slice(0, 16).replace('T', ' '))}</div>`,
      `<div class="job-reason">${(it.points || []).map((p) => `· ${escapeHtml(p)}`).join('<br>')}</div></div>`,
    ].join('')).join('')
    : '<div class="hint">还没学到东西，点「现在学一条」试试。</div>';
}

async function loadKb() {
  const sum = await call('knowledge:summary', null, '读取知识库');
  if (sum) renderKb(sum);
  const cfg = await call('knowledge:config', null, '读取学习设置');
  if (cfg) {
    $('#kbEnabled').checked = cfg.enabled !== false;
    $('#kbCheckMin').value = cfg.checkMin ?? 10;
    $('#kbGapMin').value = cfg.gapMin ?? 30;
  }
}

$('#btnKbReload').addEventListener('click', loadKb);
$('#btnKbOpen').addEventListener('click', () => call('knowledge:open', null, '打开知识库文件'));
$('#btnKbLearn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '正在学…';
  try {
    const res = await call('knowledge:learn', null, '学习一条');
    if (res) {
      renderKb(res.summary);
      toast(res.res?.ok ? `学到一条：${res.res.item?.title || ''}` : `这轮没抓到：${res.res?.error || ''}`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '现在学一条';
  }
});
$('#btnKbSave').addEventListener('click', async () => {
  const learn = {
    enabled: $('#kbEnabled').checked,
    checkMin: Math.max(1, Number($('#kbCheckMin').value) || 10),
    gapMin: Math.max(1, Number($('#kbGapMin').value) || 30),
  };
  const cfg = await call('knowledge:config', learn, '保存学习节奏');
  if (cfg) toast(`已保存：${cfg.enabled ? '开启' : '关闭'}，每 ${cfg.checkMin} 分钟检查、冷却 ${cfg.gapMin} 分钟`);
});

$('#btnStats').addEventListener('click', async () => {
  const s = await call('stats:get', null, '读取统计');
  if (!s) return;
  const daily = Object.entries(s.daily || {}).map(([d, n]) => `${d.slice(5)}:${n}`).join('  ');
  $('#statsOut').textContent = [
    `累计投递 ${s.applied} 个｜HR 回复 ${s.replied} 个（回复率 ${s.replyRate}%）｜约面 ${s.interview} 个（面试率 ${s.interviewRate}%）`,
    `明确不合适 ${s.rejected} 个｜暂无回应 ${s.silent} 个`,
    `最近 14 天投递量：${daily}`,
    s.companies?.length ? `涉及公司：${s.companies.join('、')}` : '还没有投递记录，先跑一次预演或演练',
  ].join('\n');
});

$('#btnSim').addEventListener('click', async () => {
  busy(['btnSim'], true);
  toast('演练中，不联网……');
  const res = await call('sim:run', null, '全场景演练');
  busy(['btnSim'], false);
  if (!res) return;
  const lines = [];
  lines.push(`① 匹配：${res.steps.find((s) => s.step === 'match')?.count ?? 0} 个岗位已打分`);
  lines.push('② 规则筛选：');
  for (const b of res.blocked) lines.push(`   · 跳过「${b.title}」：${b.blockReasons.join('；')}`);
  lines.push(`   今日已投 ${res.quota?.used ?? 0}/${res.quota?.dailyCap ?? 40}，还能投 ${res.quota?.remaining ?? '?'} 个，本轮计划 ${res.applied.length} 个`);
  lines.push('③ 投递执行（模拟）：');
  for (const a of res.applied) lines.push(`   · ${a.title} / ${a.company} / ${a.score}分 → ${a.outcome}，下一次间隔 ${(a.intervalMs / 1000).toFixed(1)}s`);
  lines.push('④ HR 消息分场景回复：');
  for (const m of res.messages) lines.push(`   · [${m.scenario.label}] 他：${m.text}\n     我：${m.draft}`);
  lines.push('⑤ 漏斗：');
  lines.push(`   投递 ${res.stats.applied}｜回复 ${res.stats.replied}（${res.stats.replyRate}%）｜约面 ${res.stats.interview}（${res.stats.interviewRate}%）`);
  lines.push(`\n演练日志：${res.file}`);
  $('#simOut').textContent = lines.join('\n');
  toast('演练完成，结果已写日志');
});

const LLM_PRESETS = {
  freellmapi: { baseUrl: 'http://127.0.0.1:18902/v1', model: 'auto' },
  ofm: { baseUrl: 'http://127.0.0.1:18901/v1', model: 'combo:auto-failover' },
  g4f: { baseUrl: 'http://127.0.0.1:1337/v1', model: 'glm-5.3-flash' },
  pollinations: { baseUrl: 'https://text.pollinations.ai/openai', model: 'openai' },
  local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' },
  custom: { baseUrl: '', model: '' },
};

$('#sLlmProvider').addEventListener('change', () => {
  const p = LLM_PRESETS[$('#sLlmProvider').value] || {};
  $('#sLlmBase').value = p.baseUrl || '';
  $('#sLlmModel').value = p.model || '';
});

$('#btnLlmTest').addEventListener('click', async () => {
  busy(['btnLlmTest'], true);
  const cfg = {
    enabled: true,
    provider: $('#sLlmProvider').value,
    baseUrl: $('#sLlmBase').value.trim(),
    model: $('#sLlmModel').value.trim(),
    apiKey: $('#sLlmKey').value.trim(),
  };
  const res = await call('llm:test', cfg, '测试模型');
  busy(['btnLlmTest'], false);
  $('#llmState').textContent = res ? `可用：${res.model}｜${res.ms}ms｜${res.text}` : '不可用';
  toast(res ? `模型可用，${res.ms}ms` : '模型连接失败');
});

$('#btnSaveSettings').addEventListener('click', async () => {
  const patch = {
    logDir: $('#sLogDir').value.trim(),
    maxApplyPerRun: Number($('#sMaxApply').value || 10),
    applyIntervalMs: Number($('#sInterval').value || 12000),
    dailyCap: Number($('#sDailyCap').value || 40),
    excludeHeadhunter: $('#sExcludeHead').checked,
    blacklist: $('#sBlacklist').value,
    confirmBeforeApply: $('#sConfirmApply').checked,
    confirmBeforeSend: $('#sConfirmSend').checked,
    messageUrl: $('#sMsgUrl').value.trim(),
    resumeUrl: $('#sResumeUrl').value.trim(),
    searchUrlTemplate: $('#sSearchTpl').value.trim(),
    weights: {
      skill: Number($('#wSkill').value || 0.3),
      experience: Number($('#wExp').value || 0.2),
      keyword: Number($('#wKw').value || 0.15),
      project: Number($('#wProj').value || 0.2),
      education: Number($('#wEdu').value || 0.1),
      salary: Number($('#wSal').value || 0.05),
    },
    hardGate: $('#sHardGate').checked,
    autoThreshold: Number($('#sAutoScore').value || 55),
    autoApplyMax: Number($('#sAutoMax').value || 5),
    autoReplyMax: Number($('#sReplyMax').value || 5),
    autoReplySend: $('#sReplySend').checked,
    autoReplyOnOpen: $('#sAutoOpen').checked,
    logRetentionDays: Number($('#sLogDays').value || 30),
    llm: {
      enabled: $('#sLlmOn').checked,
      provider: $('#sLlmProvider').value,
      baseUrl: $('#sLlmBase').value.trim(),
      model: $('#sLlmModel').value.trim(),
      apiKey: $('#sLlmKey').value.trim(),
    },
  };
  const res = await call('settings:save', patch, '保存设置');
  if (res) {
    state.settings = res;
    toast('设置已保存，日志目录下次启动生效');
  }
});

function renderVersions(data) {
  const box = $('#verList');
  box.innerHTML = '';
  const versions = data?.versions || [];
  if (!versions.length) {
    box.innerHTML = '<p class="hint">还没有版本库。抓一页岗位后点「生成 / 刷新版本库」。</p>';
    return;
  }
  for (const v of versions) {
    const active = v.id === data.activeId;
    const div = document.createElement('div');
    div.className = active ? 'job active-version' : 'job';
    div.innerHTML = `
      <div class="job-head">
        <span class="job-name">${escapeHtml(v.label)}</span>
        <span class="score${v.atsScore >= 85 ? ' high' : ''}">ATS ${escapeHtml(v.atsScore)}</span>
      </div>
      <div class="job-meta">${(v.targetTags || []).map(escapeHtml).join(' / ') || '通用'}</div>
      <div class="job-meta">覆盖 ${Math.round((v.keywordCoverage || 0) * 100)}%${v.missingKeywords?.length ? ` · 缺 ${v.missingKeywords.slice(0, 5).map(escapeHtml).join('、')}` : ''}</div>
      <div class="job-meta">${escapeHtml(v.experienceCount)} 段经历 · 项目 ${v.projects?.length || 0} 个</div>
      <div class="job-why">${(v.diff || []).map(escapeHtml).join('；')}</div>
      <div class="row actions">
        <button class="ghost" data-ver="${escapeHtml(v.id)}" ${active ? 'disabled' : ''}>${active ? '当前投递版本' : '设为投递版本'}</button>
        <button class="ghost" data-ats="${escapeHtml(v.id)}">对这个版本做 ATS</button>
      </div>`;
    box.appendChild(div);
  }
  $$('#verList [data-ver]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await call('versions:activate', { id: btn.dataset.ver }, '切换版本');
      if (res) {
        const list = await call('versions:list', null, '读取版本');
        renderVersions(list);
        toast(`已切换到 ${res.versions?.find((v) => v.id === res.activeId)?.label || res.activeId}`);
      }
    });
  });
  $$('#verList [data-ats]').forEach((btn) => {
    btn.addEventListener('click', () => runAts(btn.dataset.ats));
  });
}

async function runAts(versionId) {
  busy(['btnAts'], true);
  const res = await call('ats:check', versionId ? { versionId } : {}, 'ATS 自测');
  busy(['btnAts'], false);
  if (!res) return;
  const lines = [];
  lines.push(`${res.label || '当前简历'} ｜ ATS ${res.score} 分｜关键词覆盖 ${Math.round(res.keywords.coverage * 100)}%（门槛 ${Math.round(res.keywords.threshold * 100)}%）`);
  lines.push(`检测词：${(res.targetKeywords || []).join('、')}`);
  lines.push(`格式：${res.format.passed}/${res.format.total} 项通过`);
  for (const c of res.format.checks) lines.push(`  ${c.pass ? '✓' : '✗'} ${c.name}：${c.detail}`);
  if (res.keywords.missing.length) {
    lines.push(`缺的关键词：${res.keywords.missing.join('、')}`);
    for (const s of res.keywords.suggestions.slice(0, 5)) lines.push(`  ・${s.keyword} → 放 ${s.where}`);
  } else lines.push('关键词全覆盖');
  $('#atsOut').textContent = lines.join('\n');
}

$('#btnVerGen').addEventListener('click', async () => {
  busy(['btnVerGen'], true);
  toast('生成版本库……');
  const res = await call('versions:generate', null, '生成版本库');
  busy(['btnVerGen'], false);
  if (!res) return;
  renderVersions(res);
  const notes = [`生成 ${res.versions.length} 个版本，当前用 ${res.activeId}`];
  for (const v of res.versions) notes.push(`・${v.label}｜标签 ${(v.targetTags || []).join('/') || '通用'}｜ATS ${v.atsScore}｜覆盖 ${Math.round(v.keywordCoverage * 100)}%`);
  $('#verOut').textContent = notes.join('\n');
  toast(`生成 ${res.versions.length} 个版本`);
});

$('#btnAts').addEventListener('click', () => runAts());

$('#btnFunnel').addEventListener('click', async () => {
  const res = await call('funnel:get', null, '版本漏斗');
  if (!res) return;
  const lines = ['版本漏斗（按投递时选中的版本统计）：'];
  if (!res.funnel.length) lines.push('  还没有版本数据，先在「版本」页生成一次');
  for (const f of res.funnel) {
    lines.push(`・${f.label}：投 ${f.applied}｜回复 ${f.replies}（${f.replyRate}%）｜约面 ${f.interviews}（${f.interviewRate}%）｜无回应 ${f.silent}`);
  }
  $('#funnelOut').textContent = lines.join('\n');
  if (!res.alerts.length) {
    $('#alertsOut').textContent = '暂无告警';
  } else {
    $('#alertsOut').textContent = `告警 ${res.alerts.length} 条：\n${res.alerts.map((a) => `・[${a.signal}] ${a.detail}\n  → ${a.action}`).join('\n')}`;
  }
});

(async function init() {
  state = await call('app:state', null, '初始化');
  if (state) fillForms(state);
  const mem = await call('memory:summary', null, '读取记忆');
  if (mem) renderMemory(mem);
  const lib = await call('versions:list', null, '读取版本库');
  if (lib) renderVersions(lib);
  await refreshPage();
})();


