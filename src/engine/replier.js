const { findTerms } = require('./keywords');

const AI_SMELL = [/非常/g, /十分/g, /期待与您/g, /贵公司/g, /荣幸/g, /进一步沟通/g, /祝好/g, /如有机会/g,
  /赋能/g, /闭环/g, /深耕/g, /深度融合/g, /全方位/g, /助力/g, /协同/g, /致力于/g, /极大/g, /显著/g,
  /您好！/g, /感谢您的关注/g, /打扰了/g];

const OPENERS = ['您好', '你好', 'HR你好'];
const CLOSERS = ['方便的话聊两句？', '有空看下我的简历吗？', '想细聊一下。', ''];

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

function cleanLine(text) {
  let out = String(text || '');
  for (const re of AI_SMELL) out = out.replace(re, '');
  return out.replace(/\s{2,}/g, ' ').replace(/！{2,}/g, '！').trim();
}

function buildFacts(resume, job, requirement) {
  const resumeText = `${resume.raw || ''}\n${resume.optimized || ''}`;
  const jobText = `${job?.title || ''} ${(job?.tags || []).join?.(' ') || job?.tags || ''}`;
  const shared = findTerms(jobText).filter((t) => resumeText.includes(t));
  const skill = shared[0] || findTerms(jobText)[0] || resume.skills?.[0] || '嵌入式';
  const number = (resumeText.match(/[\d.]+\s*(年|款|台|个|%|％|人|路|套|次)/) || [])[0] || `${resume.years || 3} 年`;
  const city = requirement?.city || resume.city || '';
  return { skill, number, city, name: resume.name || '', company: job?.company || '', title: job?.title || '' };
}

function generateReplies({ job, resume, requirement, hrMessage, count = 3 }) {
  const facts = buildFacts(resume, job, requirement);
  const seedBase = hash(`${facts.company}${facts.title}${hrMessage || ''}`);
  const drafts = [];

  for (let i = 0; i < count; i += 1) {
    const seed = seedBase + i * 7;
    const opener = pick(OPENERS, seed);
    const namePart = facts.name ? `我是${facts.name}` : '我';
    const variants = [
      `${opener}，${namePart}，${facts.number}做${facts.skill}。看到${facts.company ? facts.company + '的' : ''}这个岗位方向比较对口，简历发您看看？`,
      `${opener}，${facts.skill}方向，做过相关项目${facts.number}，手上能直接上手调试。这个岗位现在还在招吗？`,
      `${opener}，我在找${facts.city || ''}的${facts.skill}岗，${facts.title || '这个职位'}跟我之前的活儿基本一条线。想了解一下团队几个人、主要做什么产品？`,
    ];
    drafts.push(cleanLine(variants[i % variants.length]));
  }

  // 简单的"像不像AI"体检
  const checks = drafts.map((text) => ({
    text,
    length: text.length,
    tooLong: text.length > 90,
    aiSmell: AI_SMELL.some((re) => re.test(text)),
    exclamations: (text.match(/！/g) || []).length,
  }));

  return { drafts: checks, facts };
}

module.exports = { generateReplies, cleanLine };
