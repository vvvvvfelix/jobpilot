# 运行时数据目录

`data/` 是程序自己生成和读写的地方，**不进 Git**。

首次启动会自动创建，结构大致是：

```
data/
  settings.json      配置（模型、阈值、配额、学习节奏）
  resume.json        简历原文 / 优化版
  requirement.json   需求文本 + 解析出的 prefs
  versionLib.json    多版本简历
  memory.json        问题计数、经验、策略版本
  knowledge.json     空闲学习得到的认知
  matchCache.json    岗位精排缓存
  history.json       操作历史
  handoff.json       转人工列表
  backups/           简历写回前备份
```

## 起一份干净的配置

```bash
mkdir data
cp data.example/settings.example.json data/settings.json
```

然后把 `llm.baseUrl / model / apiKey` 换成你自己的 OpenAI 兼容服务。仓库里不含任何密钥，也请不要把带 key 的 `settings.json` 提交上来。
