# dsh-local-memory

`dsh-local-memory` 负责 DSH 里的社交记忆与会话记忆。它从 SurfCore v0.8.6 的
 `src/memory-card.js`、`src/bili-memory.js`、`src/session-map.js`、
 `src/conversation-closure.js`、`src/slang-learner.js`、`src/history-catchup.js`、
 `src/context-snapshot.js` 以及 QQ 桥接中的会话记忆逻辑移植而来，并改为自己持有配置和状态。

## 范围

包含：

- 记忆卡：清晰度、衰减、容量、置顶、合并、遗忘、初次相遇、归档、备份恢复。
- 会话记忆：会话话题、待说事项、待追问、成员印象、版本冲突检测、整库备份。
- 会话映射去重（`/session/dedupe`）。
- 对话收尾：评估、保存、状态、重开、提示词块与唤醒抑制。
- 黑话学习：条目增删、上下文块、抽取/研究提示词、结果回填。
- 上线补历史：水位线、漏消息选择、摘要。
- 上下文快照：从会话存储构建只读视图。
- QQ 公开消息流同步、B 站公开记忆刷新、B 站简报，以及向 QQ 桥接提供注入上下文。

不包含：

- 人格 / 角色 / 桌宠（`persona`、`role`、`pet`、`character-persona`）不迁移，也不在新代码中引用。
  记忆卡里历史数据的 `pet` / `scope: 'pet'` 只是旧数据标签，用于归档和过滤，不是桌宠模块。
- QQ 账号、B 站登录、消息收发、token 预算/守卫/账本仍由 SurfCore 传输层负责。
- 问答归属（`question-answers.js`）属于 QQ 交互和权限，留在 SurfCore。

## 状态布局

默认根目录来自 `DSH_HOME`，可通过环境变量覆盖：

```text
DSH_HOME/memory/
├── config.json                     # memoryCard / memory / biliSync / ownerAlert / closure / slang / history / archiveOut
├── migration.json                  # 一次性迁移标记、来源路径和 sha256
├── data/
│   ├── memory-card.json|md         # 记忆卡及派生提示词
│   ├── memory-card-prompt-qq.md
│   ├── memory-card-prompt-bili.md
│   ├── memory-card-full.jsonl      # 只追加的全量归档
│   ├── memory-card-full-stats.json
│   ├── archive-outbox/             # 归档投递意图、回执与冲突隔离
│   │   ├── state.json              # 扫描偏移、退避与最近错误
│   │   ├── pending/<archive_id>.json
│   │   ├── conflict/<archive_id>.json
│   │   └── receipts.jsonl          # 已确认的归档回执
│   ├── memory-inbox.jsonl(.N)      # 旧版收件箱，可带数字分卷
│   ├── events.jsonl                # 事件日志
│   ├── events-cursor.json
│   ├── session-memory.json         # 会话记忆整库
│   ├── closures.json
│   ├── slang.json
│   ├── history-watermarks.json
│   ├── bili-memory.json|md
│   └── bili-memory-brief.md
├── inbox/
│   ├── qq-public-feed.jsonl        # SurfCore 写入、插件读取的公开群消息流
│   ├── alignments.json             # 身份对齐
│   └── social-v2.json              # 旧会话记忆来源
├── backups/                        # 记忆卡、B 站分享历史、会话整库等备份
└── runtime.json                    # 插件启动时发布的本机 IPC 地址和令牌（0600）
```

路径可以通过环境变量覆盖，插件只接受绝对路径：

| 变量 | 默认值 |
| --- | --- |
| `DSH_MEMORY_STATE_DIR` | `$DSH_HOME/memory` |
| `DSH_MEMORY_INBOX_DIR` | `$DSH_MEMORY_STATE_DIR/inbox` |
| `DSH_QQ_PUBLIC_FEED` | `$DSH_MEMORY_INBOX_DIR/qq-public-feed.jsonl` |
| `DSH_BILI_DYNAMICS_CACHE` | `$DSH_MEMORY_STATE_DIR/data/bili-dynamics-cache.json` |
| `DSH_ALIGNMENTS_FILE` | `$DSH_MEMORY_INBOX_DIR/alignments.json` |
| `DSH_SESSION_LEGACY_FILE` | `$DSH_MEMORY_INBOX_DIR/social-v2.json` |
| `SURFCORE_CONFIG_FILE` | `$DSH_HOME/surfcore/config.json`（只读 QQ 桥接配置） |
| `SURFCORE_CONSOLE_TOKEN_FILE` | `$DSH_HOME/surfcore/state/console-token`（只读） |

