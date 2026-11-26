// 自动求职流水线：搜索 → 抓取 → 打分 → 过规则 → 批量投递 →（可选）按人设批量回消息
const scoreLib = require('./score');
const policy = require('./policy');
const tracker = require('./tracker');
const { parseResume } = require('./parse');
const scenarios = require('./scenarios');
const { buildPersona, enrichResume } = require('./persona');
const memory = require('./memory');
const llm = require('./llm');
const personaRules = require('./personaRules');
const guard = require('./guard');
const matchLlm = require('./matchLlm');
const hrMind = require('./hrMind');
const knowledge = require('./knowledge');

// 同一家公司 + 同一句话，三天内只回一次，避免反复给 HR 发同一段话
function questionHash(company, text) {
  const s = `${company || ''}|${String(text || '').trim()}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function alreadyAnswered(store, company, text) {
  const log = store.get('replyLog') || [];
  const h = questionHash(company, text);
  const hit = log.find((r) => r.company === company && r.hash === h);
  if (!hit) return null;
  const age = Date.now() - Date.parse(hit.ts);
  if (!(age >= 0) || age > 3 * 86400000) return null;
  return hit;
}

function logReply(store, { company, text, action, reply }) {
  const log = store.get('replyLog') || [];
  log.push({ company, hash: questionHash(company, text), action, reply: String(reply || '').slice(0, 80), ts: new Date().toISOString() });
  store.set('replyLog', log.slice(-300));
}

const CITY_WORDS = /^(广州|深圳|上海|北京|杭州|成都|武汉|南京|苏州|东莞|佛山)$/;

// 用模型按人设写一条能直接发出去的回复；失败由调用方回落规则稿
async function llmDraft({ llmCfg, persona, job, threadText, analyses, baseDraft, avoidText, mind }) {
  const intents = (analyses || [])
    .map((a) => `- ${a.label}：对方想知道「${a.concern}」，可以这样答：${a.answer}`)
    .join('\n') || '- 暂时看不出明确意图，按对方字面问题答';
  let kb = '';
  try {
    kb = knowledge.brief(4);
  } catch (e) {
    kb = '';
  }
  const system = [
    `你在替一个真实的求职者回 HR 消息，不要暴露是 AI。`,
    `人设：${persona.name}，${persona.years || ''}年销售，做到${persona.role || '销售总监'}，做${(persona.industries || []).join('、') || '渠道'}，常年外勤出差、到处飞，人在${persona.city || '本地'}。`,
    `语气：平实、简短、专业，像老手回消息。不客套、不道歉、不吹牛、不堆形容词，严禁：${(persona.banned || []).join('、')}、您好、您好在、稍等、感谢、麻烦您、非常、特别。`,
    '只能用简历里真实存在的经历，不编造、不夸大。',
    `业绩口径只能用这两条，别报更大的数：${(persona.salesFacts || []).join('；')}。不要提其他金额、增长率、团队人数。`,
  ].join('\n');
  const user = [
    `【岗位】${job.title || ''}（${job.company || ''}）`,
    `【最近对话】`,
    threadText || '',
    '',
    `【对方这句话背后想知道什么】`,
    intents,
    mind
      ? [
          '',
          '【心理分析结论，按这个分寸答】',
          `意图：${mind.intentLabel || mind.intent}（阶段：${mind.stage}）`,
          mind.subtext ? `潜台词：${mind.subtext}` : '',
          mind.risk ? `风险：${mind.risk}` : '',
          `这一步该说：${(mind.strategy?.answerNow || []).join('、')}`,
          `先别说：${(mind.strategy?.holdBack || []).join('、')}`,
          `可以反问：${(mind.strategy?.askBack || []).join('、') || '不用反问'}`,
        ].filter(Boolean).join('\n')
      : '',
    '',
    kb ? `【平时攒的职场常识，只当判断背景，别背给HR听】\n${kb}` : '',
    '',
    `【参考底稿】${baseDraft || ''}`,
    avoidText ? `【刚才已经发过的一句，不要重复或换汤不换药】${avoidText}` : '',
    '',
    '写一条能直接发出去的回复：20-40字，最多两句话，问什么答什么，先给结论再给一个真实事实。不要解释、不要客套、不要重复对方的话。不要编造链接、附件地址、电话、微信号。只输出回复正文。',
    '只回答他这一步真正想知道的，不要一口气把履历、薪资、出差、稳定性全交代出去；写了holdBack里的内容就等于露底。',
    '说话像个在外跑业务的老销售：直接、有点干脆，可以用"行""可以""没问题"这类口语开头，不要用"您好""请问""感谢"这类客套。',
    '不许反问式收尾（例如"您想了解哪方面"），除非真的必须问清时间地点；能自己判断的就直接给判断。',
  ].join('\n');
  // 回复要快：主模型 → OFM → g4f，不等 pollinations 的 46 秒冷却
  const text = await llm.chatReliable(llmCfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 120, temperature: 0.35, timeoutMs: 30000 });
  const clean = text.replace(/^["“]|["”]$/g, '').trim();
  // 模型爱编链接/附件地址，出现就不用它，回落到规则稿
  if (/http|www\.|example\.com|链接|附件地址|微信：|电话：|<\S+>/i.test(clean)) {
    throw new Error('模型输出含编造链接或联系方式，已丢弃');
  }
  // 金额只允许数千万元 /数千万元，出现「亿」或别的「万」级数字就丢弃
  if (/亿/.test(clean)) throw new Error('模型报了不实金额（亿级），已丢弃');
  if (/[%％]|百分之|提升了?\s*\d|增长\s*\d/.test(clean)) throw new Error('模型报了百分比/增幅，已丢弃');
  for (const m of clean.matchAll(/([0-9][0-9,.]*)\s*万/g)) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (![2000, 2700].includes(n)) throw new Error(`模型报了不实金额 ${n} 万，已丢弃`);
  }
  // 只留第一到两句，超过 45 字就截断，避免啰嗦
  const parts = clean.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
  let out = '';
  for (const p of parts) {
    if (out && out.length + p.length > 45) break;
    out += p;
    if (out.length >= 20) break;
  }
  return (out || clean.slice(0, 45)).trim();
}


function keywordOf(requirement, override) {  if (override) return override;
  const tokens = String(requirement?.text || '').split(/[\s,，、/]+/).filter(Boolean);
  const hit = tokens.find((t) => !CITY_WORDS.test(t) && !/^\d/.test(t) && t.length >= 2);
  return hit || requirement?.city || '销售';
}

function prepCtx(store) {
  const resume = store.get('resume');
  const requirement = store.get('requirement');
  const settings = store.get('settings');
  const parsed = resume.parsed || parseResume(resume.raw || '');
  const enriched = enrichResume(resume, parsed);
  const ctx = scoreLib.buildCtx({ ...resume, parsed }, requirement, { weights: settings.weights, hardGate: settings.hardGate });
  return { resume: enriched, requirement, settings, parsed, ctx };
}

async function autoApply({ wc, auto, logger, store, options = {} }) {
  const { resume, requirement, settings, ctx } = prepCtx(store);
  const steps = [];
  let history = tracker.ensure(store.get('history'));
  const kw = keywordOf(requirement, options.keyword);
  const tpl = settings.searchUrlTemplate || 'https://www.zhaopin.com/jobs/?jl=763&kw={kw}';
  const url = tpl.replace('{kw}', encodeURIComponent(kw)).replace('{jl}', '763');

  await auto.loadUrl(wc, url, logger);
  await auto.sleep(2500);
  steps.push({ step: 'search', keyword: kw, url });
  logger.info('auto', '自动模式：打开搜索页', { keyword: kw });

  const scraped = await auto.scrapeJobs(wc, logger);
  const jobs = scraped.jobs || [];
  steps.push({ step: 'scrape', count: jobs.length });

  const ranked = scoreLib.rankJobs(jobs, ctx);
  // 规则分只做粗排，再让模型读 JD 做语义精排，并给出一句话理由
  const rerank = await matchLlm.rerank({ jobs: ranked, resume, parsed, requirement, llmCfg: settings.llm, logger });
  const scored = rerank.jobs.map((j) => ({ ...j, score: j.finalScore != null ? j.finalScore : j.score }));
  const threshold = Number(options.threshold ?? settings.autoThreshold ?? 55);
  const passed = scored.filter((j) => j.score >= threshold && !matchLlm.blockedByModel(j));
  steps.push({
    step: 'score',
    threshold,
    llmUsed: rerank.llmUsed,
    llmFailed: rerank.failed,
    passed: passed.length,
    top: passed.slice(0, 3).map((j) => ({ title: j.title, company: j.company, score: j.score, model: j.llmScore, reason: j.reason })),
  });
  logger.info('auto', '自动模式：打分完成', { total: jobs.length, passed: passed.length, threshold, llm: rerank.llmUsed });

  const plan = policy.planRun(passed, { settings, requirement, resume, history });
  steps.push({ step: 'policy', allowed: plan.allowed.length, blocked: plan.blocked.length, quota: plan.quota });

  const limit = Math.max(1, Math.min(Number(options.max ?? settings.autoApplyMax ?? 5), plan.plan.length));
  const results = [];
  const dryRun = options.dryRun === true;

  for (const job of plan.plan.slice(0, limit)) {
    try {
      if (!dryRun) {
        const okDo = guard.allow(store, settings, 'apply');
        if (!okDo.ok) {
          steps.push({ step: 'guard-stop', reason: okDo.reason });
          logger.warn('guard', '投递触到限速，本轮提前停', { reason: okDo.reason });
          break;
        }
      }
      await auto.openJobCard(wc, job.index, logger);
      const detail = await auto.scrapeDetail(wc, logger);
      const risk = policy.detectRisk(detail.body);
      if (risk.risk) {
        const t = guard.trip(store, { reason: `投递页出现「${risk.signal}」` });
        steps.push({ step: 'risk-stop', signal: risk.signal, coolMin: t.waitMin });
        logger.warn('auto', `页面出现「${risk.signal}」，自动模式中止，冷却 ${t.waitMin} 分钟`, { job: job.title });
        addHandoff(store, { company: job.company, question: '', rule: 'B10', reason: `投递页出现「${risk.signal}」，暂停 ${t.waitMin} 分钟` });
        break;
      }
      if (dryRun) {
        results.push({ dryRun: true, ok: true, title: detail.title || job.title, company: job.company, score: job.score });
        steps.push({ step: 'dry-run', title: detail.title || job.title, score: job.score });
      } else {
        const applied = await auto.applyCurrentJob(wc, {}, logger);
        const rec = tracker.addApplied(history, {
          title: detail.title || job.title,
          company: job.company,
          salary: job.salary,
          score: job.score,
        }, { url: applied.url, versionId: store.get('versionLib').activeId || '' });
        history = rec.history;
        store.set('history', history);
        results.push({ ok: applied.ok, title: detail.title || job.title, company: job.company, score: job.score, label: applied.label });
        steps.push({ step: 'apply', title: detail.title || job.title, ok: applied.ok });
        if (applied.ok) { guard.record(store, 'apply'); guard.success(store); }
        else {
          const f = guard.fail(store, settings, '投递失败');
          if (f.tripped) { steps.push({ step: 'guard-trip', reason: '连续投递失败' }); break; }
        }
      }
    } catch (err) {
      guard.fail(store, settings, err.message);
      results.push({ ok: false, title: job.title, error: err.message });
      steps.push({ step: 'error', title: job.title, error: err.message });
      logger.error('auto', '自动投递单条失败', { title: job.title, msg: err.message });
    }
    const wait = guard.gap(settings, 'apply');
    steps.push({ step: 'wait', ms: wait });
    await auto.sleep(wait);
  }

  steps.push({ step: 'done', applied: results.filter((r) => r.ok && !r.dryRun).length });
  return { keyword: kw, ranked: scored.slice(0, 30), passed, plan, results, steps, history };
}

function addHandoff(store, { company, question, rule, reason }) {
  const list = store.get('handoff') || [];
  list.push({
    company: company || '',
    question: String(question || '').slice(0, 120),
    rule: rule || '',
    reason: reason || '',
    ts: new Date().toISOString(),
    done: false,
  });
  store.set('handoff', list.slice(-200));
}

async function autoReply({ wc, auto, logger, store, options = {} }) {
  const { resume, requirement, settings, parsed } = prepCtx(store);
  const persona = buildPersona(parsed, requirement);
  const steps = [];
  const results = [];

  const cool = guard.cooling(store);
  if (cool.cooling) {
    logger.warn('guard', '风控冷却中，本轮不自动回复', { remainMin: cool.remainMin });
    return { steps: [{ step: 'cooling', remainMin: cool.remainMin }], results: [], cooling: true };
  }

  await auto.loadUrl(wc, settings.messageUrl || 'https://i.zhaopin.com/im', logger);
  await auto.sleep(2500);
  for (let i = 0; i < 15; i += 1) {
    const n = await auto.run(wc, '(() => document.querySelectorAll(".im-session-item").length)()').catch(() => 0);
    if (Number(n) > 0) break;
    await auto.sleep(1000);
  }
  const list = await auto.scrapeMessages(wc, logger);
  steps.push({ step: 'message-list', count: list.count || 0, url: list.url });

  const max = Math.max(1, Number(options.max ?? settings.autoReplyMax ?? 5));
  let send = options.send === true;
  if (send && !personaRules.inWorkHours()) {
    logger.warn('message', '不在 9-22 点工作时段，本轮只出稿不发送');
    send = false;
  }
  const items = (list.items || []).slice(0, max);

  for (const item of items) {
    try {
      const okDo = send ? guard.allow(store, settings, 'message') : { ok: true };
      if (!okDo.ok) {
        steps.push({ step: 'guard-stop', reason: okDo.reason });
        logger.warn('guard', '触到限速，本轮提前停', { reason: okDo.reason });
        break;
      }
      await auto.openConversation(wc, item.index, logger);
      const pageText = await auto
        .run(wc, '(() => { const el = document.querySelector(\'[class*="captcha"],[class*="verify"],[class*="risk"],[class*="slide-verify"]\'); return el ? el.innerText.slice(0, 120) : ""; })()')
        .catch(() => '');
      const risk = guard.detect(pageText);
      if (risk.risk) {
        const t = guard.trip(store, { reason: `页面出现「${risk.signal}」` });
        steps.push({ step: 'risk-detected', signal: risk.signal, coolMin: t.waitMin });
        logger.error('guard', '页面疑似风控，暂停自动回复', { signal: risk.signal, coolMin: t.waitMin });
        addHandoff(store, { company: item.company, question: '', rule: 'B10', reason: `页面出现「${risk.signal}」，已暂停 ${t.waitMin} 分钟` });
        break;
      }
      const thread = await auto.readThread(wc);
      const msgs = thread.messages || [];
      const last = msgs[msgs.length - 1];
      const lastOther = msgs.filter((m) => !m.isMine).slice(-1)[0];
      if (!lastOther || (last && last.isMine)) {
        results.push({ company: item.company, action: 'skip', draft: '', reason: '最后一条是我方或没有可回内容' });
        steps.push({ step: 'skip', company: item.company, reason: 'already-replied' });
        continue;
      }
      const text = lastOther.text || '';
      if (/已发送附件简历|已将在线简历发至|发您在线简历|^(同意了|已同意)/.test(text)) {
        results.push({ company: item.company, action: 'skip', draft: '', reason: '我方系统消息' });
        continue;
      }
      // 同一家公司问同一句话，三天内不重复回（截图里连发四条就是这里漏了去重）
      const prev = alreadyAnswered(store, item.company, text);
      if (prev) {
        results.push({ company: item.company, action: 'skip', draft: '', reason: `已回过（${prev.ts}）：${prev.reply}` });
        steps.push({ step: 'skip', company: item.company, reason: 'already-answered' });
        continue;
      }
      // 页面上有「同意」按钮，就是对方在要简历：点同意，一个字都不发
      const agreeReady = await auto.hasAgree(wc).catch(() => false);
      if (agreeReady) {
        if (send) {
          const agreed = await auto.agreeResume(wc, logger);
          if (!agreed.ok) {
            results.push({ company: item.company, rule: 'R02', handoff: true, action: 'agreeFailed', draft: '' });
            steps.push({ step: 'resume-agree-failed', company: item.company });
            addHandoff(store, { company: item.company, question: text, rule: 'R02', reason: '同意按钮没点到，需人工发简历' });
            continue;
          }
          guard.record(store, 'message');
          guard.success(store);
        }
        logReply(store, { company: item.company, text, action: 'agreeResume', reply: '（点同意，系统自动发在线简历）' });
        results.push({ company: item.company, rule: 'R02', scenario: '点同意发在线简历', draft: '', sent: Boolean(send), mode: 'resume-card' });
        steps.push({ step: 'resume-agree', company: item.company });
        memory.remember(store, { company: item.company, question: text, analyses: memory.analyze(text, persona), draft: '（点同意，系统自动发在线简历）', sent: Boolean(send) });
        await auto.sleep(guard.gap(settings, 'message') + 2000);
        continue;
      }
      const askedAll = (thread.messages || []).filter((m) => !m.isMine).map((m) => m.text).slice(-4).join(' ');
      const analyses = memory.analyze(`${text} ${askedAll}`, persona);
      // 先揣摩 HR 这句话背后的用意，再决定答不答、答哪一层
      const mind = await hrMind.analyze({
        text,
        thread: askedAll,
        job: { title: item.title || '', company: item.company || '' },
        llmCfg: settings.llm,
      });
      steps.push({ step: 'hr-mind', company: item.company, intent: mind.intent, stage: mind.stage, subtext: mind.subtext, source: mind.source });
      analyses.push({
        code: `mind_${mind.intent}`,
        label: mind.intentLabel || mind.intent,
        concern: mind.subtext || '',
        answer: (mind.strategy?.answerNow || []).join('、'),
      });
      if (!mind.shouldReply) {
        const isSpam = mind.intent === 'spam';
        results.push({ company: item.company, rule: `M_${mind.intent}`, action: isSpam ? 'skip' : 'handoff', draft: '', mind });
        steps.push({ step: isSpam ? 'skip' : 'handoff', company: item.company, intent: mind.intent, reason: mind.subtext });
        if (!isSpam) addHandoff(store, { company: item.company, question: text, rule: `M_${mind.intent}`, reason: mind.subtext || '需要人工判断' });
        memory.remember(store, { company: item.company, question: text, analyses, draft: `（${isSpam ? '忽略' : '转人工'}：${mind.intent}）`, sent: false });
        continue;
      }
      const decision = personaRules.decide({
        text,
        pick: (ruleId, total) => guard.nextVariant(store, `v_${ruleId}`, total),
      });
      if (decision.action === 'pause') {
        results.push({ company: item.company, rule: decision.id, handoff: true, action: 'pause' });
        steps.push({ step: 'risk-pause', company: item.company });
        const t = guard.trip(store, { reason: `对方消息含风控提示：${text.slice(0, 40)}` });
        addHandoff(store, { company: item.company, question: text, rule: decision.id, reason: `风控提示，全部自动回复暂停 ${t.waitMin} 分钟` });
        break;
      }
      if (decision.action === 'skip' || decision.action === 'handoff') {
        results.push({ company: item.company, rule: decision.id, handoff: decision.action === 'handoff', action: decision.action, draft: '' });
        steps.push({ step: decision.action, company: item.company, rule: decision.id });
        if (decision.action === 'handoff') addHandoff(store, { company: item.company, question: text, rule: decision.id, reason: '需人工回复' });
        memory.remember(store, { company: item.company, question: text, analyses, draft: `（${decision.action === 'skip' ? '按规则不回' : '转人工'} ${decision.id}）`, sent: false });
        continue;
      }
      if (decision.action === 'agreeResume') {
        if (send) {
          const agreed = await auto.agreeResume(wc, logger);
          if (!agreed.ok) {
            results.push({ company: item.company, rule: 'R02', handoff: true, action: 'agreeFailed', draft: '' });
            steps.push({ step: 'resume-agree-failed', company: item.company });
            addHandoff(store, { company: item.company, question: text, rule: 'R02', reason: '同意按钮没点到，需人工发简历' });
            continue;
          }
        }
        results.push({ company: item.company, rule: 'R02', scenario: '点同意发在线简历', draft: '', sent: Boolean(send), mode: 'resume-card' });
        steps.push({ step: 'resume-agree', company: item.company });
        if (send) { guard.record(store, 'message'); guard.success(store); }
        logReply(store, { company: item.company, text, action: 'agreeResume', reply: '（点同意）' });
        memory.remember(store, { company: item.company, question: text, analyses, draft: '（点同意，系统自动发在线简历）', sent: Boolean(send) });
        await auto.sleep(guard.gap(settings, 'message') + 2000);
        continue;
      }
      if (decision.action === 'reply') {
        let text2 = decision.text;
        // 先用模型按人设写，写不出来再用规则稿，规则稿只当兜底
        if (llm.ready(settings.llm)) {
          const lastMine = msgs.filter((m) => m.isMine).slice(-1)[0];
          try {
            const drafted = await llmDraft({
              llmCfg: settings.llm,
              persona,
              job: { title: item.title || '', company: item.company || '' },
              threadText: askedAll || text,
              analyses,
              baseDraft: decision.text,
              avoidText: lastMine ? lastMine.text : '',
              mind,
            });
            const checked = personaRules.polish(drafted);
            if (checked) text2 = checked;
            else logger.warn('llm', '模型稿没过红线，改用规则稿', { draft: drafted });
          } catch (err) {
            logger.warn('llm', '模型写回复失败，用规则稿', { msg: err.message });
          }
        }
        if (!text2) {
          results.push({ company: item.company, rule: decision.id, handoff: true, action: 'blocked', draft: '' });
          continue;
        }
        if (send) {
          const sent = await auto.sendMessage(wc, text2, logger);
          results.push({ company: item.company, rule: decision.id, draft: text2, sent: Boolean(sent.ok), intents: analyses });
          steps.push({ step: 'sent', company: item.company, rule: decision.id, text: text2 });
          memory.remember(store, { company: item.company, question: text, analyses, draft: text2, sent: Boolean(sent.ok) });
          if (sent.ok) { guard.record(store, 'message'); guard.success(store); }
          else {
            const f = guard.fail(store, settings, '回复发送失败');
            if (f.tripped) { steps.push({ step: 'guard-trip', reason: '连续发送失败' }); break; }
          }
        } else {
          results.push({ company: item.company, rule: decision.id, draft: text2, sent: false, intents: analyses });
          steps.push({ step: 'draft', company: item.company, rule: decision.id, text: text2 });
          memory.remember(store, { company: item.company, question: text, analyses, draft: text2, sent: false });
        }
        logReply(store, { company: item.company, text, action: 'reply', reply: text2 });
        await auto.sleep(guard.gap(settings, 'message'));
        continue;
      }
      // 兜底：没有命中固定规则时，才用场景稿 + 模型（仍然受长度/数字红线约束）
      const drafted = scenarios.draftsFor({
        text,
        resume: { ...resume, parsed },
        requirement,
        job: { title: item.title || '', company: item.company || '' },
      });
      const baseDraft = drafted.drafts?.[0]?.text || '';
      let draft = memory.enhance(baseDraft, analyses, persona);
      if (llm.ready(settings.llm)) {
        try {
          draft = await llmDraft({ llmCfg: settings.llm, persona, job: { title: item.title || '', company: item.company || '' }, threadText: askedAll || text, analyses, baseDraft, mind });
        } catch (err) {
          logger.warn('llm', '写回复失败，回落到规则稿', { msg: err.message });
        }
      }
      const safe = personaRules.polish(draft);
      if (!safe) {
        results.push({ company: item.company, rule: decision.id, handoff: true, action: 'blocked', draft: String(draft).slice(0, 80) });
        steps.push({ step: 'blocked', company: item.company, reason: '黑名单/数字红线' });
        continue;
      }
      if (send) {
        const sent = await auto.sendMessage(wc, safe, logger);
        results.push({ company: item.company, rule: decision.id, draft: safe, sent: Boolean(sent.ok), intents: analyses });
        steps.push({ step: 'sent', company: item.company, text: safe });
        memory.remember(store, { company: item.company, question: text, analyses, draft: safe, sent: Boolean(sent.ok) });
        if (sent.ok) { guard.record(store, 'message'); guard.success(store); }
        else {
          const f = guard.fail(store, settings, '兜底回复发送失败');
          if (f.tripped) { steps.push({ step: 'guard-trip', reason: '连续发送失败' }); break; }
        }
      } else {
        results.push({ company: item.company, rule: decision.id, draft: safe, sent: false, intents: analyses });
        steps.push({ step: 'draft', company: item.company, text: safe });
        memory.remember(store, { company: item.company, question: text, analyses, draft: safe, sent: false });
      }
      logReply(store, { company: item.company, text, action: 'reply', reply: safe });
      const wait = guard.gap(settings, 'message');
      await auto.sleep(wait);
    } catch (err) {
      guard.fail(store, settings, err.message);
      results.push({ company: item.company, error: err.message });
      steps.push({ step: 'error', company: item.company, error: err.message });
    }
  }

  steps.push({ step: 'done', drafted: results.filter((r) => r.draft).length, sent: results.filter((r) => r.sent).length });
  const mem = memory.evolve(store);
  steps.push({ step: 'memory', hr: Object.keys(mem.hr || {}).length, strategyVersion: mem.strategyVersion, lessons: mem.lessons.length });
  return { persona, results, steps, memory: memory.summary(store) };
}

module.exports = { autoApply, autoReply, keywordOf };
