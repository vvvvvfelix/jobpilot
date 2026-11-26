// 统一的模型接入层：所有 AI 能力（改简历、写回复、意图分析）都走这里。
// 默认支持三种：本机/局域网 Ollama（免费）、Pollinations（免费、无需 key）、任意 OpenAI 兼容接口（填 key）。
const PRESETS = {
  freellmapi: { label: '局域网 FreeLLMAPI', baseUrl: 'http://127.0.0.1:18902/v1', model: 'llama-3.3-70b', needsKey: true },
  ofm: { label: '局域网 OFM 免费', baseUrl: 'http://127.0.0.1:18901/v1', model: 'combo:auto-failover', needsKey: true, apiKey: 'YOUR_OFM_KEY' },
  g4f: { label: '局域网 g4f 免费', baseUrl: 'http://127.0.0.1:1337/v1', model: 'auto', needsKey: false },
  local: { label: '局域网 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b', needsKey: false },
  pollinations: { label: 'Pollinations 免费', baseUrl: 'https://text.pollinations.ai/openai', model: 'openai', needsKey: false },
  custom: { label: '自定义 OpenAI 兼容', baseUrl: '', model: '', needsKey: false },
};

// 主模型挂了按顺序退，保证业务不断
const FALLBACK_ORDER = ['g4f', 'pollinations'];

function pick(cfg = {}) {
  const provider = cfg.provider || 'pollinations';
  const preset = PRESETS[provider] || PRESETS.custom;
  return {
    provider,
    baseUrl: (cfg.baseUrl || preset.baseUrl || '').trim(),
    model: (cfg.model || preset.model || '').trim(),
    apiKey: cfg.apiKey || '',
    temperature: Number.isFinite(cfg.temperature) ? cfg.temperature : 0.4,
    maxTokens: cfg.maxTokens || 700,
    timeoutMs: cfg.timeoutMs || 60000,
  };
}

function ready(cfg = {}) {
  const c = pick(cfg);
  return Boolean(cfg.enabled && c.baseUrl && c.model);
}

async function doChat(cfg, messages, options = {}) {
  const c = pick(cfg);
  if (!c.baseUrl) throw new Error('没有配置模型地址');
  // 免费接口有节奏限制：Pollinations 每个 IP 45 秒只允许 1 次，排队等
  const gap = c.provider === 'pollinations' ? 46000 : 0;
  if (gap && Date.now() < state.lastAt + gap) {
    await new Promise((r) => setTimeout(r, state.lastAt + gap - Date.now()));
  }
  state.lastAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || c.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
    const res = await fetch(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: c.model,
        temperature: options.temperature ?? c.temperature,
        max_tokens: options.maxTokens || c.maxTokens,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`模型接口 ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型没有返回内容');
    return String(content).trim();
  } finally {
    clearTimeout(timer);
  }
}

const state = { lastAt: 0 };
let chain = Promise.resolve();

// 所有调用串行排队，避免免费接口被并发打爆
function chat(cfg = {}, messages = [], options = {}) {
  const run = chain.then(async () => {
    const attempts = [cfg];
    if (cfg.provider !== 'pollinations' && cfg.fallback !== false) {
      for (const p of FALLBACK_ORDER) {
        if (p === cfg.provider) continue;
        const preset = PRESETS[p];
        attempts.push({
          enabled: true,
          provider: p,
          baseUrl: cfg.fallbackBaseUrl?.[p] || preset.baseUrl,
          model: preset.model,
          maxTokens: cfg.maxTokens,
          timeoutMs: cfg.timeoutMs || 60000,
        });
      }
    }
    let lastErr = null;
    for (const a of attempts) {
      try {
        return await doChat({ ...a, fallback: false }, messages, options);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('模型都不可用');
  });
  chain = run.catch(() => {});
  return run;
}

// 关键小请求（心理分析、写回复）用：主模型 → 局域网 OFM → g4f，都不走 46 秒冷却的 pollinations
async function chatReliable(cfg = {}, messages = [], options = {}) {
  const attempts = [
    { ...cfg, fallback: false },
    { enabled: true, provider: 'ofm', baseUrl: (cfg.fallbackBaseUrl?.ofm) || PRESETS.ofm.baseUrl, model: (cfg.ofmModel) || PRESETS.ofm.model, apiKey: cfg.ofmKey || PRESETS.ofm.apiKey, fallback: false },
    { enabled: true, provider: 'g4f', baseUrl: (cfg.fallbackBaseUrl?.g4f) || PRESETS.g4f.baseUrl, model: PRESETS.g4f.model, fallback: false },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      return await chat(a, messages, options);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('模型都不可用');
}

async function test(cfg = {}) {
  const started = Date.now();
  const text = await chat(cfg, [{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 20, timeoutMs: 30000 });
  return { ok: true, ms: Date.now() - started, model: pick(cfg).model, baseUrl: pick(cfg).baseUrl, text: text.slice(0, 40) };
}

module.exports = { PRESETS, pick, ready, chat, chatReliable, test };