`DSH_HOME` 必须是绝对路径；缺失或状态目录不可写时插件启动失败，不会回退到 SurfCore 目录。
插件不写 `plugins/surfcore/`，公开消息流由传输层写入、记忆插件读取。

## 配置

`config.json` 按段保存，写入使用同目录临时文件 + rename：

- `memoryCard`：容量、衰减、清晰度、注入预算、整理时间、管理员告警等。
- `cardInjection`：常驻记忆卡注入（默认关闭）。`enabled` 开关；`platform` 取 `qq`/`bili`（默认 `qq`，即面向主人的那份）；`excludePresets` 默认 `["dsh-superagent-router"]`；`excludeSubagents` 默认 `true`。
- `memory`：会话记忆与成员印象相关参数。
- `biliSync`：B 站公开记忆定期刷新开关和间隔（默认关闭）。
- `ownerAlert`：管理员私聊容量告警（默认关闭）。
- `closure`：对话收尾开关、阈值、冷却和重开策略。
- `slang`：黑话开关、条目上限、注入上限。
- `history`：补历史开关、回看窗口、条数上限。
- `archiveOut`：归档投递（默认开启）。`batchLimit` 50、`batchBytes` 200000、`statusLimit` 200、`baseDelayMs` 60000、`maxDelayMs` 1800000、`maxAttempts` 0（不限次）、`maxPending` 10000；`enabled: false` 只停止投递，不影响本地归档。

`cardInjection.enabled: true` 后，记忆卡会作为常驻 section（`actmem:card`）进所有 agent 的系统提示：
控制面（router preset）与工具型子 agent 除外，执行器（worker）与普通会话都进。内容是面向主人的
那份卡（`platform: qq`），每次装配同步渲染并做**内容 hash** 缓存 —— 卡的写者每轮维护都会无条件
重写文件，缓存判据如果用 mtime，就会每 10 分钟打掉一次 provider 的前缀缓存。改配置后重启 DSH 生效。

损坏的 JSON 不会被静默当成空配置：读取会报错并保留原文件。设置写入与提示词文件生成之间有恢复记录，
中断后下一次读取会先恢复输出。

## HTTP 面板 API

前缀 `/dsh-memory/api`，只接受本机 Host、同源写请求，并经过 DSH `connection` 会话校验。

```text
GET  /card /card/preview /previews /modules /backups
GET  /archive /archive/preview /archive/status /archive/record
GET  /bili/brief /bili/share-history/backups
GET  /qq-sync
POST /qq-sync/settings /qq-sync/run /qq-sync/purge
GET  /closure?key=...
GET  /slang?status=...
GET  /history?key=...
GET  /sessions /session?key=... /session/backups /session/database-backups
POST /settings /sync-settings /owner-alert /owner-alert/check
POST /card (记忆卡操作) /restore
POST /bili/refresh /bili/share-history/restore
POST /session /session/restore /session/database-restore /session/dedupe
POST /settings/module /closure/assess /closure/save /closure/reopen
POST /slang/upsert /slang/delete /slang/apply-extraction /slang/apply-research
GET  /actmem/status; POST /actmem/add /actmem/update
POST /history/catchup /context/snapshot
```

写接口要求 `content-type: application/json`，请求体上限 512 KiB。

## 面板

面板按「概览 / 记忆卡 / 设置」三个标签组织，会话、同步与备份收在设置页。

