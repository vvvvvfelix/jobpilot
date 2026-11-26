# 怎么加一个新的招聘网站

目标：新站点只写一个适配器文件，业务层（投递、回复、匹配）一行不用改。

## 0. 先摸清页面

在你自己的浏览器里登录，F12 看三件事：

1. **搜索页**：岗位卡片容器、标题、公司、薪资、地点、详情的 DOM 结构；
2. **投递**：按钮文案、点击后的反馈（弹窗/跳转/置灰），失败时的提示；
3. **消息页**：会话列表项、消息气泡（怎么区分"我发的"和"对方发的"）、输入框、发送按钮，以及有没有"同意发简历"这类系统按钮。

把关键选择器记下来，最好每个节点准备 2 个候选（防止 A/B 结构）。

## 1. 建适配器

复制 `src/engine/sites/zhaopin.js` 作为模板，实现下面这些方法（返回结构保持一致）：

```js
module.exports = {
  id: 'newsite',
  label: '新站点',
  match(url) { return /newsite\.com/.test(url); },

  selectors: {
    jobCard: ['.job-card', '.position-item'],
    jobTitle: ['.job-title', 'h3'],
    threadItem: ['.session-item', '.chat-list-item'],
    sendButton: ['.send-btn', 'button[type=submit]'],
    agreeButton: ['.agree-btn'],
  },

  async ensureLogin(wc) { /* 返回 {ok, needManual} */ },
  async searchJobs(wc, query) { /* [{id,title,company,salary,location,tags,url}] */ },
  async readJob(wc, job) { /* 补 job.detail，返回 job */ },
  async apply(wc, job) { /* {ok:boolean, reason:string} */ },
  async listThreads(wc) { /* [{id,title,preview,unread}] */ },
  async readThread(wc, thread) { /* [{isMine:boolean, text:string, ts?:string}] */ },
  async sendReply(wc, thread, text) { /* {ok, reason} */ },
};
```

约定：
- 所有方法都可能失败，失败请**抛出**而不是返回空数组，让上层写日志并降级；
- 不要在这里做频率控制，交给 `guard.js`；
- 不要在适配器里写死"最多投几个"，配额在业务层。

## 2. 注册

`src/engine/sites/index.js`：

```js
const adapters = [require('./zhaopin'), require('./newsite')];
function forUrl(url) { return adapters.find((a) => a.match(url)) || null; }
```

`automation.js` / `scraper.js` 里凡是出现具体选择器的地方，改成先取 adapter，再取 `adapter.selectors.xxx`。

## 3. 自检

给新站点加一个"体检"入口（面板按钮或启动时）：

```js
const report = await adapter.selfCheck(wc); // 每个关键节点是否存在
if (!report.ok) logger.warn('site', '选择器失效', report.missing);
```

失效时把自动动作降级为"只出稿不发送"，别让用户以为发出去了。

## 4. 先跑通这四条最小链路

1. 搜索关键词 → 拿到 ≥10 个岗位卡片；
2. 打开第一个详情 → JD 正文 ≥100 字；
3. 投递一个（可 dry-run）→ 能识别成功/失败；
4. 消息页 → 读到最后 3 条对话 → 发一条测试消息（发给自己小号最好）。

四条都过，再补"同意发简历""未读筛选""翻页"等细节。

## 5. 提交 PR 时带上

- 站点名、页面 URL 形态、登录态要求；
- 选择器清单与自检结果截图（打码个人信息）；
- 你验证过的四条链路结果；
- 已知问题（比如某类岗位卡片结构不同）。

## 常见坑

- **登录态**：Electron 会话是持久的，但站点可能要求短信/扫码，别硬编码自动登录，做成"提示人工接管"。
- **虚拟列表**：会话/岗位列表常常是虚拟滚动，`querySelectorAll` 只能拿到可视区，需要滚动加载。
- **iframe**：部分站点消息页在 iframe 里，`executeJavaScript` 要进 frame。
- **同名按钮**：`button` 文案相同但语义不同，尽量用容器限定 + 文案双重匹配。
- **风控**：新站点第一天就高频操作最容易触发，先用 dry-run 跑两天。

## 现状（2026-11-27）

上面的 `SiteAdapter` 设想已经落地成两个文件：

- `src/engine/sites.js`：一个纯配置的注册表，键是 `zhaopin / job51 / liepin / boss / lagou / generic`。要加新站，先在这里加一条：`hosts` 决定 URL 归属，`searchTpl` 用 `{kw}`、`{city}` 占位，`card/title/salary/company/location/tags` 给选择器数组，`imItem` 给会话列表类名，`apply/chat` 声明该站能不能投递、有没有站内 IM。
- `src/engine/scraperMulti.js`：把配置塞进页面脚本。选择器全部落空时用启发式：卡片按「宽度 > 200、高度 44–460、文本含薪资格式」筛，标题取含岗位关键词的行，公司名按「公司/集团/科技/有限…」后缀找，地点按城市表或标题里的 `[区]` 后缀找。

加一个站的顺序：注册表里加配置 → 用 `node_modules/electron` 开个最小探针页跑 `JOBS(site)` 看前几条字段 → 调 `card/title/company` 三个选择器 → 再补 `imItem` 做消息。51job 实页 20 条字段全对，猎聘 40 条只有个别促销卡混入，拉勾公司名缺失（列表不展示）。
