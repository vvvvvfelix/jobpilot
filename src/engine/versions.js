// 简历版本库：核心版 + 垂类版 + 兜底版（5+2 模型的本地简化实现，不依赖向量/LLM）
const { checkAts } = require('./ats');
const { jobKeywords, jobSkills } = require('./score');
const { norm } = require('./parse');

function tokenCount(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    for (const kw of jobKeywords(job)) {
      const k = norm(kw);
      if (k.length < 2) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const NOISE_TAG = /^(招聘|急招|双休|本科|大专|硕士|博士|中专|应届|广州|深圳|上海|北京|杭州|成都|武汉|南京|苏州|东莞|佛山|广东|全国|元|话补|餐补|房补|交通补助|五险|一金|提成|奖金|住宿|体检|补贴)$/;
const ROLE_SUFFIX = /(经理|主管|专员|工程师|总监|助理|顾问|代表)$/;

function clusterTags(jobs, limit = 8) {
  const counts = new Map();
  for (const job of jobs) {
    const seen = new Set();
    for (const kw of jobKeywords(job)) {
      for (const part of String(kw).split(/[\/、,，()（）|]+/)) {
        const k = norm(part).replace(ROLE_SUFFIX, '');
        if (k.length < 2 || NOISE_TAG.test(k) || /^\d/.test(k) || /补贴|补助|福利|假期|保险|公积金|奖金|提成/.test(k)) continue;
        seen.add(k);
      }
    }
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

function relevance(text, tags) {
  const t = norm(text).toLowerCase();
  return tags.reduce((n, tag) => n + (t.includes(norm(tag).toLowerCase()) ? 1 : 0), 0);
}

function orderBullets(experiences, tags) {
  return (experiences || []).map((e) => {
    const bullets = [...(e.bullets || [])];
    bullets.sort((a, b) => relevance(b, tags) - relevance(a, tags));
    return { ...e, bullets };
  });
}

function selectProjects(projects, tags, keep = 4) {
  return [...(projects || [])]
    .map((p) => ({ ...p, rel: relevance(p.text, tags) }))
    .sort((a, b) => b.rel - a.rel)
    .slice(0, keep);
}

function summarize(parsed, tags) {
  const rawSummary = String(parsed.summary || '').trim();
  const cut = rawSummary.length > 160 ? `${rawSummary.slice(0, 160)}…` : rawSummary;
  const skillLine = (parsed.skills || []).slice(0, 8).join('、');
  return [cut, tags.length ? `匹配方向：${tags.join('、')}` : '', skillLine ? `常用技能：${skillLine}` : ''].filter(Boolean).join('\n');
}

function idOf(prefix, tags) {
  const key = (tags[0] || 'general').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  return `v_${key || 'general'}_${prefix}`;
}

function buildVersion({ kind, label, tags, parsed, raw, jdKeywords, projectsKeep }) {
  const skills = [...(parsed.skills || [])].sort((a, b) => relevance(b, tags) - relevance(a, tags));
  const experiences = orderBullets(parsed.experiences, tags);
  const projects = selectProjects(parsed.projects, tags, projectsKeep);
  const kw = tags.length ? [...new Set([...tags, ...jdKeywords])].slice(0, 10) : jdKeywords;
  const ats = checkAts(raw, parsed, kw.length ? kw : tags);
  return {
    id: idOf(kind, tags),
    label,
    kind,
    targetTags: tags,
    summary: summarize(parsed, tags),
    skills,
    experienceCount: experiences.length,
    experiences: experiences.map((e) => ({ company: e.company, title: e.title, dates: e.dates, bullets: e.bullets.length })),
    projects: projects.map((p) => ({ name: p.name, rel: p.rel })),
    atsScore: ats.score,
    keywordCoverage: ats.keywords.coverage,
    missingKeywords: ats.keywords.missing,
    atsDetail: ats,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    diff: [
      `技能按匹配度重排（${tags[0] || '通用'}优先）`,
      `经历要点按关键词相关度重排，条数不删（${experiences.reduce((n, e) => n + e.bullets.length, 0)} 条）`,
      `项目保留 ${projects.length} 个最相关（原 ${(parsed.projects || []).length} 个）`,
    ],
  };
}

function buildVersions({ parsed, raw, requirement, jobs }) {
  const tags = clusterTags(jobs, 8);
  const coreTags = tags.slice(0, 3);
  const specialTags = tags.filter((t) => !coreTags.includes(t)).slice(0, 4);
  const jdKeywords = [...new Set([...tags, ...jobs.flatMap((j) => jobSkills(j)).map(norm)])]
    .filter((k) => k.length >= 2 && !/广州|深圳|驻地|广东|全国/.test(k))
    .slice(0, 12);

  const out = [];
  out.push(buildVersion({ kind: 'core', label: `核心版 · ${coreTags[0] || '主赛道'}`, tags: coreTags, parsed, raw, jdKeywords, projectsKeep: 6 }));
  if (specialTags.length) {
    out.push(buildVersion({ kind: 'special', label: `垂类版 · ${specialTags[0]}`, tags: specialTags, parsed, raw, jdKeywords, projectsKeep: 4 }));
  }
  out.push(buildVersion({ kind: 'general', label: '兜底版 · 通用', tags: [], parsed, raw, jdKeywords, projectsKeep: 3 }));
  return out;
}

module.exports = { buildVersions, clusterTags, relevance, orderBullets, selectProjects };
