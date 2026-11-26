// 把智联在线简历（或导入的简历文本）解析成结构化对象，供版本库、打分、ATS 使用。
const SECTION_ALIASES = {
  个人优势: 'summary',
  求职状态: 'status',
  求职意向: 'intent',
  '工作／实习经历': 'experience',
  工作经历: 'experience',
  教育经历: 'education',
  项目经历: 'projects',
  培训经历: 'training',
  语言能力: 'languages',
  专业技能: 'skills',
  获得证书: 'certificates',
  证书: 'certificates',
  附件: 'attachments',
};

const DEGREES = ['博士', '硕士', '本科', '大专', '中专', '高中'];
const DATE_RANGE = /^(\d{4})\.(\d{1,2})\s*[-–—]\s*(至今|(\d{4})\.(\d{1,2}))$/;
const BULLET = /^(\d+[.、]\s*|・|·|•)\s*/;

function norm(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function monthIndex(y, m) {
  return Number(y) * 12 + Number(m) - 1;
}

function parseRange(text) {
  const m = DATE_RANGE.exec(norm(text));
  if (!m) return null;
  const start = monthIndex(m[1], m[2]);
  const end = m[3] === '至今' ? Infinity : monthIndex(m[4], m[5]);
  return { start, end, startText: `${m[1]}.${m[2]}`, endText: m[3] === '至今' ? '至今' : `${m[4]}.${m[5]}`, months: end === Infinity ? null : end - start + 1 };
}

function findSection(lines) {
  const out = {};
  let current = null;
  for (const line of lines) {
    const plain = norm(line).replace(/\s*必填$/, '');
    const key = SECTION_ALIASES[plain];
    if (key) {
      current = key;
      if (!out[current]) out[current] = [];
      continue;
    }
    if (current) out[current].push(line);
  }
  return out;
}

function parseExperiences(lines) {
  const items = [];
  let cur = null;
  let expectTitle = false;
  let expectSkills = false;
  const push = () => { if (cur && cur.company) items.push(cur); cur = null; };

  for (const raw of lines) {
    const line = norm(raw);
    if (!line) continue;

    if (/^职位类别[:：]/.test(line)) { if (cur) cur.category = line.replace(/^职位类别[:：]\s*/, ''); continue; }
    if (/^所属行业[:：]/.test(line)) { if (cur) cur.industry = line.replace(/^所属行业[:：]\s*/, ''); continue; }
    if (/^拥有技能[:：]/.test(line)) {
      const inline = line.replace(/^拥有技能[:：]/, '').trim();
      if (inline) { if (cur) cur.skills = inline.split(/[/、,，\s]+/).filter(Boolean); }
      else expectSkills = true;
      continue;
    }
    if (expectSkills) {
      if (cur) cur.skills = line.split(/[/、,，\s]+/).filter(Boolean);
      expectSkills = false;
      continue;
    }
    if (expectTitle) {
      if (cur) cur.title = line;
      expectTitle = false;
      continue;
    }
    const range = parseRange(line);
    if (range && cur && !cur.dates) {
      cur.dates = line;
      cur.range = range;
      expectTitle = true;
      continue;
    }
    if (BULLET.test(line)) {
      if (cur) { cur.bullets = cur.bullets || []; cur.bullets.push(line.replace(BULLET, '').trim()); }
      continue;
    }
    // 「| 7200元/月」这种被换行拆开的薪资后缀，接回职位名
    if (/^\|/.test(line) || /^[\d.]+\s*[-~]\s*[\d.]+\s*[kK千万]?元?\s*\/?\s*月?$/.test(line)) {
      if (cur) cur.title = `${cur.title || ''} ${line.replace(/^\|\s*/, '')}`.trim();
      continue;
    }
    // 走到这里：公司名开头。上一段已收尾就落库
    if (cur && (cur.dates || (cur.bullets || []).length)) push();
    cur = { company: line, bullets: [], skills: [] };
  }
  push();

  return items.map((it) => ({
    company: it.company,
    title: it.title || '',
    category: it.category || '',
    industry: it.industry || '',
    skills: it.skills || [],
    dates: it.dates || '',
    startText: it.range?.startText || '',
    endText: it.range?.endText || '',
    months: it.range?.months ?? null,
    start: it.range?.start ?? null,
    end: it.range?.end ?? null,
    bullets: it.bullets || [],
  }));
}

function parseEducation(lines) {
  const out = [];
  for (const raw of lines) {
    const line = norm(raw);
    if (!line) continue;
    const degree = DEGREES.find((d) => line.includes(d));
    const dates = line.match(/(\d{4}\.\d{1,2})\s*[-–]\s*(\d{4}\.\d{1,2})/);
    if (!degree) continue;
    const school = line.split(/\s+/)[0];
    out.push({ school, degree, raw: line, startText: dates?.[1] || '', endText: dates?.[2] || '' });
  }
  return out;
}

function parseProjects(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = norm(raw);
    if (!line) continue;
    const range = parseRange(line);
    const nextIsRange = false;
    if (range && cur && !cur.dates) { cur.dates = line; continue; }
    if (/^项目描述/.test(line)) { if (cur) cur.description = (cur.description || '') + line.replace(/^项目描述[:：]?/, ''); continue; }
    if (cur && (BULLET.test(line) || line.length > 60)) {
      cur.points = cur.points || [];
      cur.points.push(line.replace(BULLET, '').trim());
      continue;
    }
    // 形如「项目名 ｜ 公司 ｜ 角色」或「项目名(公司 | 角色)」或纯项目名
    const looksNew = line.includes('｜') || !cur || cur.points?.length || (cur && cur.dates);
    if (looksNew) {
      if (cur) out.push(cur);
      const parts = line.split('｜').map((s) => s.trim());
      cur = { name: parts[0] || line, company: parts[1] || '', role: parts[2] || '', points: [], dates: '', description: '' };
      continue;
    }
    cur.description = [cur.description, line].filter(Boolean).join(' ');
  }
  if (cur) out.push(cur);
  return out
    .filter((p) => p.name && !/^(其他项目|项目经历|项目描述)$/.test(p.name))
    .map((p) => ({ ...p, text: [p.name, p.role, p.description, ...(p.points || [])].join(' ') }));
}

