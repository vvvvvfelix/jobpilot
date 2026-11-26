// 独立学习器：不依赖 Electron / 内嵌浏览器，直接跑在 Node 里
// 用法：
//   node scripts/learn.js            学一条（约 30-90 秒）后退出
//   node scripts/learn-daemon.js     常驻，每 30 分钟学一条
const fs = require('node:fs');
const path = require('node:path');
const idleLearn = require('../src/engine/idleLearn');
const knowledge = require('../src/engine/knowledge');

const ROOT = path.join(__dirname, '..');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function log(...args) {
  console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...args);
}

(async () => {
  const settings = readSettings();
  const res = await idleLearn.tick({ llmCfg: settings.llm, logger: { info: (s, m, d) => log(m, JSON.stringify(d || {})), warn: (s, m, d) => log('WARN', m, JSON.stringify(d || {})) }, minGapMs: Number(process.env.LEARN_MIN_GAP_MS || 0) });
  log('结果', JSON.stringify(res).slice(0, 400));
  const sum = knowledge.summary();
  log('知识库', `共 ${sum.count} 条，最近更新 ${sum.updatedAt || '无'}`);
})();
