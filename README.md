# hydro-ai-tutor

**AI 刷题建议** — 给 HydroOJ 的小学生信奥赛学员加一个 "AI 教练" 按钮：基于 DeepSeek V4（或其他主流模型）流式分析孩子提交的代码，按 "启发式" 原则给出温和、具象、不直接给答案的指导。

预计 V1 默认适配 **DeepSeek-V4**（`deepseek-v4-flash`），同时支持 OpenAI、通义千问、Kimi、智谱 GLM、豆包等主流 OpenAI-兼容模型——管理员只需在控制面板下拉切换。

---

## 功能一览（对应需求文档）

| 截图 | 功能 | 实现 |
|---|---|---|
| 图 1 | 评测详情页 "代码" 区域右侧加 **AI 刷题建议** 按钮 | `frontend/record_ai_button.page.tsx` 在 `record_detail` 注入 |
| 图 2 | 显示剩余配额 + "正在调用 AI" Loading | 模板 `ai_suggestion.html` + 前端 SSE 客户端 |
| 图 3 | 流式接收 AI 回复，正文实时增长 | 后端 SSE 代理转发提供方流 |
| 图 4 | 初始态 "开始分析" + "复制给 AI 的完整内容" 区 | 模板默认状态 |
| 图 5 | 完成后展示 "重新分析" / "清除分析" + 耗时 | 前端在 `done` 事件后切换按钮组 |

---

## 文件结构

```
hydro-ai-tutor/
├── package.json
├── README.md
├── .env.example                        ← 复制为 ~/.hydro/.env 填 API Key
├── index.ts                            ← 后端：路由 + SSE 代理 + provider 解析 + 配额
├── templates/
│   └── ai_suggestion.html              ← 分析页（含前端 SSE 客户端）
├── frontend/
│   └── record_ai_button.page.tsx       ← 在 record_detail 注入按钮
└── locales/
    └── zh.yaml
```

---

## 安装与配置（两步）

### Step 1: 装插件

```bash
hydrooj addon add /path/to/hydro-ai-tutor
```

### Step 2: 配 API Key（用 .env，**不在控制面板填**）

```bash
# 复制模板到 Hydro 标准配置目录
cp /path/to/hydro-ai-tutor/.env.example ~/.hydro/.env

# 编辑，把要用的 provider 那一行填上真实 key
vim ~/.hydro/.env

# 重启 Hydro 读取新 env
pm2 restart hydrooj
```

启动时如果成功加载，日志会有 `[ai-tutor] loaded .env from /root/.hydro/.env` 一行。

最后到 **控制面板 → 系统设置** 选择 provider（默认 DeepSeek V4 Flash），即可。

---

## .env 搜索顺序

插件按以下顺序找 `.env`，**第一个存在的文件**会被读取：

1. `$AI_TUTOR_ENV_FILE`（环境变量里指定的绝对路径）
2. `~/.hydro/.env`（**推荐**，与 Hydro 其他配置同目录）
3. `<插件目录>/.env`（不推荐，文件可能被 git 不小心提交）

**已经在 `process.env` 里的变量不会被覆盖**——pm2 / systemd / shell export 的 env 优先级最高。

---

## Provider 与 API Key 映射

`index.ts` 里的 `PROVIDERS` 表定义了每个下拉选项对应的 `(baseUrl, model, apiKeyEnv)`。完整列表：

