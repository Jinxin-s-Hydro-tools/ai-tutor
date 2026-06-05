import { Context } from 'hydrooj';

import { DifficultyScanArgs, DifficultyScore } from './types';
import { cfg, resolveProvider, truncate } from './utils';

export function normalizeDifficulty(n: any): number | null {
    const value = Math.round(Number(n));
    if (!Number.isFinite(value)) return null;
    if (value < 1 || value > 10) return null;
    return value;
}

export function parseDifficultyScore(text: string): DifficultyScore {
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
    try {
        const parsed = JSON.parse(jsonText);
        const difficulty = normalizeDifficulty(parsed.difficulty ?? parsed.score);
        if (difficulty) return { difficulty, reason: String(parsed.reason || '').slice(0, 160) };
    } catch { /* fall through */ }
    const difficulty = normalizeDifficulty(text.match(/\b([1-9]|10)\b/)?.[1]);
    if (!difficulty) throw new Error(`AI 返回中没有合法难度：${text.slice(0, 200)}`);
    return { difficulty, reason: 'AI 未返回标准 JSON，已从文本中提取难度。' };
}

export function extractChatContent(data: any): { text: string; finishReason: string } {
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    const text = [
        message.content,
        message.reasoning_content,
        choice.text,
        data?.output_text,
    ].filter((i) => typeof i === 'string' && i.trim()).join('\n');
    return {
        text,
        finishReason: choice.finish_reason || data?.finish_reason || '',
    };
}

export async function scoreProblemDifficulty(ctx: Context, pdoc: any): Promise<DifficultyScore> {
    const { baseUrl, model, apiKey } = await resolveProvider(ctx, pdoc.domainId);
    if (!baseUrl || !model || !apiKey) {
        throw new Error(`AI provider 未配置完整，请检查域 ${pdoc.domainId} 的 AI 刷题管理配置。`);
    }
    const maxProblem = cfg<number>('maxProblemChars', 4000);
    const timeoutMs = cfg<number>('timeoutMs', 60000);
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), timeoutMs);
    const prompt = `请作为信息学竞赛教练，为下面 HydroOJ 题目评估难度。

评分范围：1 到 10 的整数。
1=入门语法/简单输入输出，2=基础分支循环，3=基础数组/字符串，4=简单模拟/枚举，5=较复杂模拟或基础算法，6=常见算法综合，7=较难算法与实现，8=高阶算法，9=省选级难题，10=非常困难。

只允许输出 JSON，不要 Markdown，不要代码块：
{"difficulty": 数字, "reason": "20字以内中文理由"}

题目标题：${pdoc.title || ''}
题目标签：${Array.isArray(pdoc.tag) ? pdoc.tag.join(', ') : ''}
提交/通过：${pdoc.nSubmit || 0}/${pdoc.nAccept || 0}
题面：
${truncate(pdoc.content || '', maxProblem)}`;

    let lastEmptyReason = '';
    try {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: '你是严谨的信息学竞赛题目难度评估助手，只输出可解析 JSON。' },
                        { role: 'user', content: prompt },
                    ],
                    stream: false,
                    temperature: 0.2,
                    max_tokens: 120,
                }),
                signal: aborter.signal,
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`AI 服务异常 (${resp.status})：${errText.slice(0, 200)}`);
            }
            const data = await resp.json();
            const { text, finishReason } = extractChatContent(data);
            if (text.trim()) return parseDifficultyScore(text);
            lastEmptyReason = finishReason ? `finish_reason=${finishReason}` : '无 finish_reason';
            await new Promise((resolve) => setTimeout(resolve, attempt * 600));
        }
        throw new Error(`AI 连续 3 次返回为空（${lastEmptyReason}）。`);
    } finally {
        clearTimeout(timer);
    }
}

export async function runDifficultyScan(ctx: Context, rawArgs: DifficultyScanArgs = {}, report: Function) {
    const ProblemModel = global.Hydro.model.problem;
    const documentModel = global.Hydro.model.document;
    const args = rawArgs || {};
    const limit = Math.max(0, Math.min(Number(args.limit ?? 50) || 0, 1000));
    const domainIds = Array.isArray(args.domainId)
        ? args.domainId.filter(Boolean)
        : (args.domainId ? [args.domainId] : []);
    const query: any = { docType: documentModel.TYPE_PROBLEM };
    if (domainIds.length) query.domainId = { $in: domainIds };
    if (!args.overwrite) query.$or = [{ difficulty: { $exists: false } }, { difficulty: 0 }, { difficulty: null }];
    if (!args.includeHidden) query.hidden = { $ne: true };

    const cursor = ctx.db.collection('document' as any)
        .find(query)
        .project({
            domainId: 1,
            docId: 1,
            pid: 1,
            title: 1,
            content: 1,
            tag: 1,
            nSubmit: 1,
            nAccept: 1,
            difficulty: 1,
            hidden: 1,
            sort: 1,
        })
        .sort({ domainId: 1, sort: 1, docId: 1 });
    if (limit > 0) cursor.limit(limit);

    let scanned = 0;
    let updated = 0;
    let failed = 0;
    for await (const pdoc of cursor) {
        scanned++;
        const displayPid = pdoc.pid || pdoc.docId;
        report({ message: `正在评估 ${pdoc.domainId}/${displayPid} ${pdoc.title || ''} (${scanned}${limit ? `/${limit}` : ''})` });
        try {
            const score = await scoreProblemDifficulty(ctx, pdoc);
            if (!args.dryRun) {
                await ProblemModel.edit(pdoc.domainId, pdoc.docId, { difficulty: score.difficulty });
                updated++;
            }
            report({ message: `${args.dryRun ? '[dry-run] ' : ''}${pdoc.domainId}/${displayPid}: difficulty=${score.difficulty} ${score.reason}` });
        } catch (e: any) {
            failed++;
            report({ message: `${pdoc.domainId}/${displayPid} 评估失败：${e?.message || e}` });
        }
    }
    return {
        scanned,
        updated,
        failed,
        dryRun: !!args.dryRun,
        overwrite: !!args.overwrite,
        includeHidden: !!args.includeHidden,
        domainId: domainIds.length ? domainIds : 'all',
        limit,
    };
}

export function validateDifficultyScanArgs(args: any): DifficultyScanArgs {
    if (args === undefined || args === null || args === '') return {};
    if (typeof args === 'string') return { domainId: args };
    if (typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('参数必须是 JSON 对象，例如 {"domainId":"system","limit":50}');
    }
    return {
        domainId: args.domainId,
        limit: args.limit === undefined ? undefined : Number(args.limit),
        overwrite: !!args.overwrite,
        includeHidden: !!args.includeHidden,
        dryRun: !!args.dryRun,
    };
}
