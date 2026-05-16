/* eslint-disable no-await-in-loop */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import {
    Context, Handler, NotFoundError, ObjectId, param, PermissionError,
    PERM, PRIV, SystemModel, Types,
} from 'hydrooj';

// ─────────────────────────────────────────────────────────
// Types & constants
// ─────────────────────────────────────────────────────────

interface AiAnalysisDoc {
    _id: ObjectId;           // record id (rid)
    uid: number;             // user who triggered
    pid: number;             // problem doc id
    domainId: string;
    content: string;         // AI response (markdown plain text)
    model: string;
    promptText: string;      // full prompt sent to AI (for transparency)
    durationMs: number;
    createdAt: Date;
    monthKey: string;        // YYYY-MM, for cheap quota counting
}

// Provider presets: each entry maps a UI choice to (baseUrl, real model name, env var for API key).
// All listed providers expose an OpenAI-compatible /chat/completions endpoint, so the rest of the
// code path (SSE proxy, request format) doesn't care which one is picked.
interface ProviderPreset {
    label: string;           // shown in the dropdown
    baseUrl: string;
    model: string;
    apiKeyEnv: string;       // primary env var for this provider's key
}

const PROVIDERS: Record<string, ProviderPreset> = {
    // ── DeepSeek (default, China-friendly, OI 教练首选) ──
    'deepseek-v4-flash': { label: 'DeepSeek V4 Flash ', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    'deepseek-v4-pro':   { label: 'DeepSeek V4 Pro ',        baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro',   apiKeyEnv: 'DEEPSEEK_API_KEY' },
    'deepseek-reasoner': { label: 'DeepSeek Reasoner ',   baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner', apiKeyEnv: 'DEEPSEEK_API_KEY' },

    // ── OpenAI ──
    'openai-gpt-4o-mini': { label: 'OpenAI GPT-4o mini',                baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
    'openai-gpt-4o':      { label: 'OpenAI GPT-4o',                     baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',      apiKeyEnv: 'OPENAI_API_KEY' },

    // ── 国产 OpenAI 兼容 ──
    'qwen-turbo':   { label: '阿里 通义千问 Turbo',  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo', apiKeyEnv: 'DASHSCOPE_API_KEY' },
    'qwen-plus':    { label: '阿里 通义千问 Plus',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',  apiKeyEnv: 'DASHSCOPE_API_KEY' },
    'kimi-latest':  { label: 'Moonshot Kimi 最新版', baseUrl: 'https://api.moonshot.cn/v1',                        model: 'kimi-latest', apiKeyEnv: 'MOONSHOT_API_KEY' },
    'glm-4-flash':  { label: '智谱 GLM-4 Flash',     baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-4-flash', apiKeyEnv: 'ZHIPU_API_KEY' },
    'doubao-pro':   { label: '字节豆包 Pro',          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',          model: 'doubao-pro-32k', apiKeyEnv: 'ARK_API_KEY' },

    // ── 自定义出口（baseUrl + 模型名走配置项） ──
    custom: { label: '自定义 (用下方 customBaseUrl / customModel)', baseUrl: '', model: '', apiKeyEnv: 'AI_TUTOR_API_KEY' },
};

// Build dict<string, string> for the Hydro Setting `select` type
const PROVIDER_RANGE: Record<string, string> = Object.fromEntries(
    Object.entries(PROVIDERS).map(([key, p]) => [key, p.label]),
);

// Default system prompt — admin can override in 控制面板 > 系统设置 > AI Tutor
const DEFAULT_SYSTEM_PROMPT = `你是一位 OI/NOIP（信息学奥林匹克）少儿编程教练，正在辅导一位 10–12 岁的小学生学习算法竞赛入门题（C++ / Python）。

【你的身份与说话风格】
- 像一位有耐心、爱讲故事的好朋友老师。
- 语气鼓励、温柔、轻松，多用"我们"、"一起来想想"、"试试看"。
- 必须用小学生听得懂的中文，避免专业术语。如果一定要用，先用一句生活比喻解释它。
- 多用比喻、举例子、"在脑子里跑一遍"的思考方式。例如：
  · 变量 → "贴了标签的小盒子"
  · 循环 → "重复做同一件事"
  · 字符 → "键盘上的一个按键"
  · 数组 → "一排连号的小柜子"

【你必须遵守的铁律（任何情况下都不能违反）】
1. ❌ 绝不直接给出完整的正确代码（哪怕一两行也不行）。
2. ❌ 绝不直接说出算法名（如"动态规划""贪心""二分"等术语对小学生没意义）或完整题解。
3. ❌ 绝不写"你应该把代码改成：……"然后跟代码。
4. ❌ 绝不用大段专业表述（时间复杂度、数据结构理论等）。
5. ❌ 不要替学生"做完"题目，只能引导他自己想明白。

【你应该做的】
1. ✅ 先比对题目要求和孩子代码的差距，找出**一两个最关键**的错误点（不要罗列所有问题）。
2. ✅ 用反引号 \`xxx\` 引用孩子代码里出问题的关键字或那一行，告诉他"这里好像有个小问题哦"。
3. ✅ 用提问引导他自己发现错误：
   · "你想一想，题目说要输入一个 \`字符\`，那你的代码读到的是数字还是字符呢？"
   · "如果输入是 \`*\`，电脑会把它当成什么？"
4. ✅ 用形象的比喻解释为什么会错。
5. ✅ 给"修改方向"，不给"修改后的代码"：
   · ✔ "你可以试试换一个能装字符的盒子，它的名字叫做 \`char\`。"
   · ✘ "你应该写 \`char a; cin>>a; cout<<a;\`"
6. ✅ 结尾给一句鼓励，例如："你已经把整体思路想对了，离成功只差一小步啦，加油！"

【输出格式】
- 总字数 200–350 字之间。
- 自然的段落，不要用 # 标题，不要用 \`\`\` 代码块，不要用列表项编号。
- 段落之间空一行。
- 可以用单反引号 \`x\` 引用孩子代码里的关键词或单个标识符（不算"给代码"）。

接下来用户会发给你：题目内容、孩子的代码、评测结果。请按上面的规则给出引导式反馈。`;

const COLL_NAME = 'ai.analysis';

// ─────────────────────────────────────────────────────────
// .env loader (tiny inline, no dependency)
// ─────────────────────────────────────────────────────────

// Reads KEY=VALUE lines (ignoring # comments and blank lines), sets process.env keys.
// Does NOT overwrite already-set env vars (so pm2/systemd env wins).
// Looks in these paths in order; the FIRST that exists is loaded:
//   1. $AI_TUTOR_ENV_FILE     (explicit override)
//   2. ~/.hydro/.env          (Hydro's standard config location)
//   3. <plugin dir>/.env      (next to this index.ts)
function loadDotEnv(): { loadedFrom: string | null } {
    const candidates = [
        process.env.AI_TUTOR_ENV_FILE,
        path.join(os.homedir(), '.hydro', '.env'),
        path.join(__dirname, '.env'),
    ].filter(Boolean) as string[];

    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
            const text = fs.readFileSync(file, 'utf-8');
            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#')) continue;
                const eq = line.indexOf('=');
                if (eq < 0) continue;
                const key = line.slice(0, eq).trim();
                let val = line.slice(eq + 1).trim();
                // strip surrounding quotes
                if ((val.startsWith('"') && val.endsWith('"'))
                    || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (key && !(key in process.env)) process.env[key] = val;
            }
            return { loadedFrom: file };
        } catch { /* unreadable, try next */ }
    }
    return { loadedFrom: null };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function monthKey(d: Date = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function cfg<T = string>(key: string, fallback: T): T {
    const v = SystemModel.get(`ai-tutor.${key}`);
    return (v === undefined || v === null || v === '') ? fallback : (v as T);
}

// Resolve the active provider into a concrete { baseUrl, model, apiKey } triple.
// Looks up the dropdown choice in PROVIDERS, then reads API key from env vars
// (provider-specific first, then the universal AI_TUTOR_API_KEY fallback).
function resolveProvider(): { baseUrl: string; model: string; apiKey: string; providerKey: string } {
    const choice = cfg<string>('provider', 'deepseek-v4-flash');
    const preset = PROVIDERS[choice] || PROVIDERS['deepseek-v4-flash'];

    let baseUrl = preset.baseUrl;
    let model = preset.model;
    if (choice === 'custom') {
        baseUrl = cfg<string>('customBaseUrl', '');
        model = cfg<string>('customModel', '');
    }

    const apiKey = process.env[preset.apiKeyEnv] || process.env.AI_TUTOR_API_KEY || '';
    return { baseUrl, model, apiKey, providerKey: choice };
}

function truncate(s: string, max: number): string {
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max)}\n...(已截断，共 ${s.length} 字符)` : s;
}

function buildUserPrompt(pdoc: any, rdoc: any, langDisplay: string, statusText: string): string {
    const failed = (rdoc.testCases || [])
        .filter((tc: any) => tc.status && tc.status !== 1) // 1 = STATUS_ACCEPTED
        .slice(0, 3)
        .map((tc: any, i: number) => `  · 第 ${i + 1} 个失败点：${tc.message || ''}`.trim())
        .join('\n');

    const maxProblem = cfg<number>('maxProblemChars', 4000);
    const maxCode = cfg<number>('maxCodeChars', 3000);

    return `## 题目
# ${pdoc.title || ''}

${truncate(pdoc.content || '', maxProblem)}

## 我的代码（${langDisplay}）

\`\`\`
${truncate(rdoc.code || '', maxCode)}
\`\`\`

## 评测结果
- 状态：${statusText}
- 得分：${typeof rdoc.score === 'number' ? rdoc.score : '未知'}
${failed ? `- 失败的测试点（最多展示 3 个）：\n${failed}` : ''}`;
}

// ─────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────

class AiSuggestionHandler extends Handler {
    rdoc: any;
    pdoc: any;

    @param('rid', Types.ObjectId)
    async _prepare(domainId: string, rid: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const RecordModel = global.Hydro.model.record;
        const ProblemModel = global.Hydro.model.problem;
        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc) throw new NotFoundError(rid);

        // Auth: owner OR admin
        const isOwner = rdoc.uid === this.user._id;
        const canRead = this.user.hasPriv(PRIV.PRIV_READ_RECORD_CODE)
            || this.user.hasPerm(PERM.PERM_READ_RECORD_CODE);
        if (!isOwner && !canRead) throw new PermissionError(PERM.PERM_READ_RECORD_CODE);

        if (!rdoc.code) throw new NotFoundError('record has no code');
        this.rdoc = rdoc;
        this.pdoc = await ProblemModel.get(rdoc.domainId, rdoc.pid);
        if (!this.pdoc) throw new NotFoundError('problem');
    }

    async getUsage(): Promise<{ used: number; limit: number; remaining: number }> {
        const coll = this.ctx.db.collection(COLL_NAME as any);
        const limit = cfg<number>('monthlyQuota', 30);
        const used = await coll.countDocuments({
            uid: this.user._id,
            monthKey: monthKey(),
        });
        return { used, limit, remaining: Math.max(0, limit - used) };
    }

    @param('rid', Types.ObjectId)
    async get(domainId: string, rid: ObjectId) {
        const coll = this.ctx.db.collection(COLL_NAME as any);
        const saved: AiAnalysisDoc | null = await coll.findOne({ _id: rid });
        const usage = await this.getUsage();

        const STATUS_TEXTS = global.Hydro.model.builtin.STATUS_TEXTS;
        const langs = global.Hydro.model.setting.langs || {};
        const langDisplay = langs[this.rdoc.lang]?.display || this.rdoc.lang || 'code';
        const statusText = STATUS_TEXTS[this.rdoc.status] || String(this.rdoc.status);

        const systemPrompt = cfg<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);
        const userPrompt = buildUserPrompt(this.pdoc, this.rdoc, langDisplay, statusText);
        const fullPrompt = `【System Prompt】\n${systemPrompt}\n\n【User Prompt】\n${userPrompt}`;

        const provider = resolveProvider();
        // "configured" = API key in env AND (preset OR custom with baseUrl+model filled)
        const apiKeyConfigured = !!provider.apiKey
            && (provider.providerKey !== 'custom' || (!!provider.baseUrl && !!provider.model));

        this.response.template = 'ai_suggestion.html';
        this.response.body = {
            rdoc: this.rdoc,
            pdoc: this.pdoc,
            saved: saved ? {
                content: saved.content,
                model: saved.model,
                durationMs: saved.durationMs,
                createdAt: saved.createdAt,
            } : null,
            usage,
            fullPrompt,
            apiKeyConfigured,
            providerLabel: PROVIDERS[provider.providerKey]?.label || provider.providerKey,
            page_name: 'ai_suggestion',
        };
    }

    @param('rid', Types.ObjectId)
    async postClear(domainId: string, rid: ObjectId) {
        const coll = this.ctx.db.collection(COLL_NAME as any);
        await coll.deleteOne({ _id: rid, uid: this.user._id });
        this.response.body = { ok: true };
        this.response.redirect = this.url('ai_suggestion', { rid });
    }

    // POST action=start  →  SSE stream
    @param('rid', Types.ObjectId)
    async postStart(domainId: string, rid: ObjectId) {
        const provider = resolveProvider();
        if (!provider.apiKey) {
            this.response.body = {
                error: `AI 服务尚未配置 API Key。请在 .env 或环境变量中设置 ${PROVIDERS[provider.providerKey]?.apiKeyEnv || 'AI_TUTOR_API_KEY'}，然后重启 Hydro。`,
            };
            this.response.status = 503;
            return;
        }
        if (provider.providerKey === 'custom' && (!provider.baseUrl || !provider.model)) {
            this.response.body = { error: '自定义提供方需要同时填写 customBaseUrl 与 customModel。' };
            this.response.status = 503;
            return;
        }

        const usage = await this.getUsage();
        if (usage.remaining <= 0) {
            this.response.body = { error: `本月配额已用完（${usage.used}/${usage.limit}），下月 1 日重置。` };
            this.response.status = 429;
            return;
        }

        const { baseUrl, model, apiKey } = provider;
        const temperature = cfg<number>('temperature', 0.7);
        const maxTokens = cfg<number>('maxTokens', 1024);
        const timeoutMs = cfg<number>('timeoutMs', 60000);
        const systemPrompt = cfg<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);

        const STATUS_TEXTS = global.Hydro.model.builtin.STATUS_TEXTS;
        const langs = global.Hydro.model.setting.langs || {};
        const langDisplay = langs[this.rdoc.lang]?.display || this.rdoc.lang || 'code';
        const statusText = STATUS_TEXTS[this.rdoc.status] || String(this.rdoc.status);
        const userPrompt = buildUserPrompt(this.pdoc, this.rdoc, langDisplay, statusText);
        const fullPromptText = `【System Prompt】\n${systemPrompt}\n\n【User Prompt】\n${userPrompt}`;

        // ── set up raw SSE response ──
        const ctx = this.context;
        const stream = new PassThrough();
        ctx.req.socket.setTimeout(0);
        ctx.req.socket.setNoDelay(true);
        ctx.req.socket.setKeepAlive(true);
        ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
        ctx.set('Cache-Control', 'no-cache, no-transform');
        ctx.set('Connection', 'keep-alive');
        ctx.set('X-Accel-Buffering', 'no');
        (ctx as any).compress = false;
        // Tell hydro framework "don't post-process this response"
        this.request.websocket = true;
        ctx.status = 200;
        ctx.body = stream;

        const send = (obj: any) => {
            try {
                stream.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch { /* client closed */ }
        };

        const startTime = Date.now();
        const aborter = new AbortController();
        const timer = setTimeout(() => aborter.abort(), timeoutMs);
        const coll = this.ctx.db.collection(COLL_NAME as any);
        const rdocPid = this.rdoc.pid;
        const rdocDomainId = this.rdoc.domainId;
        const uid = this.user._id;

        // Run streamer in background (post() returns, framework hands off to Koa)
        (async () => {
            let fullText = '';
            try {
                const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
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
                        temperature,
                        max_tokens: maxTokens,
                    }),
                    signal: aborter.signal,
                });

                if (!resp.ok || !resp.body) {
                    const errText = await resp.text().catch(() => '');
                    send({ type: 'error', error: `AI 服务异常 (${resp.status})：${errText.slice(0, 200)}` });
                    stream.end();
                    return;
                }

                // Parse SSE from DeepSeek
                const reader = (resp.body as any).getReader();
                const decoder = new TextDecoder('utf-8');
                let buf = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;
                        const data = trimmed.slice(5).trim();
                        if (!data || data === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullText += delta;
                                send({ type: 'chunk', content: delta });
                            }
                        } catch { /* ignore malformed SSE line */ }
                    }
                }

                const durationMs = Date.now() - startTime;
                // Persist (counts toward this month's quota via createdAt)
                await coll.replaceOne(
                    { _id: rid },
                    {
                        _id: rid,
                        uid,
                        pid: rdocPid,
                        domainId: rdocDomainId,
                        content: fullText,
                        model,
                        promptText: fullPromptText,
                        durationMs,
                        createdAt: new Date(),
                        monthKey: monthKey(),
                    },
                    { upsert: true },
                );
                const after = await coll.countDocuments({ uid, monthKey: monthKey() });
                send({
                    type: 'done',
                    durationMs,
                    remaining: Math.max(0, cfg<number>('monthlyQuota', 30) - after),
                });
                stream.end();
            } catch (err: any) {
                send({ type: 'error', error: err?.message || String(err) });
                try { stream.end(); } catch { /* */ }
            } finally {
                clearTimeout(timer);
            }
        })();
    }
}