function parseResume(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const lines = text.split('\n').map(norm);
  const sections = findSection(lines);
  const expLines = sections.experience || [];
  const experiences = parseExperiences(expLines);
  const education = parseEducation(sections.education || []);
  const projects = parseProjects(sections.projects || []);

  const head = [];
  for (const line of lines) {
    if (!line) continue;
    if (Object.keys(SECTION_ALIASES).some((k) => norm(line).replace(/\s*必填$/, '') === k)) break;
    head.push(line);
  }
  const meta = head.find((l) => /岁|工作\s*\d+\s*年|男|女/.test(l)) || '';
  const yearsInMeta = /工作\s*(\d+)\s*年/.exec(meta);
  const phone = head.find((l) => /^\d{3,4}\*+\d{3,4}$|^1\d{10}$/.test(l)) || '';
  const email = head.find((l) => /@/.test(l)) || '';
  const ageMatch = /(\d{2})\s*岁/.exec(meta);
  const cityMatch = /(广州|深圳|上海|北京|杭州|成都|武汉|南京|苏州|东莞|佛山)/.exec(meta);

  const intentLines = (sections.intent || []).map(norm).filter(Boolean);
  const salaryLine = intentLines.find((l) => /\d+\s*[-~]\s*\d+\s*(元|万)/.test(l)) || '';
  const intentTitle = intentLines.find((l) => l.length >= 2 && l.length <= 12 && !/元|万|（|不限行业|期望|全职|兼职/.test(l)) || '';
  const intentCity = (/(广州|深圳|上海|北京|杭州|成都|武汉|南京|苏州|东莞|佛山)/.exec(intentLines.join(' ')) || [])[1] || '';

  const projectsText = projects.map((p) => p.text).join(' ');
  const industries = [...new Set(experiences.map((e) => e.industry).filter(Boolean))];
  const skills = [...new Set(experiences.flatMap((e) => e.skills || []))];
  const certLines = (sections.certificates || []).map(norm).filter(Boolean);
  const cut = certLines.findIndex((l) => /个人作品|简历管理|添加附件|^附件$|^上传新附件$|招聘方/.test(l));
  const certificates = (cut >= 0 ? certLines.slice(0, cut) : certLines).filter((l) => l.length <= 20);

  const totalYears = yearsInMeta
    ? Number(yearsInMeta[1])
    : Math.round(
        experiences.reduce((sum, e) => {
          if (e.months) return sum + e.months;
          if (e.start != null) return sum + 12;
          return sum;
        }, 0) / 12,
      );

  return {
    name: head[0] || '',
    meta,
    age: ageMatch ? Number(ageMatch[1]) : null,
    city: cityMatch ? cityMatch[1] : intentCity,
    phone,
    email,
    summary: (sections.summary || []).map(norm).filter(Boolean).join(' '),
    status: (sections.status || []).map(norm).filter(Boolean)[0] || '',
    intent: {
      title: intentTitle,
      salary: salaryLine,
      city: intentCity,
      industry: intentLines.find((l) => /行业/.test(l)) || '',
    },
    experiences,
    education,
    projects,
    projectsText,
    industries,
    skills,
    certificates,
    totalYears,
    educationLevel: education[0]?.degree || (DEGREES.find((d) => text.includes(d)) || ''),
  };
}

module.exports = { parseResume, norm, parseRange, DEGREES };