| 控制面板下拉值 | 实际模型 | Base URL | 需要的 env var |
|---|---|---|---|
| `deepseek-v4-flash` (默认) | DeepSeek V4 Flash | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `deepseek-v4-pro` | DeepSeek V4 Pro | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `deepseek-reasoner` | DeepSeek Reasoner | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `openai-gpt-4o-mini` | gpt-4o-mini | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openai-gpt-4o` | gpt-4o | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `qwen-turbo` | qwen-turbo | Dashscope 兼容入口 | `DASHSCOPE_API_KEY` |
| `qwen-plus` | qwen-plus | Dashscope 兼容入口 | `DASHSCOPE_API_KEY` |
| `kimi-latest` | kimi-latest | Moonshot | `MOONSHOT_API_KEY` |
| `glm-4-flash` | glm-4-flash | 智谱 BigModel | `ZHIPU_API_KEY` |
| `doubao-pro` | doubao-pro-32k | 火山方舟 | `ARK_API_KEY` |
| `custom` | 用 `ai-tutor.customModel` | 用 `ai-tutor.customBaseUrl` | `AI_TUTOR_API_KEY`（fallback） |

**fallback 机制**：选了某个 provider 但对应的 env var 没填，会自动用 `AI_TUTOR_API_KEY` 兜底——方便单一 provider 场景。

---

## 控制面板设置项

| Key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ai-tutor.provider` | select | `deepseek-v4-flash` | 下拉选 provider，决定 baseUrl + 模型 |
| `ai-tutor.customBaseUrl` | text | `''` | 仅 provider=custom 时使用 |
| `ai-tutor.customModel` | text | `''` | 仅 provider=custom 时使用 |
| `ai-tutor.monthlyQuota` | number | `30` | 每用户月度调用上限 |
| `ai-tutor.maxCodeChars` | number | `3000` | 提交给 AI 的代码长度上限 |
| `ai-tutor.maxProblemChars` | number | `4000` | 题面长度上限 |
| `ai-tutor.temperature` | number | `0.7` | 采样温度 |
| `ai-tutor.maxTokens` | number | `1024` | 单次输出 token 上限 |
| `ai-tutor.timeoutMs` | number | `60000` | 单次请求超时 |
| `ai-tutor.systemPrompt` | textarea | 见下文 | 教练人设与铁律 |

注意：**`apiKey` 不在控制面板里**——只能通过 .env / 环境变量配置。这样有两个好处：
1. 安全：非 root admin 看不到 key
2. 备份/迁移：API key 跟着 server config 走，不在 MongoDB 里

---

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/record/:rid/ai` | 分析页（有缓存直接展示，无则显示 "开始分析"） |
| POST | `/record/:rid/ai` `action=start` | 启动分析。**响应是 `text/event-stream` SSE 流** |
| POST | `/record/:rid/ai` `action=clear` | 清除已有分析（不返还配额） |

权限：必须是提交者本人，或拥有 `PRIV_READ_RECORD_CODE` / `PERM_READ_RECORD_CODE` 的管理员。

---

## 数据模型

集合 `ai.analysis`（每条 record 最多一份分析）：

```ts
{
  _id: ObjectId,           // rid
  uid: number,
  pid: number,
  domainId: string,
  content: string,         // AI 完整回复
  model: string,           // 实际使用的模型名（不是 provider key）
  promptText: string,      // 完整 prompt（审计/透明）
  durationMs: number,
  createdAt: Date,
  monthKey: string,        // 'YYYY-MM'，配额聚合用
}
```

配额计算：`countDocuments({ uid, monthKey: 当前月份 })`，无需额外计数表。

索引：`{uid:1, monthKey:1}`、`{createdAt:-1}`。

---

## 提示词（Prompt）设计

### 设计思路

需求里有三条硬约束：

1. **绝不给代码** — 最容易被绕过的红线，需要用否定式 + 示例反复强调。
2. **小学生听得懂** — 强制要求 "先比喻再术语" 的输出范式。
3. **指出错误位置和方向** — 但停在 "方向"，不能跨到 "修改后代码"。

为此 prompt 拆成五段：**身份 → 风格 → 铁律（❌）→ 应做（✅）→ 格式**。每条 "应做" 项都配了具体例子，因为大模型在 few-shot 示例下更稳定。

特别地：

- 铁律里同时写 ✅ 样例和 ✘ 样例（"你可以试试换一个能装字符的盒子，它的名字叫做 `char`。" vs "你应该写 `char a; cin>>a; cout<<a;`"），因为只写禁令模型容易擦边，配对样例后效果稳定很多。
- 反引号引用单个标识符是**允许的**——这是 "指错位置" 的需要，不是 "给代码"。在 prompt 里明确区分这两件事。
- 字数限制 200–350 字，避免 AI 啰嗦把整套思路替孩子说完。
- 比喻库（盒子 / 重复做事 / 键盘按键 / 连号小柜子）直接写进 prompt，省得模型现编不熟悉的比喻。

### Default System Prompt

完整版在 `index.ts` 的 `DEFAULT_SYSTEM_PROMPT` 常量里，可在控制面板覆盖。

### User Prompt 模板

```
## 题目
# {pdoc.title}

{pdoc.content（截断到 4000 字）}

## 我的代码（{language}）

```{code 截断到 3000 字}```

