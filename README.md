# hydro-ai-tutor

HydroOJ 插件——在评测详情页加入 **AI 刷题建议** 功能，为信息学竞赛学员（主要面向小学生）提供启发式、不直接给代码的辅导。

- 基于 OpenAI-兼容接口（DeepSeek、OpenAI、通义千问、Kimi、GLM、豆包等）流式推送建议
- 完整的积分与配额体系：每周自动发放积分、首次 AC 奖励、30 天到期、月度调用上限
- 二轮对话：主分析 + 学生反思后跟进回复
- 所有 AI 配置均在域管理界面完成，无需改配置文件或重启

---

## 功能概览

| 功能 | 说明 |
|---|---|
| **AI 刷题建议按钮** | 在评测详情页注入按钮，点击跳转分析页 |
| **流式输出** | AI 回复实时逐字推送（SSE） |
| **卡点选择 + 补充说明** | 学生先选最想解决的卡点，再写不少于 10 字的说明，帮助 AI 给出针对性指导 |
| **反思对话** | 看完分析后，学生写反思，AI 给出免费的跟进回复 |
| **积分系统** | 每次调用消耗 1 积分；积分 30 天内有效，按 FIFO 顺序消耗 |
| **每周积分发放** | 每周自动向已开通用户发放 5 积分 |
| **首次 AC 奖励** | 每道题首次 AC 奖励积分（默认 1 分，可配置） |
| **月度调用上限** | 硬性上限，超出后本月不能再调用（与积分余额独立计算） |
| **提交门槛** | 同一道题至少提交 N 次后才能调用 AI（默认 2 次） |
| **域级管理** | 老师可按用户开关 AI 功能、查看使用记录、追加配额或积分 |

---

## 安装

```bash
# 1. 注册插件
hydrooj addon add /path/to/hydro-ai-tutor

# 2. 重启以加载插件
pm2 restart hydrooj

# 3. 查看日志确认加载成功
pm2 logs hydrooj
```

插件没有独立的编译步骤，HydroOJ 框架会在加载时自动转译 TypeScript。

---

## 配置 AI 提供方

**API Key 和模型选择均在域管理界面配置，不需要修改任何配置文件。**

1. 以域管理员身份登录
2. 进入 **域管理 → AI 刷题管理**
3. 在页面顶部的"AI 接口配置"表单中选择提供方并填写 API Key
4. 点击保存

配置存储在 MongoDB `ai.domain_config` 集合，每个域独立配置。

### 支持的提供方

| 选项 | 模型 | 接口地址 |
|---|---|---|
| DeepSeek V4 Flash（默认） | `deepseek-v4-flash` | `api.deepseek.com` |
| DeepSeek V4 Pro | `deepseek-v4-pro` | `api.deepseek.com` |
| DeepSeek Reasoner | `deepseek-reasoner` | `api.deepseek.com` |
| OpenAI GPT-4o mini | `gpt-4o-mini` | `api.openai.com/v1` |
| OpenAI GPT-4o | `gpt-4o` | `api.openai.com/v1` |
| 阿里 通义千问 Turbo | `qwen-turbo` | Dashscope 兼容入口 |
| 阿里 通义千问 Plus | `qwen-plus` | Dashscope 兼容入口 |
| Moonshot Kimi | `kimi-latest` | `api.moonshot.cn/v1` |
| 智谱 GLM-4 Flash | `glm-4-flash` | `open.bigmodel.cn` |
| 字节豆包 Pro | `doubao-pro-32k` | 火山方舟 |
| 自定义 | 填写 Base URL + 模型名 | 任意 OpenAI 兼容接口 |

---

## 系统设置

在 **控制面板 → 系统设置** 中可调整以下全局参数：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `ai-tutor.creditsPerFirstAc` | `1` | 每道题首次 AC 奖励积分数；设为 0 关闭奖励 |
| `ai-tutor.monthlyQuota` | `30` | 每用户每月调用上限（月底自动重置） |
| `ai-tutor.minSubmissions` | `2` | 同一道题至少提交 N 次才能调用 AI |
| `ai-tutor.maxCodeChars` | `3000` | 发给 AI 的代码最大字符数（超出截断） |
| `ai-tutor.maxProblemChars` | `4000` | 发给 AI 的题面最大字符数（超出截断） |
| `ai-tutor.temperature` | `0.7` | 采样温度（0–1） |
| `ai-tutor.maxTokens` | `8192` | 单次最大输出 token 数 |
| `ai-tutor.timeoutMs` | `60000` | 单次请求超时（毫秒） |
| `ai-tutor.systemPrompt` | 内置教练提示词 | 可在控制面板覆盖整个 system prompt |

---

## 域级管理

