const fs = require('node:fs');
const path = require('node:path');

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.defaults = {
      settings: {
        homeUrl: 'https://www.zhaopin.com/',
        messageUrl: 'https://i.zhaopin.com/im',
        resumeUrl: 'https://i.zhaopin.com/resume',
        searchUrlTemplate: 'https://www.zhaopin.com/jobs/?jl=763&kw={kw}',
        logDir: 'F:\\ZhaopinAssistant\\logs',
        logRetentionDays: 30,
        autoReplyOnOpen: true,
        confirmBeforeApply: true,
        maxApplyPerRun: 10,
        dailyCap: 40,
        blacklist: '',
        excludeHeadhunter: true,
        applyIntervalMs: 12000,
        maxRepliesPerRun: 5,
        confirmBeforeSend: true,
        llm: {
          enabled: true,
          provider: 'pollinations',
          baseUrl: 'https://text.pollinations.ai/openai',
          model: 'openai',
          apiKey: '',
          temperature: 0.4,
          timeoutMs: 60000,
        },
        weights: { skill: 0.3, experience: 0.2, keyword: 0.15, project: 0.2, education: 0.1, salary: 0.05 },
        hardGate: false,
        atsThreshold: 0.85,
        maxVersions: 10,
        autoThreshold: 55,
        autoApplyMax: 5,
        autoReplyMax: 5,
        autoReplySend: false,
        msgPerHour: 8,
        msgDailyCap: 30,
        applyPerHour: 6,
        msgIntervalMs: 6000,
      },
      versionLib: { versions: [], activeId: '', updatedAt: 0 },
      handoff: [],
      resume: {
        name: '示例姓名',
        title: '嵌入式开发工程师',
        years: 3,
        education: '本科',
        city: '广州',
        raw: '',
        optimized: '',
        skills: [],
        matches: [],
      },
      requirement: {
        text: '广州 嵌入式开发 本科 3-5年 C语言 C++ STM32 MCU RTOS Linux 驱动',
        city: '广州',
        salaryMin: 0,
      },
      history: { applied: [], replied: [] },
    };
  }

  file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  get(name) {
    const file = this.file(name);
    const base = JSON.parse(JSON.stringify(this.defaults[name] ?? {}));
    if (!fs.existsSync(file)) return base;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return deepMerge(base, data);
    } catch {
      return base;
    }
  }

  set(name, value) {
    fs.writeFileSync(this.file(name), JSON.stringify(value, null, 2), 'utf8');
    return value;
  }

  patch(name, partial) {
    const merged = deepMerge(this.get(name), partial);
    return this.set(name, merged);
  }
}

module.exports = { Store };
