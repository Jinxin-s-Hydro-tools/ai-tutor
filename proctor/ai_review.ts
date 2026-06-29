import { Context, ObjectId } from 'hydrooj';

import { extractChatContent } from '../difficulty';
import { cfgNumber, resolveProvider, truncate } from '../utils';
import { effectiveCodeLines, extractStyleFingerprint } from './fingerprint';

function compactDate(value: any) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function safeJson(value: any, maxChars = 24000) {
    return truncate(JSON.stringify(value, null, 2), maxChars);
}

function normalizeEvent(event: any) {
    return {
        type: event.type,
        ts: compactDate(event.ts),
        meta: event.meta || {},
    };
}

function normalizeEvidence(item: any) {
    return {
        factor: item.factor,
        name: item.name,
        score: item.score,
        weight: item.weight,
        value: item.value,
        inputs: item.inputs,
        formula: item.formula,
        threshold: item.threshold,
        reason: item.reason,
    };
}

async function loadHistorySamples(domainId: string, uid: number, tid: any, before: Date, maxCodeChars: number) {
    const RecordModel = global.Hydro.model.record;
    const rows = await RecordModel.coll.find({
        domainId,
        uid,
        status: 1,
        code: { $exists: true, $ne: '' },
        contest: { $ne: tid },
        _id: { $lt: ObjectId.createFromTime(Math.floor(before.getTime() / 1000)) },
    }).sort({ _id: -1 }).limit(8).project({
        _id: 1,
        pid: 1,
        contest: 1,
        code: 1,
        lang: 1,
    }).toArray();
    return rows.map((row: any) => {
        const code = String(row.code || '');
        return {
            rid: row._id?.toHexString?.() || String(row._id || ''),
            pid: row.pid,
            lang: row.lang || '',
            lines: effectiveCodeLines(code),
            fingerprint: extractStyleFingerprint(code),
            code: truncate(code, Math.max(400, Math.floor(maxCodeChars / 3))),
        };
    });
}