以下操作均需 **PERM_EDIT_DOMAIN** 权限，入口在 **域管理 → AI 刷题管理**。

| 页面 | 路由 | 功能 |
|---|---|---|
| AI 刷题管理 | `/domain/ai-tutor` | 查看/搜索用户列表；开关 AI 权限；配置 API 接口 |
| 批量操作 | `/domain/ai-tutor/batch` | CSV 格式批量导入，调整积分或月度配额 |
| 追加配额 | `/domain/ai-tutor/quota` | 为单个用户追加本月额外可用次数 |
| 使用记录 | `/domain/ai-tutor/records` | 查看所有学生的调用历史 |

学生可在 `/ai-tutor/credits` 查看自己的积分明细和变更历史。

---

## 积分体系

积分是调用 AI 的"货币"，月度调用上限是独立的硬封顶，两者同时满足才能使用。

### 积分来源

| 来源 | 说明 |
|---|---|
| 每周自动发放 | 每周 5 积分，发给所有已开通用户 |
| 首次 AC 奖励 | 每道题首次通过评测奖励（默认 1 分），重复 AC 不重复奖励 |
| 老师手动追加 | 域管理界面或批量操作中直接调整 |

### 积分规则

- 积分自发放起 **30 天有效**，超期自动清零
- 消耗时按 **到期时间最近优先（FIFO）** 顺序扣减
- AI 调用被中断或返回空内容时，**自动退回**已扣积分
- 老师可通过批量操作同时调整积分余额和月度配额

---

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/record/:rid/ai` | 分析页（有缓存直接展示，无则显示"开始分析"） |
| GET | `/record/:rid/ai/available` | 检查当前用户是否可用 AI（前端按钮注入时调用） |
| POST | `/record/:rid/ai` `action=start` | 启动分析，返回 SSE 流 |
| POST | `/record/:rid/ai` `action=clear` | 清除已有分析 |
| POST | `/record/:rid/ai` `action=reflect` | 提交学生反思，返回 SSE 流 |
| POST | `/record/:rid/ai` `action=regenerateReflect` | 重新生成中断的反思回复 |

**访问权限**：提交者本人，或拥有 `PERM_READ_RECORD_CODE` 的管理员。

---

## MongoDB 集合

| 集合 | 用途 |
|---|---|
| `ai.analysis` | 每条提交最多保存一份 AI 回复（含对话轮次和历史） |
| `ai.usage` | 每次调用的流水日志，用于月度配额计数 |
| `ai.credit` | 每个 `(domainId, uid)` 的积分余额 |
| `ai.credit_ledger` | 积分变更的追加日志（发放、扣减、退款、到期） |
| `ai.credit_award` | 首次 AC 奖励去重记录 |
| `ai.domain_access` | 每个用户在该域的 AI 开关和月度配额 |
| `ai.domain_config` | 每个域的 AI 提供方、模型和 API Key |
| `ai.credit_adjust` | 老师手动调整积分/配额的审计日志 |

---

## 提示词设计

内置 system prompt 的核心约束：

- **不给代码**：任何情况下不输出完整代码行（包括"改成：……"后跟代码）
- **不报算法名**：不直接说动态规划、贪心、二分等术语，而是用比喻引导
- **小学生语言**：用变量=盒子、循环=重复做事、数组=连号柜子等比喻
- **定向指出**：用反引号引用出错的标识符，但只给修改方向，不给完整改法
- **字数限制**：200–350 字，避免 AI 替学生把思路全说完

System prompt 可在控制面板覆盖。卡点选项（`questionFocus`）和学生补充说明（`studentNote`）会一并注入 user prompt，帮助 AI 针对性地回答。

---

## 文件结构

```
hydro-ai-tutor/
├── index.ts                        # 插件入口：路由、事件监听、系统设置注册
├── constants.ts                    # 提供方列表、默认 system prompt、集合名常量
├── credits.ts                      # 积分增减、到期清理、批量发放
├── utils.ts                        # cfg()、resolveProvider()、buildUserPrompt() 等工具函数
├── difficulty.ts                   # 题目难度评估脚本（可选功能）
├── types.ts                        # TypeScript 类型定义
├── handlers.ts                     # Handler 统一导出
├── handlers/
│   ├── suggestion.ts               # 分析页、SSE 流、反思对话
│   ├── domain_manage.ts            # 域管理主页（用户列表 + 接口配置）
│   ├── domain_batch.ts             # 批量导入调整
│   ├── domain_quota.ts             # 单用户追加配额
│   ├── admin.ts                    # 使用记录查询
│   └── credit_detail.ts           # 学生积分明细页
├── templates/                      # Nunjucks 模板
├── frontend/
│   └── record_ai_button.page.tsx  # 在评测详情页注入按钮
└── locales/
    └── zh.yaml
```
