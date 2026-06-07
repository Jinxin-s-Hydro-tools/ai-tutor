# hydro-ai-tutor

`hydro-ai-tutor` 是一个给 HydroOJ 用的「AI 刷题教练」插件。

它会在评测详情页增加一个 **AI 刷题建议** 按钮。学生提交代码后，如果老师已经为这个学生开启 AI 功能，学生就可以让 AI 看题面、代码和评测结果，然后得到一段启发式建议。

这个插件的目标不是让 AI 直接讲题解、直接给代码，而是像助教一样提醒学生：

- 你可能卡在了哪里；
- 哪个变量、输入、边界或思路需要再检查；
- 下一步可以怎么自己试；
- 为什么这次评测结果可能不对。

内置提示词默认面向 10-12 岁的小学生，会尽量使用生活化比喻，并且明确要求 AI **不输出完整代码**、**不直接报算法名**、**不把题做完**。

---

## 主要功能

### 学生侧

- 在评测详情页显示 **AI 刷题建议** 按钮。
- 进入 AI 分析页后，学生需要先选择自己最想解决的卡点。
- 学生还要写一段不少于 10 个字的补充说明，避免什么都没想就直接问 AI。
- AI 回复会实时流式显示，不用等整段生成完。
- 看完建议后，学生可以写一段反思，AI 会再给一次免费的跟进回复。
- 学生可以在 `/ai-tutor/credits` 查看自己的 AI 积分明细。

### 老师侧

入口在 **域管理 → AI 刷题管理**。

老师可以：

- 为当前域配置 AI 提供方、模型和 API Key；
- 按学生开启或关闭 AI 功能；
- 查看学生本月调用次数、积分余额和最后使用时间；
- 给单个学生追加本月可用次数；
- 批量调整学生的积分或可用上限；
- 查看域内 AI 使用记录。

### 系统侧

- 每次 AI 分析消耗 1 积分。
- 每周自动给已开启 AI 的学生发放 5 积分。
- 学生每道题首次 AC 会奖励积分，默认 1 分。
- 积分 30 天有效，过期自动清理。
- 每个学生还有月度调用上限，默认每月 30 次。
- 同一道题默认至少提交 2 次后才能问 AI。
- AI 调用失败或中断时，会尽量退回已扣积分。

---

## 使用流程

### 1. 管理员安装插件

在 HydroOJ 实例中注册插件路径：

```bash
hydrooj addon add /root/.hydro/addons/ai-tutor
pm2 restart hydrooj
```

也可以直接把插件路径写入 `/root/.hydro/addon.json`，然后重启 `hydrooj`。

### 2. 域管理员配置 AI 接口

登录后进入：

```text
域管理 → AI 刷题管理
```

在页面顶部选择 AI 提供方，并填写 API Key。

插件支持 DeepSeek、OpenAI、通义千问、Kimi、GLM、豆包，以及任意 OpenAI 兼容接口。

如果选择「自定义」，需要同时填写：

- Base URL
- 模型名称
- API Key

### 3. 老师给学生开启 AI

仍然在 **域管理 → AI 刷题管理** 页面中，找到学生并打开 AI 开关。

只有被开启的学生才能看到并使用 AI 刷题建议。

### 4. 学生提交代码后使用 AI

学生进入某条提交记录详情页，如果满足条件，就会在代码区域旁边看到 **AI 刷题建议** 按钮。

需要同时满足：

- 老师已为该学生开启 AI；
- 当前提交属于可分析的编程题；
- 学生有足够积分；
- 本月调用次数没有超过上限；
- 同一道题提交次数达到系统设置的门槛。

---

## 常用配置

这些配置在 **控制面板 → 系统设置** 中调整。

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `ai-tutor.creditsPerFirstAc` | `1` | 每道题首次 AC 奖励多少积分，设为 `0` 可关闭奖励 |
| `ai-tutor.monthlyQuota` | `30` | 每个学生每月最多调用 AI 的次数 |
| `ai-tutor.minSubmissions` | `2` | 同一道题至少提交几次后才能问 AI |
| `ai-tutor.maxCodeChars` | `3000` | 发给 AI 的代码最大字符数 |
| `ai-tutor.maxProblemChars` | `4000` | 发给 AI 的题面最大字符数 |
| `ai-tutor.temperature` | `0.7` | AI 生成温度 |
| `ai-tutor.maxTokens` | `8192` | 单次最大输出 token 数 |
| `ai-tutor.timeoutMs` | `60000` | 单次请求超时时间，单位毫秒 |
| `ai-tutor.systemPrompt` | 内置提示词 | 控制 AI 教练的说话风格和规则 |

---

## 积分和次数怎么理解

插件同时使用「积分」和「月度上限」两套限制。

积分像余额，每问一次 AI 消耗 1 分。没有积分，就不能调用 AI。

月度上限像防刷限制，即使还有积分，本月次数用完后也不能继续调用。

举个例子：