export async function generateProctorAiReview(ctx: Context, options: {
    session: any;
    tdoc: any;
    pdoc: any;
    student: any;
    events: any[];
    comparison: any[];
    operatorUid: number;
    onChunk?: (chunk: string) => void;
}) {
    const {
        session, tdoc, pdoc, student, events, comparison, operatorUid, onChunk,
    } = options;
    const provider = await resolveProvider(ctx, session.domainId);
    if (!provider.apiKey) throw new Error('AI 服务尚未配置 API Key。请在当前域的 AI 刷题管理页填写接口配置。');
    if (provider.providerKey === 'custom' && (!provider.baseUrl || !provider.model)) {
        throw new Error('自定义提供方需要同时填写 Base URL 与模型名称。');
    }

    const maxCodeChars = Math.max(1200, Math.trunc(cfgNumber('maxCodeChars', 3000)));
    const maxTokens = Math.trunc(cfgNumber('maxTokens', 2048));
    const timeoutMs = cfgNumber('timeoutMs', 60000);
    const startedAt = session.startedAt ? new Date(session.startedAt) : new Date();
    const latestCode = String(session.latestCode || [...(session.pastes || [])].reverse().find((p: any) => p?.text)?.text || '');
    const historySamples = await loadHistorySamples(session.domainId, session.uid, session.tid, startedAt, maxCodeChars);
    const latestSubmission = [...(session.submissions || [])]
        .sort((a: any, b: any) => Number(b?.ts || 0) - Number(a?.ts || 0))[0];

    const localData = {
        reviewPurpose: 'AI 只做教师复核辅助，不做最终作弊判定。',
        student: {
            uid: session.uid,
            uname: student?.uname || '',
            displayName: student?.displayName || student?.uname || '',
        },
        source: {
            domainId: session.domainId,
            type: tdoc?.rule === 'homework' ? 'homework' : 'contest',
            tid: session.tid?.toHexString?.() || String(session.tid || ''),
            title: tdoc?.title || '',
        },
        problem: {
            pid: pdoc?.pid || session.pid,
            docId: pdoc?.docId || session.pid,
            title: pdoc?.title || '',
            tags: pdoc?.tag || [],
            nSubmit: pdoc?.nSubmit ?? pdoc?.stats?.nSubmit ?? null,
            nAccept: pdoc?.nAccept ?? pdoc?.stats?.nAccept ?? null,
            content: truncate(pdoc?.content || '', Math.max(1200, Math.trunc(cfgNumber('maxProblemChars', 4000) / 2))),
        },
        session: {
            sid: session._id?.toHexString?.() || String(session._id || ''),
            startedAt: compactDate(session.startedAt),
            lastEventAt: compactDate(session.lastEventAt),
            tInProblemActive: session.tInProblemActive || 0,
            tAwayTotal: session.tAwayTotal || 0,
            flags: session.flags || [],
            score: session.score?.total || 0,
            severity: session.score?.severity || '',
        },
        evidence: (session.score?.breakdown || []).map(normalizeEvidence),
        submissions: (session.submissions || []).map((item: any) => ({
            rid: item.rid?.toHexString?.() || String(item.rid || ''),
            ts: compactDate(item.ts),
            status: item.status,
            isFirstAttempt: !!item.isFirstAttempt,
            keystrokesSinceLastPaste: item.keystrokesSinceLastPaste ?? null,
            msSinceLastPaste: item.msSinceLastPaste ?? null,
        })),
        latestSubmission: latestSubmission ? {
            rid: latestSubmission.rid?.toHexString?.() || String(latestSubmission.rid || ''),
            status: latestSubmission.status,
            isFirstAttempt: !!latestSubmission.isFirstAttempt,
        } : null,
        pastes: (session.pastes || []).map((paste: any) => ({
            ts: compactDate(paste.ts),
            lines: paste.lines,
            length: paste.length,
            inferredFromSubmission: !!paste.inferredFromSubmission,
            awaySinceSessionStart: paste.awaySinceSessionStart,
            activeSinceSessionStart: paste.activeSinceSessionStart,
            fingerprint: paste.fingerprint,
            text: truncate(paste.text || '', 1200),
        })),
        events: events.slice(-200).map(normalizeEvent),
        comparison: comparison.slice(0, 12).map((row: any) => ({
            uid: row.uid,
            pid: row.pid,
            total: row.total,
            severity: row.severity,
            codingRate: row.codingRate,
            styleFlips: row.styleFlips,
        })),
        currentCode: {
            lines: effectiveCodeLines(latestCode),
            fingerprint: extractStyleFingerprint(latestCode),
            code: truncate(latestCode, maxCodeChars),
        },
        historyAcceptedSamples: historySamples,
    };

    const systemPrompt = `你是一个严谨的 OI/NOIP 教学风控复核助手。你的任务是帮助老师复核“学生是否可能借助网页 AI 或外部生成代码”，但不能做最终作弊裁决。

请遵守：
1. 只依据用户提供的本地证据分析，不要编造事实。
2. 明确区分“强证据”“弱线索”“无法判断”。
3. 不能输出“确定作弊”，只能给出复核建议和需要人工确认的问题。
4. 对未采集到真实 paste/离开/按键事件的老数据，要主动说明行为证据不足。
5. 输出中文，结构清晰，给老师可执行的核查建议。`;

    const userPrompt = `请复核下面这个 AI 可疑度 Session。本地数据已尽量完整提供，部分长文本有截断标记。

请按以下格式输出：
## 复核结论
用“低 / 中 / 高”给出辅助风险等级，并用一句话说明。

## 关键依据
列出 3-6 条，标注强/中/弱。

## 可能误报原因
列出需要老师排除的因素。

## 建议老师追问
给 2-4 个适合当面询问学生的问题。

## 备注
说明哪些证据缺失或只能作为线索。

本地数据 JSON：
${safeJson(localData)}`;

    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), timeoutMs);
    const start = Date.now();
    try {
        const resp = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
                model: provider.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: !!onChunk,
                temperature: 0.2,
                max_tokens: maxTokens,
            }),
            signal: aborter.signal,
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`AI 服务异常 (${resp.status})：${errText.slice(0, 200)}`);
        }
        let text = '';
        let finishReason = '';
        let sawDone = !onChunk;
        if (onChunk) {
            if (!resp.body) throw new Error('AI 服务未返回可读取的流。');
            const reader = (resp.body as any).getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '';
            let reasoningText = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const raw = trimmed.slice(5).trim();
                    if (!raw) continue;
                    if (raw === '[DONE]') {
                        sawDone = true;
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(raw);
                        const choice = parsed.choices?.[0] || {};
                        if (choice.finish_reason) finishReason = choice.finish_reason;
                        const delta = choice.delta?.content || '';
                        const reasoningDelta = choice.delta?.reasoning_content || '';
                        if (delta) {
                            text += delta;
                            onChunk(delta);
                        }
                        if (reasoningDelta) reasoningText += reasoningDelta;
                    } catch { /* ignore malformed SSE lines */ }
                }
            }
            if (!text.trim() && reasoningText.trim()) {
                text = reasoningText;
                onChunk(reasoningText);
            }
        } else {
            const data = await resp.json();
            const result = extractChatContent(data);
            text = result.text;
            finishReason = result.finishReason;
        }
        if (!text.trim()) throw new Error(`AI 返回为空${finishReason ? `（${finishReason}）` : ''}。`);
        const interrupted = !sawDone || finishReason === 'length';
        return {
            content: text.trim(),
            model: provider.model,
            providerKey: provider.providerKey,
            promptText: `【System Prompt】\n${systemPrompt}\n\n【User Prompt】\n${userPrompt}`,
            durationMs: Date.now() - start,
            finishReason,
            interrupted,
            createdAt: new Date(),
            operatorUid,
        };
    } finally {
        clearTimeout(timer);
    }
}
