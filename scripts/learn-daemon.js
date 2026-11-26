// 常驻学习进程：每 30 分钟学一条，写完直接落盘，Electron 那边只读 knowledge.json
const fs = require('node:fs');
const path = require('node:path');
const idleLearn = require('../src/engine/idleLearn');

const ROOT = path.join(__dirname, '..');
const GAP_MS = Number(process.env.LEARN_GAP_MS || 30 * 60 * 1000);

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

async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const settings = readSettings();
    try {
      const res = await idleLearn.tick({
        llmCfg: settings.llm,
        logger: { info: (s, m, d) => log(m, JSON.stringify(d || {})), warn: (s, m, d) => log('WARN', m, JSON.stringify(d || {})) },
        minGapMs: 0,
      });
      log('本轮', JSON.stringify(res).slice(0, 200));
    } catch (e) {
      log('异常', String(e.message).slice(0, 120));
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
}

loop();
