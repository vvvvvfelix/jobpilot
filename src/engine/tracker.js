// 投递/沟通的全过程状态记录，用于去重、漏斗统计和回溯
const { jobKey } = require('./policy');

const STAGES = ['submitted', 'replied', 'interview', 'rejected', 'silent'];

function ensure(history) {
  const h = history || {};
  h.applied = Array.isArray(h.applied) ? h.applied : [];
  h.replied = Array.isArray(h.replied) ? h.replied : [];
  h.interviews = Array.isArray(h.interviews) ? h.interviews : [];
  h.rejects = Array.isArray(h.rejects) ? h.rejects : [];
  return h;
}

function addApplied(history, job, extra = {}) {
  const h = ensure(history);
  const key = jobKey(job);
  if (h.applied.some((a) => a.key === key)) return { history: h, duplicate: true };
  h.applied.push({
    ts: Date.now(),
    key,
    title: job.title || '',
    company: job.company || '',
    salary: job.salary || '',
    // 调用方有的把 score 放在 job 上，有的放在 extra 上，两处都兼容
    score: job.score ?? extra.score ?? null,
    versionId: extra.versionId || '',
    status: 'submitted',
    url: extra.url || '',
  });
  return { history: h, duplicate: false };
}

function markStatus(history, key, status, note) {
  const h = ensure(history);
  const item = h.applied.find((a) => a.key === key);
  if (!item) return h;
  item.status = status;
  item.updatedAt = Date.now();
  if (note) item.note = note;
  return h;
}

function addReplied(history, payload) {
  const h = ensure(history);
  h.replied.push({ ts: Date.now(), scenario: payload.scenario || 'other', text: payload.text, company: payload.company || '' });
  return h;
}

function addInterview(history, payload) {
  const h = ensure(history);
  h.interviews.push({ ts: Date.now(), ...payload });
  return h;
}

function addReject(history, payload) {
  const h = ensure(history);
  h.rejects.push({ ts: Date.now(), ...payload });
  return h;
}

function stats(history, days = 14) {
  const h = ensure(history);
  const today = new Date();
  const buckets = {};
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    buckets[`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] = 0;
  }
  for (const a of h.applied) {
    const d = new Date(a.ts);
    const pad = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (key in buckets) buckets[key] += 1;
  }

  const statusCount = {};
  for (const stage of STAGES) statusCount[stage] = 0;
  for (const a of h.applied) {
    statusCount[a.status || 'submitted'] = (statusCount[a.status || 'submitted'] || 0) + 1;
  }

  const applied = h.applied.length;
  const interview = statusCount.interview || 0;
  const rejected = statusCount.rejected || 0;
  const responded = (statusCount.replied || 0) + interview + rejected;
  const silent = statusCount.submitted || 0;
  return {
    applied,
    replied: responded,
    interview,
    rejected,
    silent,
    replyRate: applied ? Math.min(100, Math.round((responded / applied) * 100)) : 0,
    interviewRate: applied ? Math.min(100, Math.round((interview / applied) * 100)) : 0,
    messageCount: h.replied.length,
    daily: buckets,
    statusCount,
    companies: [...new Set(h.applied.map((a) => a.company).filter(Boolean))].slice(0, 10),
  };
}

module.exports = { STAGES, ensure, addApplied, markStatus, addReplied, addInterview, addReject, stats };