概览只读展示记忆状态、归档出站、最近记忆与隐私边界。归档出站来自 `snapshot.archiveOut`，显示待投递、冲突、已确认、无效的数量和最近错误；它不提供全量归档浏览、归档搜索或归档容量上限设置。面板不再调用 `/archive`、`/archive/preview`、`/archive/status` 与 `/archive/record`，这些只读端点保留给本机兼容调用；归档投递仍由内部 ArchiveIntent/回执流程处理。

设置页的数值项只保留衰减卡字数/记录上限、管理员保护阈值、全量卡大小上限与注入/遗忘周期；`fullMaxRecords`、`fullMarkdownMaxBytes` 不再由面板写入。

## 组件内部 API

前缀 `/dsh-memory/internal`，仅回环地址，且要求请求头 `x-component-token` 与
`$DSH_HOME/memory/runtime.json` 中的令牌一致。该接口供 SurfCore 适配层和本地工具调用：

```text
GET  /health
POST /events
POST /session/read /session/write /session/touch-topics /session/dedupe
GET  /context/qq /context/bili /card /modules
GET  /qq-sync/status; POST /qq-sync/run
GET  /bili/brief /bili/status; POST /bili/refresh /bili/record-share
POST /settings/module
POST /closure/assess /closure/gate /closure/save /closure/status /closure/reopen
POST /closure/prompt /closure/suppress
POST /slang/list /slang/upsert /slang/delete /slang/context
POST /slang/extraction-prompt /slang/research-prompt
POST /slang/apply-extraction /slang/apply-research
POST /history/catchup /context/snapshot
GET  /archive-out/status; POST /archive-out/drain
```

`/actmem/add` 与 `/actmem/update` 是同一套手动动作的写入口：`add` 走 `addManualMemory`
（`source: manual`，`scope` 由调用方指定，默认 `qq`），`update` 按 id 与 `expectedRevision` 改写已有记录。
`dsh-actmem-recap` 用 `add` 把归队简报写进衰减卡，并固定 `scope: qq`——
`visibleFor` 会把 `scope === 'qq' && source === 'manual'` 的记录从 B 站上下文里排除。

归档投递从 `memory-card-full.jsonl` 的持久化偏移生成 ArchiveIntent（首次启动从 EOF 开始，不回填存量），先按 `archive_id` 查询归档端状态再补写；回执写入 `archive-outbox/receipts.jsonl` 后才删除意图，冲突项移入 `conflict/` 且不自动重试。未拿到回执前，本地记录不会被报告为已归档。

B 站刷新在内部调用中超时为 10 分钟；其余调用默认 65 秒。插件停用时先拒绝新操作，
再等待已排队写入、B 站发布和卡片导入完成。

## 迁移

`npm run setup:components` 在服务停止时执行一次性迁移：

- 旧记忆卡、收件箱、会话状态、B 站记忆、公开消息流和身份对齐复制到 `memory/`。
- 每个文件先复制到备份目录并校验 sha256，再发布到目标目录。
- 目标目录已存在时整体拒绝，不覆盖；已完成时再次执行只补录旧备份。
- `memory/migration.json` 记录来源、时间和备份路径。缺少标记时才读取旧路径。

## 测试

```sh
node --test tests/memory-*.test.mjs tests/session-memory*.test.mjs tests/component-ipc.test.mjs
```

测试使用隔离状态目录和本地 HTTP/IPC，不访问真实 QQ/B 站，也不修改用户记忆。

## 来源与许可

本仓库原为 `dsh-superagent-template` 工作区中的一个模块，现拆出来独立建仓维护。

- **上游**：
  - [SurfCore](https://github.com/Mieksido/surfcore) v0.8.6 —— `src/memory-card.js`、`src/bili-memory.js`、
    `src/session-map.js`、`src/conversation-closure.js`、`src/slang-learner.js`、`src/history-catchup.js`、
    `src/context-snapshot.js` 的记忆语义
  - QQ 桥接中的会话记忆逻辑
- **原作者**：Derpyu520 and qq-bridge / QSH contributors
- **上游许可**：MIT（版权声明保留在 [LICENSE](LICENSE)）