## 评测结果
- 状态：{statusText}
- 得分：{rdoc.score}
- 失败的测试点（最多 3 个）：...
```

---

## API 调用细节

所有 provider 都用 OpenAI 兼容的 `/chat/completions`，流式：

```ts
fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 1024,
  }),
});
```

返回的 SSE 行（DeepSeek/OpenAI 格式）：

```
data: {"choices":[{"delta":{"content":"你"}}]}
data: {"choices":[{"delta":{"content":"的"}}]}
data: [DONE]
```

后端解析后**重新打包**成更干净的事件转发给浏览器：

```
data: {"type":"chunk","content":"你"}
data: {"type":"chunk","content":"的"}
data: {"type":"done","durationMs":4231,"remaining":29}
```

这样浏览器侧不需要感知 OpenAI 的内部字段命名，将来某个 provider 改协议只需改后端一处。

---

## SSE 实现的 Hydro 特殊处理

走 "POST + Response Body 是 SSE" 路径（不用 EventSource，因为 EventSource 只能 GET 无法带 body）。关键三点：

1. **绕过 Hydro 框架的响应后处理**：
   ```ts
   this.request.websocket = true;  // 让 framework/base.ts 跳过 ctx.body 重写
   ctx.body = passThroughStream;
   ```
   `framework/base.ts` 里有一句 `if (request.websocket) return;`——设了这个 flag 后，框架不会再覆盖流式响应。

2. **禁用 gzip 与 Nginx 缓冲**：
   ```
   X-Accel-Buffering: no       ← Nginx 不要缓冲
   Cache-Control: no-cache
   ```
   `ctx.compress = false` 关掉 koa-compress（不然小块会被缓冲）。

3. **后台异步推流**：在 `post()` 里 `kickoff()` 一个 async IIFE，**不 await**，让 `post()` 立即返回。框架返回后 Koa 自动把 PassThrough 流泵给响应。

---

## 经验沉淀（应用了之前插件的教训）

| 教训 | 本插件如何应用 |
|---|---|
| `user/domain/record/problem` 在模块顶层 import 是 `undefined` | 全部用 `global.Hydro.model.*` 在 handler 里访问 |
| POST 字段 `operation` 是保留字 | 用 `action=start` / `action=clear` |
| `this.domain._id` 比 URL 参数稳 | 直接用 `this.rdoc.domainId` |
| Nunjucks 模板不要塞 `PERM.*` / BigInt | 全部权限检查在 handler 里完成，模板只拿到布尔值/字符串 |
| Hydro 路由首匹配优先 | 路由 `/record/:rid/ai` 不冲突现有 `/record/:rid` |
| 按钮注入用 `NamedPage` + `querySelector`，不要覆盖模板 | `frontend/record_ai_button.page.tsx` |
| 设置注册要用 `ctx.inject(['setting'], ...)` 不要直接调 global 函数 | 见 `apply()` 里的 inject 写法 |

---

## 验收清单

- [ ] 插件 `hydrooj addon list` 能看到 `hydro-ai-tutor`
- [ ] `~/.hydro/.env` 填入对应 provider 的 key，`pm2 restart hydrooj` 后日志有 `[ai-tutor] loaded .env from ...`
- [ ] 评测详情页右上 "下载" 右边出现 **AI 刷题建议** 按钮
- [ ] 点击按钮跳转 `/record/:rid/ai`，显示剩余配额和当前模型
- [ ] 控制面板 → 系统设置里有 `ai-tutor.provider` 下拉框，包含 11 个选项
- [ ] 点击 "开始分析" 出现 spinner，约 1–2s 后文字一字一字冒出
- [ ] 完成后底部显示 "分析完成，耗时 N 秒"
- [ ] 出现 "重新分析" / "清除分析" 按钮
- [ ] 刷新页面，已分析的内容直接显示（不会再次扣配额）
- [ ] 单击 "清除分析" 后再次显示 "开始分析"
- [ ] 配额用完时按钮置灰且文案提示
- [ ] AI 回复中**不**出现完整代码段（含 \`\`\`code\`\`\` 块）
- [ ] 切换 provider 后刷新页面，"当前模型" 显示更新

---

## 后续可能扩展（**未实现**）

- 流程中 "取消" 按钮（当前由 `timeoutMs` 兜底）
- 多次问答历史（当前一题一次性分析）
- 不同年级学生的多套 prompt 切换
- 教师后台审计：查看所有学生的分析记录
- 配额按域分别计数（当前是全局月度配额）
