const fs = require('node:fs');
const path = require('node:path');

function safeJson(value, max = 800) {
  if (value === undefined || value === null) return '';
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

class Logger {
  constructor(logDir) {
    this.dir = logDir;
    this.ensureDir();
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'runs'), { recursive: true });
  }

  dateKey() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  write(level, scope, message, data) {
    try {
      this.ensureDir();
      const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message} ${safeJson(data)}`.trim();
      fs.appendFileSync(path.join(this.dir, `app-${this.dateKey()}.log`), `${line}\n`, 'utf8');
      fs.appendFileSync(
        path.join(this.dir, `events-${this.dateKey()}.jsonl`),
        `${JSON.stringify({ ts: Date.now(), level, scope, message, data: data ?? null })}\n`,
        'utf8',
      );
    } catch (err) {
      // 日志本身失败时不能影响主流程
      console.error('logger write failed', err.message);
    }
  }

  info(scope, message, data) { this.write('INFO', scope, message, data); }
  warn(scope, message, data) { this.write('WARN', scope, message, data); }
  error(scope, message, data) { this.write('ERROR', scope, message, data); }

  startRun(name, meta) {
    const self = this;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runId = `${stamp}_${name}`;
    const file = path.join(this.dir, 'runs', `${runId}.json`);
    const run = { runId, name, startedAt: new Date().toISOString(), meta: meta ?? null, steps: [] };
    this.saveRun(file, run);
    self.info('run', `开始 ${name}`, { runId });
    return {
      runId,
      add(step, data) {
        run.steps.push({ ts: new Date().toISOString(), step, data: data ?? null });
        self.saveRun(file, run);
        return run;
      },
      finish(result) {
        run.finishedAt = new Date().toISOString();
        run.result = result ?? null;
        self.saveRun(file, run);
        self.info('run', `结束 ${name}`, { runId, result });
      },
      save: () => self.saveRun(file, run),
      file,
      data: run,
    };
  }

  saveRun(file, run) {
    try {
      fs.writeFileSync(file, JSON.stringify(run, null, 2), 'utf8');
    } catch (err) {
      console.error('save run failed', err.message);
    }
  }

  // 日志只保留最近 days 天：app-*.log、events-*.jsonl、runs/*.json
  cleanup(days = 30) {
    const cutoff = Date.now() - Math.max(1, days) * 24 * 3600 * 1000;
    let removed = 0;
    const sweep = (dir, filter) => {
      try {
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          if (!filter(name)) continue;
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(file);
            removed += 1;
          }
        }
      } catch {
        // 清理失败不影响主流程
      }
    };
    sweep(this.dir, (n) => /^(app|events)-.*\.(log|jsonl)$/.test(n));
    sweep(path.join(this.dir, 'runs'), (n) => n.endsWith('.json'));
    if (removed) this.info('log', '清理过期日志', { removed, days });
    return removed;
  }

  tail(lines = 200) {
    try {
      const file = path.join(this.dir, `app-${this.dateKey()}.log`);
      if (!fs.existsSync(file)) return '';
      const text = fs.readFileSync(file, 'utf8').split('\n');
      return text.slice(-lines).join('\n');
    } catch {
      return '';
    }
  }
}

module.exports = { Logger };
