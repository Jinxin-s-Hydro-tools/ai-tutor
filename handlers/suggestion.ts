import { PassThrough } from 'stream';

import {
    ForbiddenError, Handler, NotFoundError, ObjectId, OplogModel, param, PermissionError, query,
    PERM, PRIV, Types,
} from 'hydrooj';

import {
    COLL_ANALYSIS, COLL_AWARD, COLL_CREDIT, COLL_CREDIT_ADJUST, COLL_CREDIT_LEDGER, COLL_DOMAIN_ACCESS,
    COLL_USAGE, DEFAULT_SYSTEM_PROMPT, PROVIDERS, QUESTION_FOCUS,
} from '../constants';
import {
    adjustCreditClamped, adjustCreditManually, adjustQuotaBonusClamped, deductCredit, expireCredits,
    refundDeductedCredit,
} from '../credits';
import { AiAnalysisDoc, AiDomainAccessDoc } from '../types';
import {
    buildUserPrompt, cfg, cfgNumber, creditId, creditQuery, escapeRegex, isObjectiveProblem, looksInterruptedReply,
    monthKey, monthlyQuotaBonus, monthlyQuotaCap, parseIntegerCell, resolveAiTutorDomain, resolveProvider, splitImportLine,
} from '../utils';

export class AiSuggestionHandler extends Handler {
    rdoc: any;
    pdoc: any;
    submissionCount = 0;
    minSubmissions = 2;
    aiEnabled = false;
    monthlyBonus = 0;
    monthlyCap = 0;

    @param('rid', Types.ObjectId)
    async _prepare(domainId: string, rid: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const RecordModel = global.Hydro.model.record;
        const ProblemModel = global.Hydro.model.problem;
        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc) throw new NotFoundError(rid);

        // Auth: owner OR admin
        const isOwner = rdoc.uid === this.user._id;
        const canRead = this.user.hasPerm(PERM.PERM_READ_RECORD_CODE);
        if (!isOwner && !canRead) throw new PermissionError(PERM.PERM_READ_RECORD_CODE);

        if (!rdoc.code) throw new NotFoundError('record has no code');
        this.rdoc = rdoc;
        this.pdoc = await ProblemModel.get(rdoc.domainId, rdoc.pid);
        if (!this.pdoc) throw new NotFoundError('problem');
        if (isObjectiveProblem(this.pdoc)) throw new NotFoundError('objective problem does not support AI tutor');

        const access = await this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({
            domainId: rdoc.domainId,
            uid: rdoc.uid,
        }) as AiDomainAccessDoc | null;
        this.aiEnabled = !!access?.enabled;
        if (!this.aiEnabled) throw new ForbiddenError('老师尚未为你开启这道题所在域的 AI 刷题建议功能。');
        const month = monthKey();
        this.monthlyBonus = monthlyQuotaBonus(access, month);
        this.monthlyCap = monthlyQuotaCap(access, month);