// ─────────────────────────────────────────────────────────
// Plugin entry
// ─────────────────────────────────────────────────────────

export async function apply(ctx: Context) {
    // Load .env file (if present) before reading any provider keys.
    // Existing env vars (pm2 / systemd / shell) are NOT overwritten — they win.
    const envInfo = loadDotEnv();
    if (envInfo.loadedFrom) {
        console.log(`[ai-tutor] loaded .env from ${envInfo.loadedFrom}`);
    }

    // Use the official `ctx.inject(['setting'], ...)` pattern (same as ui-default does).
    // This ensures the setting service is ready and gives proper dispose-on-unload behavior.
    ctx.inject(['setting'], (c) => {
        const SM = global.Hydro.model.setting;
        c.setting.SystemSetting(
            // Provider dropdown — admin picks from preset {baseUrl, model} combos.
            // Passing the Record<string,string> as the 4th arg auto-renders as a <select>.
            SM.Setting('setting_basic', 'ai-tutor.provider', 'deepseek-v4-flash',
                PROVIDER_RANGE,
                'AI Tutor: Provider',
                'API Key 通过 .env 读取（DEEPSEEK_API_KEY / OPENAI_API_KEY / DASHSCOPE_API_KEY / MOONSHOT_API_KEY / ZHIPU_API_KEY / ARK_API_KEY / AI_TUTOR_API_KEY 作为通用 fallback）'),
            SM.Setting('setting_basic', 'ai-tutor.customBaseUrl', '', 'text',
                'AI Tutor: Custom Base URL', '仅当 provider=custom 时使用，例如 https://api.openai.com/v1'),
            SM.Setting('setting_basic', 'ai-tutor.customModel', '', 'text',
                'AI Tutor: Custom Model Name', '仅当 provider=custom 时使用，例如 gpt-4o'),

            SM.Setting('setting_basic', 'ai-tutor.monthlyQuota', 30, 'number',
                'AI Tutor: Monthly quota per user', '每个用户每月最多调用次数'),
            SM.Setting('setting_basic', 'ai-tutor.maxCodeChars', 3000, 'number',
                'AI Tutor: Max code chars', '提交给 AI 的代码最大字符数（超出截断）'),
            SM.Setting('setting_basic', 'ai-tutor.maxProblemChars', 4000, 'number',
                'AI Tutor: Max problem chars', '提交给 AI 的题面最大字符数（超出截断）'),
            SM.Setting('setting_basic', 'ai-tutor.temperature', 0.7, 'number',
                'AI Tutor: Temperature', '采样温度，0–1 之间'),
            SM.Setting('setting_basic', 'ai-tutor.maxTokens', 1024, 'number',
                'AI Tutor: Max output tokens', '单次最大输出 token 数'),
            SM.Setting('setting_basic', 'ai-tutor.timeoutMs', 60000, 'number',
                'AI Tutor: Timeout (ms)', '单次请求最长等待时间，毫秒'),
            SM.Setting('setting_basic', 'ai-tutor.systemPrompt', DEFAULT_SYSTEM_PROMPT, 'textarea',
                'AI Tutor: System Prompt', '系统提示词，控制 AI 教练的人设与铁律'),
        );
    });

    // Ensure indexes (createdAt for monthly aggregation; uid+monthKey for fast count)
    ctx.on('app/started', async () => {
        const coll = ctx.db.collection(COLL_NAME as any);
        await coll.createIndex({ uid: 1, monthKey: 1 }).catch(() => { /* already exists */ });
        await coll.createIndex({ createdAt: -1 }).catch(() => { /* */ });
    });

    ctx.Route('ai_suggestion', '/record/:rid/ai', AiSuggestionHandler, PRIV.PRIV_USER_PROFILE);

    ctx.i18n.load('zh', {
        ai_suggestion: 'AI 刷题建议',
        'AI Problem Suggestion': 'AI 刷题建议',
    });
    ctx.i18n.load('en', {
        ai_suggestion: 'AI Problem Suggestion',
    });
}