- 学生有 8 积分，本月已用 30/30 次：不能继续用，因为月度次数满了。
- 学生有 0 积分，本月只用 3/30 次：也不能继续用，因为积分不够。
- 学生有 8 积分，本月已用 3/30 次：可以继续用。

积分来源主要有三种：

- 每周自动发放；
- 首次 AC 奖励；
- 老师手动追加或批量导入。

积分消耗时会优先使用快过期的积分，尽量减少浪费。

---

## 主要页面和路由

| 页面 | 路由 | 说明 |
|---|---|---|
| AI 分析页 | `/record/:rid/ai` | 学生查看或生成 AI 刷题建议 |
| 可用性检查 | `/record/:rid/ai/available` | 前端按钮注入前先检查是否可用 |
| 学生积分明细 | `/ai-tutor/credits` | 学生查看自己的积分变化 |
| 域 AI 管理 | `/domain/ai-tutor` | 老师管理学生开关和 AI 接口配置 |
| 批量调整 | `/domain/ai-tutor/batch` | 老师批量设置积分或上限 |
| 追加次数 | `/domain/ai-tutor/quota` | 老师给单个学生追加本月可用次数 |
| 使用记录 | `/domain/ai-tutor/records` | 老师查看 AI 调用流水 |

---

## 后台脚本

插件注册了几个 Hydro 脚本，适合管理员在后台批量处理。

### 给已开启 AI 的学生发积分

```json
{"domainId":"system","amount":5,"reason":"月初发放 AI 积分"}
```

脚本名：

```text
aiTutorGrantCredits
```

### 重置已开启 AI 学生的本月上限

```json
{"domainId":"system","quota":30}
```

脚本名：

```text
aiTutorWeeklyCreditGrant
```

### 扫描题目并评估难度

```json
{"domainId":"system","limit":50,"overwrite":false,"includeHidden":false,"dryRun":false}
```

脚本名：

```text
aiTutorDifficultyScan
```

这个脚本会调用当前域配置的 AI 接口，为题目写入 1-10 的难度分。首次运行建议先把 `dryRun` 设为 `true` 看输出。

---

## 数据存在哪里

插件使用 MongoDB，主要集合如下：

| 集合 | 用途 |
|---|---|
| `ai.analysis` | 保存某条提交的 AI 分析结果和对话记录 |
| `ai.usage` | 保存每次 AI 调用流水，用于统计月度次数 |
| `ai.credit` | 保存每个学生在每个域的积分余额 |
| `ai.credit_ledger` | 保存积分增减明细 |
| `ai.credit_award` | 记录首次 AC 奖励，避免重复发分 |
| `ai.domain_access` | 保存域内每个学生的 AI 开关和额外配额 |
| `ai.domain_config` | 保存每个域的 AI 提供方、模型和 API Key |
| `ai.credit_adjust` | 保存老师手动调整积分或次数的审计日志 |

---

## 文件结构

```text
ai-tutor/
├── index.ts                       # 插件入口：注册设置、路由、事件、定时任务
├── constants.ts                   # AI 提供方、提示词、集合名等常量
├── credits.ts                     # 积分发放、扣减、退款、过期
├── difficulty.ts                  # 题目难度 AI 扫描脚本
├── utils.ts                       # 通用工具函数
├── types.ts                       # 类型定义
├── handlers.ts                    # Handler 统一导出
├── handlers/
│   ├── suggestion.ts              # AI 分析页和流式生成
│   ├── domain_manage.ts           # 域管理主页
│   ├── domain_batch.ts            # 批量调整
│   ├── domain_quota.ts            # 单用户追加次数
│   ├── admin.ts                   # 使用记录
│   └── credit_detail.ts           # 学生积分明细
├── frontend/
│   └── record_ai_button.page.tsx  # 在评测详情页注入 AI 按钮
├── templates/                     # Nunjucks 页面模板
└── locales/
    └── zh.yaml                    # 中文文案
```

---

## 开发和排查

修改插件代码后重启 HydroOJ：

```bash
pm2 restart hydrooj
```

查看日志：

```bash
pm2 logs hydrooj
```

如果学生看不到按钮，优先检查：

- 学生是否登录；
- 老师是否在当前域给学生开启 AI；
- 当前提交是否是编程题；
- 页面 URL 是否带有正确的 `/d/<domainId>/record/<rid>` 域前缀；
- `/record/:rid/ai/available` 是否返回可用。

如果能打开页面但不能生成，优先检查：

- 当前域是否配置 API Key；
- 自定义提供方是否同时配置了 Base URL 和模型名；
- 学生积分是否足够；
- 本月次数是否已达上限；
- 同一道题提交次数是否达到门槛；
- `pm2 logs hydrooj` 中是否有 AI 接口报错或超时。

---

## 设计原则

这个插件的核心原则是：**AI 只能做教练，不能替学生做题。**

所以默认提示词会尽量让 AI：

- 少讲术语，多讲比喻；
- 少给结论，多问问题；
- 指出关键卡点，而不是罗列所有错误；
- 给修改方向，不给完整代码；
- 鼓励学生继续自己尝试。

