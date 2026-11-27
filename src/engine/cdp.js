// 接管本机 Chrome：通过 DevTools 协议（--remote-debugging-port）直接操作已登录的标签页。
// 目的是复用用户自己浏览器里的登录态，不在 Electron 里再登一次。
const DEFAULT_PORT = 9222;

async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
  if (!res || !res.ok) throw new Error(`连不上 Chrome 调试端口 ${port}，确认 Chrome 是用 --remote-debugging-port=${port} 启动的`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url, title: t.title, ws: t.webSocketDebuggerUrl }));
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.url = '';
  }

  async open() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error(`调试连接失败：${e.message || 'unknown'}`)));
      ws.addEventListener('message', (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: bad } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) bad(new Error(msg.error.message || 'CDP error'));
          else ok(msg.result);
        }
      });
      ws.addEventListener('close', () => {
        for (const { reject: bad } of this.pending.values()) bad(new Error('调试连接已断开'));
        this.pending.clear();
      });
    });
    return this;
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('调试连接未建立'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  // 兼容 automation.js 需要的 WebContents 接口
  getURL() {
    return this.url;
  }

  isLoading() {
    return false;
  }

  async executeJavaScript(script) {
    const res = await this.send('Runtime.evaluate', {
      expression: String(script),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || '页面脚本执行失败');
    }
    const v = res.result ? res.result.value : undefined;
    this.url = await this.safeUrl();
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  async safeUrl() {
    try {
      const r = await this.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      return (r.result && r.result.value) || this.url;
    } catch {
      return this.url;
    }
  }

  // 真实鼠标点击：有些页面（BOSS 聊天列表）只认真实输入事件，JS 的 el.click() 不生效
  async clickPoint(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  async loadURL(url) {
    await this.send('Page.enable').catch(() => null);
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => null);
      if (ready && ready.result && ready.result.value === 'complete') break;
    }
    this.url = await this.safeUrl();
    return true;
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
  }
}

// 连到指定标签页；不给 host 就挑第一个非空白页
async function attach({ port = DEFAULT_PORT, host = '', url = '' } = {}) {
  const targets = await listTargets(port);
  if (!targets.length) throw new Error('Chrome 里没有可用的标签页');
  let hit = targets.find((t) => host && t.url.includes(host)) || targets.find((t) => url && t.url.includes(url));
  if (!hit) hit = targets.find((t) => !/^(about|chrome|edge|devtools)/i.test(t.url));
  if (!hit) throw new Error(`没找到匹配的标签页（host=${host || '-'}），当前：${targets.map((t) => t.url).join(' , ')}`);
  const page = new CdpPage(hit.ws);
  await page.open();
  page.url = hit.url;
  return { page, target: hit, all: targets };
}

module.exports = { DEFAULT_PORT, listTargets, attach, CdpPage };