        // Submission-gate: count how many times THIS user submitted THIS problem
        // (across all records in this domain). Used to block first-try AI requests.
        this.minSubmissions = Math.max(1, Math.trunc(cfgNumber('minSubmissions', 2)));
        this.submissionCount = await RecordModel.coll.countDocuments({
            domainId: rdoc.domainId,
            uid: rdoc.uid,
            pid: rdoc.pid,
        });
    }

    // Keep this hook for older call sites. Opening AI access does not grant credits;
    // balance documents are created by real credit changes such as weekly grants or AC awards.
    async ensureBalanceInit() {
        await expireCredits(this.ctx, this.user._id, this.rdoc.domainId);
    }

    // Returns: credit balance, monthly usage count, monthly cap, and a few rolled-up fields
    // for template/UI convenience. Reads-only; doesn't mutate.
    async getUsage(): Promise<{
        balance: number;
        totalEarned: number;
        totalSpent: number;
        monthlyUsed: number;
        monthlyCap: number;
        canUse: boolean;
        reason: string;
    }> {
        const monthlyCap = this.monthlyCap;
        const [balanceDoc, monthlyUsed] = await Promise.all([
            this.ctx.db.collection(COLL_CREDIT as any).findOne(creditQuery(this.rdoc.domainId, this.user._id)),
            this.ctx.db.collection(COLL_USAGE as any).countDocuments({
                uid: this.user._id,
                domainId: this.rdoc.domainId,
                monthKey: monthKey(),
            }),
        ]);
        const balance = (balanceDoc as any)?.balance ?? 0;
        const totalEarned = (balanceDoc as any)?.totalEarned ?? 0;
        const totalSpent = (balanceDoc as any)?.totalSpent ?? 0;
        let canUse = true;
        let reason = '';
        if (balance <= 0) {
            canUse = false;
            reason = '积分余额不足，去 AC 几道新题获得积分吧！';
        } else if (monthlyUsed >= monthlyCap) {
            canUse = false;
            reason = `本月已达使用上限（${monthlyUsed}/${monthlyCap}），下月 1 日重置。`;
        }
        return {
            balance, totalEarned, totalSpent, monthlyUsed, monthlyCap, canUse, reason,
        };
    }

    @param('rid', Types.ObjectId)
    async get(domainId: string, rid: ObjectId) {
        await this.ensureBalanceInit();
        const coll = this.ctx.db.collection(COLL_ANALYSIS as any);
        const saved: AiAnalysisDoc | null = await coll.findOne({ _id: rid });
        const usage = await this.getUsage();

        const STATUS_TEXTS = global.Hydro.model.builtin.STATUS_TEXTS;
        const langs = global.Hydro.model.setting.langs || {};
        const langDisplay = langs[this.rdoc.lang]?.display || this.rdoc.lang || 'code';
        const statusText = STATUS_TEXTS[this.rdoc.status] || String(this.rdoc.status);

        const systemPrompt = cfg<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);
        const userPrompt = buildUserPrompt(this.pdoc, this.rdoc, langDisplay, statusText);
        const fullPrompt = `【System Prompt】\n${systemPrompt}\n\n【User Prompt】\n${userPrompt}`;

        const provider = await resolveProvider(this.ctx, this.rdoc.domainId);
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
                dialogue: ((saved as any).dialogue || []).map((msg: any) => ({
                    ...msg,
                    interrupted: !!msg.interrupted || (msg.role === 'tutor' && looksInterruptedReply(msg.text)),
                })),
                promptText: saved.promptText,
                questionFocus: saved.questionFocus || '',
                questionFocusLabel: saved.questionFocusLabel || '',
                studentNote: saved.studentNote || '',
                interrupted: !!saved.interrupted || looksInterruptedReply(saved.content),
                finishReason: saved.finishReason || '',
                history: (saved.history || []),
            } : null,
            usage,
            fullPrompt: saved?.promptText || fullPrompt,
            apiKeyConfigured,
            providerLabel: PROVIDERS[provider.providerKey]?.label || provider.providerKey,
            submissionCount: this.submissionCount,
            minSubmissions: this.minSubmissions,
            submissionGatePassed: this.submissionCount >= this.minSubmissions,
            aiEnabled: this.aiEnabled,
            monthlyBonus: this.monthlyBonus,
            page_name: 'ai_suggestion',
        };
    }

    // POST operation=start  →  SSE stream
    @param('rid', Types.ObjectId)
    @param('questionFocus', Types.String, true)
    @param('studentNote', Types.String, true)
    async postStart(domainId: string, rid: ObjectId, questionFocus = '', studentNote = '') {
        if (!this.aiEnabled) {
            this.response.body = { error: '老师尚未为你开启这道题所在域的 AI 刷题建议功能。' };
            this.response.status = 403;
            return;
        }

        questionFocus = (questionFocus || '').trim();
        studentNote = (studentNote || '').trim();
        const questionFocusLabel = QUESTION_FOCUS[questionFocus] || '';
        if (!questionFocusLabel) {
            this.response.body = { error: '请先选择一个你最想解决的卡点。' };
            this.response.status = 400;
            return;
        }
        if (studentNote.length < 10) {
            this.response.body = { error: '请至少用 10 个字描述你试过什么，或具体卡在哪里。' };
            this.response.status = 400;
            return;
        }
        if (studentNote.length > 500) {
            this.response.body = { error: '补充说明请控制在 500 字以内。' };
            this.response.status = 400;
            return;
        }

        const provider = await resolveProvider(this.ctx, this.rdoc.domainId);
        if (!provider.apiKey) {
            this.response.body = {
                error: 'AI 服务尚未配置 API Key。请老师在当前域的 AI 刷题管理页填写接口配置。',
            };
            this.response.status = 503;
            return;
        }
        if (provider.providerKey === 'custom' && (!provider.baseUrl || !provider.model)) {
            this.response.body = { error: '自定义提供方需要同时填写 Base URL 与模型名称。' };
            this.response.status = 503;
            return;
        }

        // Step 0: submission gate — student must have submitted this problem at least N times
        if (this.submissionCount < this.minSubmissions) {
            this.response.body = {
                error: `这道题你才提交了 ${this.submissionCount} 次，先自己再试试看吧。提交满 ${this.minSubmissions} 次后才能找 AI 教练。`,
            };
            this.response.status = 429;
            return;
        }

        // Step 1: read-only monthly cap check (cheap, fails fast).
        await this.ensureBalanceInit();
        const monthlyCap = this.monthlyCap;
        const usageColl = this.ctx.db.collection(COLL_USAGE as any);
        const monthlyUsed = await usageColl.countDocuments({
            uid: this.user._id,
            domainId: this.rdoc.domainId,
            monthKey: monthKey(),
        });
        if (monthlyUsed >= monthlyCap) {
            this.response.body = { error: `本月已达使用上限（${monthlyUsed}/${monthlyCap}），下月 1 日重置。` };
            this.response.status = 429;
            return;
        }

        // Step 2: atomic credit deduction. The deduction consumes the earliest-expiring
        // credit lots first, so every grant keeps its own 30-day validity.
        const balanceColl = this.ctx.db.collection(COLL_CREDIT as any);
        const deduction = await deductCredit(this.ctx, this.user._id, {
            reason: '调用 AI 教练分析提交',
            domainId: this.rdoc.domainId,
            pid: this.rdoc.pid,
            rid,
        });
        if (!deduction) {
            this.response.body = { error: '积分余额不足，去 AC 几道新题获得积分吧！' };
            this.response.status = 429;
            return;
        }

        const { baseUrl, model, apiKey } = provider;
        const temperature = cfgNumber('temperature', 0.7);
        const maxTokens = Math.trunc(cfgNumber('maxTokens', 1024));
        const timeoutMs = cfgNumber('timeoutMs', 60000);
        const systemPrompt = cfg<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);

        const STATUS_TEXTS = global.Hydro.model.builtin.STATUS_TEXTS;
        const langs = global.Hydro.model.setting.langs || {};
        const langDisplay = langs[this.rdoc.lang]?.display || this.rdoc.lang || 'code';
        const statusText = STATUS_TEXTS[this.rdoc.status] || String(this.rdoc.status);
        const userPrompt = buildUserPrompt(
            this.pdoc,
            this.rdoc,
            langDisplay,
            statusText,
            questionFocusLabel,
            studentNote,
        );
        const fullPromptText = `【System Prompt】\n${systemPrompt}\n\n【User Prompt】\n${userPrompt}`;

        // Refund helper (called if the API call ultimately fails before we log success)
        let refunded = false;
        const refundCredit = async () => {
            if (refunded) return;
            refunded = true;
            try {
                await refundDeductedCredit(this.ctx, this.rdoc.domainId, this.user._id, deduction);
            } catch { /* best-effort */ }
        };

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
        const analysisColl = this.ctx.db.collection(COLL_ANALYSIS as any);
        const rdocPid = this.rdoc.pid;
        const rdocDomainId = this.rdoc.domainId;
        const uid = this.user._id;

        // Run streamer in background (post() returns, framework hands off to Koa)
        (async () => {
            let fullText = '';
            let reasoningText = '';
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
                    await refundCredit();
                    stream.end();
                    return;
                }

                // Parse SSE from provider
                const reader = (resp.body as any).getReader();
                const decoder = new TextDecoder('utf-8');
                let buf = '';
                let sawDone = false;
                let finishReason = '';
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
                        if (!data) continue;
                        if (data === '[DONE]') {
                            sawDone = true;
                            continue;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0] || {};
                            if (choice.finish_reason) finishReason = choice.finish_reason;
                            const delta = choice.delta?.content;
                            const rdelta = choice.delta?.reasoning_content;
                            if (delta) {
                                fullText += delta;
                                send({ type: 'chunk', content: delta });
                            }
                            if (rdelta) {
                                reasoningText += rdelta;
                            }
                        } catch { /* ignore malformed SSE line */ }
                    }
                }

                // If we got zero content, use reasoning_text as fallback
                // (deepseek-v4-flash may consume all max_tokens on reasoning)
                if (!fullText.trim()) {
                    if (reasoningText.trim()) {
                        fullText = reasoningText;
                        finishReason = finishReason || 'length';
                        send({ type: 'chunk', content: '\n\n[注意：AI 的正式回复被截断了，以下为推理过程，仅供参考]\n\n' });
                        send({ type: 'chunk', content: reasoningText });
                    } else {
                        send({ type: 'error', error: 'AI 返回为空，已退回积分。' });
                        await refundCredit();
                        stream.end();
                        return;
                    }
                }

                const durationMs = Date.now() - startTime;
                const interrupted = !sawDone || finishReason === 'length';
                // Read the existing doc to preserve its content in the history array.
                const existingDoc = await analysisColl.findOne({ _id: rid }) as any;
                const existingHistory: any[] = existingDoc?.history || [];
                if (existingDoc?.content) {
                    existingHistory.push({
                        content: existingDoc.content,
                        model: existingDoc.model,
                        promptText: existingDoc.promptText,
                        durationMs: existingDoc.durationMs,
                        createdAt: existingDoc.createdAt,
                        monthKey: existingDoc.monthKey,
                        questionFocus: existingDoc.questionFocus,
                        questionFocusLabel: existingDoc.questionFocusLabel,
                        studentNote: existingDoc.studentNote,
                        interrupted: existingDoc.interrupted,
                        finishReason: existingDoc.finishReason,
                        dialogue: existingDoc.dialogue || [],
                    });
                }
                await analysisColl.replaceOne(
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
                        questionFocus,
                        questionFocusLabel,
                        studentNote,
                        dialogue: [],
                        interrupted,
                        finishReason,
                        history: existingHistory,
                    },
                    { upsert: true },
                );
                if (interrupted) {
                    await refundCredit();
                    const balDoc = await balanceColl.findOne(creditQuery(rdocDomainId, uid));
                    send({
                        type: 'done',
                        interrupted: true,
                        finishReason,
                        durationMs,
                        balance: (balDoc as any)?.balance ?? 0,
                        monthlyUsed,
                        monthlyCap,
                    });
                    stream.end();
                    return;
                }
                // Append usage log (monthly cap counts these — re-analyze adds a new entry)
                const usageId = new ObjectId();
                await usageColl.insertOne({
                    _id: usageId,
                    uid,
                    rid,
                    pid: rdocPid,
                    domainId: rdocDomainId,
                    monthKey: monthKey(),
                    at: new Date(),
                    creditsCost: 1,
                    model,
                    durationMs,
                } as any);
                await this.ctx.db.collection(COLL_CREDIT_LEDGER as any).updateOne(
                    { _id: deduction.ledgerId },
                    { $set: { refType: 'usage', refId: usageId } },
                ).catch(() => { /* ledger is best-effort */ });

                // Read fresh balance + monthly used to push to client
                const [balDoc, monthlyAfter] = await Promise.all([
                    balanceColl.findOne(creditQuery(rdocDomainId, uid)),
                    usageColl.countDocuments({ uid, domainId: rdocDomainId, monthKey: monthKey() }),
                ]);
                send({
                    type: 'done',
                    durationMs,
                    balance: (balDoc as any)?.balance ?? 0,
                    monthlyUsed: monthlyAfter,
                    monthlyCap,
                });
                stream.end();
            } catch (err: any) {
                send({ type: 'error', error: err?.message || String(err) });
                await refundCredit();
                try { stream.end(); } catch { /* */ }
            } finally {
                clearTimeout(timer);
            }
        })();
    }

    // POST operation=reflect — student writes their thought after seeing AI's analysis;
    // AI responds with a short follow-up. Free (no credit / no monthly slot cost),
    // but limited to ONE reflection per analysis to prevent abuse.
    @param('rid', Types.ObjectId)
    @param('reflection', Types.String)
    async postReflect(domainId: string, rid: ObjectId, reflection: string) {
        if (!this.aiEnabled) {
            this.response.body = { error: '老师已关闭你在当前域的 AI 刷题建议功能。' };
            this.response.status = 403;
            return;
        }

        reflection = (reflection || '').trim();
        if (!reflection) {
            this.response.body = { error: '请先写一点你的想法再提交。' };
            this.response.status = 400;
            return;
        }
        if (reflection.length > 500) {
            this.response.body = { error: '反思请控制在 500 字以内。' };
            this.response.status = 400;
            return;
        }

        const analysisColl = this.ctx.db.collection(COLL_ANALYSIS as any);
        const saved = await analysisColl.findOne({ _id: rid }) as any;
        if (!saved) {
            this.response.body = { error: '请先点击"开始分析"获取 AI 主回复，再写反思。' };
            this.response.status = 400;
            return;
        }
        const dialogue: any[] = saved.dialogue || [];
        if (dialogue.some((m) => m.role === 'student')) {
            this.response.body = { error: '已经写过一次反思了。重新分析才能再写。' };
            this.response.status = 400;
            return;
        }

        const provider = await resolveProvider(this.ctx, this.rdoc.domainId);
        if (!provider.apiKey) {
            this.response.body = { error: 'AI 服务尚未配置 API Key。请老师在当前域的 AI 刷题管理页填写接口配置。' };
            this.response.status = 503;
            return;
        }
        const { baseUrl, model, apiKey } = provider;
        const temperature = cfgNumber('temperature', 0.7);
        const timeoutMs = cfgNumber('timeoutMs', 60000);
        const systemPrompt = cfg<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);

        // Persist student message immediately (so admins see what the student typed
        // even if the AI follow-up later fails)
        const studentMsg = { role: 'student', text: reflection, at: new Date() };
        await analysisColl.updateOne({ _id: rid }, { $push: { dialogue: studentMsg } } as any);

        // Build follow-up prompt: AI is told this is a follow-up & must stay short
        const followUpSys = `${systemPrompt}

【现在是对话的第二轮】
学生看了你的第一轮分析后，写了一段反思（在下面 user 消息里）告诉你他打算怎么改。请用 50–120 字之间简短回复：
- 如果他思路对：先肯定，再给一个继续往前一小步的小提示
- 如果思路不对：温柔指出方向偏了，反问引导（不给代码）
- 结尾用一句"试试看再来"之类的行动鼓励
- 仍然遵守第一轮的所有铁律：不给代码、不报算法名、用比喻和小学生的话`;

        const followUpUser = `【AI 教练第一轮回复】\n${saved.content}\n\n【学生的反思】\n${reflection}`;

        // SSE setup (same pattern as postStart)
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
        this.request.websocket = true;
        ctx.status = 200;
        ctx.body = stream;

        const send = (obj: any) => {
            try { stream.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* */ }
        };

        const startTime = Date.now();
        const aborter = new AbortController();
        const timer = setTimeout(() => aborter.abort(), timeoutMs);

        (async () => {
            let fullText = '';
            try {
                const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model,
                        messages: [
                            { role: 'system', content: followUpSys },
                            { role: 'user', content: followUpUser },
                        ],
                        stream: true,
                        temperature,
                        max_tokens: 400,  // follow-up is short
                    }),
                    signal: aborter.signal,
                });
                if (!resp.ok || !resp.body) {
                    send({ type: 'error', error: `AI 服务异常 (${resp.status})` });
                    stream.end();
                    return;
                }
                const reader = (resp.body as any).getReader();
                const decoder = new TextDecoder('utf-8');
                let buf = '';
                let sawDone = false;
                let finishReason = '';
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
                        if (!data) continue;
                        if (data === '[DONE]') {
                            sawDone = true;
                            continue;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0] || {};
                            if (choice.finish_reason) finishReason = choice.finish_reason;
                            const delta = choice.delta?.content;
                            if (delta) {
                                fullText += delta;
                                send({ type: 'chunk', content: delta });
                            }
                        } catch { /* */ }
                    }
                }
                if (fullText.trim()) {
                    const interrupted = !sawDone || finishReason === 'length';
                    await analysisColl.updateOne(
                        { _id: rid },
                        {
                            $push: {
                                dialogue: {
                                    role: 'tutor',
                                    text: fullText,
                                    at: new Date(),
                                    model,
                                    durationMs: Date.now() - startTime,
                                    interrupted,
                                    finishReason,
                                },
                            },
                        } as any,
                    );
                    if (interrupted) {
                        send({
                            type: 'done',
                            interrupted: true,
                            scope: 'reflection',
                            finishReason,
                            durationMs: Date.now() - startTime,
                        });
                        stream.end();
                        return;
                    }
                }
                send({ type: 'done', durationMs: Date.now() - startTime });
                stream.end();
            } catch (err: any) {
                send({ type: 'error', error: err?.message || String(err) });
                try { stream.end(); } catch { /* */ }
            } finally {
                clearTimeout(timer);
            }
        })();
    }

    @param('rid', Types.ObjectId)
    async postRegenerateReflect(domainId: string, rid: ObjectId) {
        if (!this.aiEnabled) {
            this.response.body = { error: '老师已关闭你在当前域的 AI 刷题建议功能。' };
            this.response.status = 403;
            return;
        }

        const analysisColl = this.ctx.db.collection(COLL_ANALYSIS as any);
        const saved = await analysisColl.findOne({ _id: rid }) as any;
        if (!saved) {
            this.response.body = { error: '请先点击"开始分析"获取 AI 主回复。' };
            this.response.status = 400;
            return;
        }
        const dialogue: any[] = saved.dialogue || [];
        const studentMsg = dialogue.find((m) => m.role === 'student');
        const hasInterruptedTutor = dialogue.some((m) => m.role === 'tutor' && (m.interrupted || looksInterruptedReply(m.text)));
        if (!studentMsg || !hasInterruptedTutor) {
            this.response.body = { error: '没有需要重新生成的中断回复。' };
            this.response.status = 400;
            return;
        }

        const provider = await resolveProvider(this.ctx, this.rdoc.domainId);
        if (!provider.apiKey) {
            this.response.body = { error: 'AI 服务尚未配置 API Key。请老师在当前域的 AI 刷题管理页填写接口配置。' };
            this.response.status = 503;
            return;
        }
        const { baseUrl, model, apiKey } = provider;
        const temperature = cfgNumber('temperature', 0.7);
        const timeoutMs = cfgNumber('timeoutMs', 60000);
        const systemPrompt = cfg<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);
        const followUpSys = `${systemPrompt}

【现在是对话的第二轮】
学生看了你的第一轮分析后，写了一段反思（在下面 user 消息里）告诉你他打算怎么改。请用 50–120 字之间简短回复：
- 如果他思路对：先肯定，再给一个继续往前一小步的小提示
- 如果思路不对：温柔指出方向偏了，反问引导（不给代码）
- 结尾用一句"试试看再来"之类的行动鼓励
- 仍然遵守第一轮的所有铁律：不给代码、不报算法名、用比喻和小学生的话`;

        const followUpUser = `【AI 教练第一轮回复】\n${saved.content}\n\n【学生的反思】\n${studentMsg.text || ''}`;

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
        this.request.websocket = true;
        ctx.status = 200;
        ctx.body = stream;

        const send = (obj: any) => {
            try { stream.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* */ }
        };
        const startTime = Date.now();
        const aborter = new AbortController();
        const timer = setTimeout(() => aborter.abort(), timeoutMs);

        (async () => {
            let fullText = '';
            try {
                const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model,
                        messages: [
                            { role: 'system', content: followUpSys },
                            { role: 'user', content: followUpUser },
                        ],
                        stream: true,
                        temperature,
                        max_tokens: 400,
                    }),
                    signal: aborter.signal,
                });
                if (!resp.ok || !resp.body) {
                    send({ type: 'error', error: `AI 服务异常 (${resp.status})` });
                    stream.end();
                    return;
                }
                const reader = (resp.body as any).getReader();
                const decoder = new TextDecoder('utf-8');
                let buf = '';
                let sawDone = false;
                let finishReason = '';
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
                        if (!data) continue;
                        if (data === '[DONE]') {
                            sawDone = true;
                            continue;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0] || {};
                            if (choice.finish_reason) finishReason = choice.finish_reason;
                            const delta = choice.delta?.content;
                            if (delta) {
                                fullText += delta;
                                send({ type: 'chunk', content: delta });
                            }
                        } catch { /* */ }
                    }
                }
                if (fullText.trim()) {
                    const interrupted = !sawDone || finishReason === 'length';
                    const nextDialogue = dialogue
                        .filter((m) => !(m.role === 'tutor' && (m.interrupted || looksInterruptedReply(m.text))))
                        .concat([{
                            role: 'tutor',
                            text: fullText,
                            at: new Date(),
                            model,
                            durationMs: Date.now() - startTime,
                            interrupted,
                            finishReason,
                        }]);
                    await analysisColl.updateOne({ _id: rid }, { $set: { dialogue: nextDialogue } } as any);
                    send({
                        type: 'done',
                        interrupted,
                        scope: 'reflection',
                        finishReason,
                        durationMs: Date.now() - startTime,
                    });
                    stream.end();
                    return;
                }
                send({ type: 'error', error: 'AI 返回为空。' });
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

export class AiSuggestionAvailabilityHandler extends Handler {
    @param('rid', Types.ObjectId)
    async get(domainId: string, rid: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const RecordModel = global.Hydro.model.record;
        const ProblemModel = global.Hydro.model.problem;
        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc) throw new NotFoundError(rid);
        const isOwner = rdoc.uid === this.user._id;
        const canRead = this.user.hasPerm(PERM.PERM_READ_RECORD_CODE);
        if (!isOwner && !canRead) throw new PermissionError(PERM.PERM_READ_RECORD_CODE);
        const pdoc = await ProblemModel.get(rdoc.domainId, rdoc.pid);
        const access = await this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({
            domainId: rdoc.domainId,
            uid: rdoc.uid,
        }) as AiDomainAccessDoc | null;
        const aiEnabled = !!access?.enabled;
        this.response.body = {
            ok: !!pdoc && !isObjectiveProblem(pdoc) && aiEnabled,
            objective: isObjectiveProblem(pdoc),
            enabled: aiEnabled,
        };
    }
}
