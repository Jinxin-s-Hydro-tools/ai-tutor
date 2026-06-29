import {
    baselineFingerprint, extractStyleFingerprint, fingerprintFlips, StyleFingerprint,
} from './fingerprint';

export interface EvidenceItem {
    factor: string;
    name: string;
    inputs: Record<string, any>;
    formula: string;
    value: number | string;
    threshold: Record<string, any>;
    score: number;
    weight: number;
    reason: string;
    severity: 'none' | 'low' | 'medium' | 'high';
}

function round(value: number, digits = 3) {
    const n = 10 ** digits;
    return Math.round(value * n) / n;
}

function linear(x: number, x0: number, x1: number, y0: number, y1: number) {
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

function evidenceSeverity(score: number, weight: number): EvidenceItem['severity'] {
    if (score <= 0) return 'none';
    const ratio = score / Math.max(weight, 1);
    if (ratio >= 0.75) return 'high';
    if (ratio >= 0.4) return 'medium';
    return 'low';
}

function getAcceptRate(pdoc: any) {
    const nSubmit = Number(pdoc?.nSubmit ?? pdoc?.stats?.nSubmit ?? pdoc?.stats?.submit ?? 0);
    const nAccept = Number(pdoc?.nAccept ?? pdoc?.stats?.nAccept ?? pdoc?.stats?.accept ?? 0);
    if (!Number.isFinite(nSubmit) || nSubmit <= 0) return null;
    if (!Number.isFinite(nAccept) || nAccept < 0) return null;
    return {
        nSubmit,
        nAccept,
        acceptRate: nAccept / nSubmit,
    };
}

function latestSubmission(session: any) {
    return [...(session?.submissions || [])].sort((a: any, b: any) => Number(b?.ts || 0) - Number(a?.ts || 0))[0];
}

function largestPaste(session: any, includeInferred = false) {
    return [...(session?.pastes || [])]
        .filter((paste: any) => includeInferred || !paste?.inferredFromSubmission)
        .sort((a: any, b: any) => Number(b?.lines || 0) - Number(a?.lines || 0))[0];
}

function levenshteinBounded(a = '', b = '', limit = 20000) {
    if (a.length > limit) a = a.slice(0, limit);
    if (b.length > limit) b = b.slice(0, limit);
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    const curr = new Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
}

function textSimilarity(a = '', b = '') {
    const maxLen = Math.max(a.length, b.length, 1);
    return 1 - (levenshteinBounded(a, b) / maxLen);
}

function scoreCodingRate(session: any): EvidenceItem {
    const paste = largestPaste(session);
    const lines = Number(paste?.lines || 0);
    const away = Number(paste?.awaySinceSessionStart ?? session?.tAwayTotal ?? 0);
    let score = 0;
    const rate = lines / Math.max(away, 1);
    if (lines >= 10) {
        if (away < 30 && lines > 20) score = 30;
        else if (rate < 0.10) score = 0;
        else if (rate < 0.20) score = linear(rate, 0.10, 0.20, 0, 10);
        else if (rate < 0.40) score = linear(rate, 0.20, 0.40, 10, 30);
        else score = 30;
    }
    score = round(Math.min(30, Math.max(0, score)), 1);
    return {
        factor: 'coding_rate',
        name: 'F1 · 编码速率异常',
        inputs: { L_paste: lines, T_away_total: away },
        formula: `rate = L_paste / max(T_away_total, 1) = ${lines} / ${Math.max(away, 1)}`,
        value: round(rate),
        threshold: { skip: 'L_paste < 10', full: 'T_away_total < 30s && L_paste > 20 OR rate >= 0.40' },
        score,
        weight: 30,
        reason: lines < 10
            ? '粘贴有效代码少于 10 行，跳过编码速率判断。'
            : `粘贴 ${lines} 行，有效离开时长 ${away} 秒，编码速率 ${round(rate)} 行/秒。`,
        severity: evidenceSeverity(score, 30),
    };
}

function scoreThinking(session: any): EvidenceItem {
    const paste = largestPaste(session);
    const lines = Number(paste?.lines || 0);
    const active = Number(paste?.activeSinceSessionStart ?? session?.tInProblemActive ?? 0);
    const value = lines > 0 ? active / lines : 0;
    let score = 0;
    if (lines >= 10) {
        if (value >= 10) score = 0;
        else if (value >= 5) score = linear(value, 10, 5, 0, 5);
        else if (value >= 2) score = linear(value, 5, 2, 5, 10);
        else if (value >= 1) score = linear(value, 2, 1, 10, 13);
        else score = 15;
    }
    score = round(Math.min(15, Math.max(0, score)), 1);
    return {
        factor: 'insufficient_thinking',
        name: 'F2 · 思考时间不足',
        inputs: { T_in_problem_active: active, L_paste: lines },
        formula: `thinking_per_line = T_in_problem_active / L_paste = ${active} / ${Math.max(lines, 1)}`,
        value: round(value),
        threshold: { noScore: '>= 10 秒/行', full: '< 1 秒/行' },
        score,
        weight: 15,
        reason: lines < 10
            ? '粘贴有效代码少于 10 行，跳过思考时间判断。'
            : `浏览器内活跃 ${active} 秒，对应 ${lines} 行代码，平均 ${round(value)} 秒/行。`,
        severity: evidenceSeverity(score, 15),
    };
}

function scoreStyle(session: any, historyFingerprints: StyleFingerprint[]): EvidenceItem {
    const paste = largestPaste(session, true);
    const code = paste?.text || session?.latestCode || '';
    const current = paste?.fingerprint || extractStyleFingerprint(code);
    const baseline = baselineFingerprint(historyFingerprints);
    if (!baseline || historyFingerprints.length < 5) {
        return {
            factor: 'style_anomaly',
            name: 'F3 · 风格突变',
            inputs: { historyLength: historyFingerprints.length },
            formula: 'history.length < 5 -> skip',
            value: 'baseline_insufficient',
            threshold: { skip: 'history.length < 5' },
            score: 0,
            weight: 20,
            reason: '历史 AC 样本不足 5 次，无法建立学生风格基线。',
            severity: 'none',
        };
    }
    const flips = fingerprintFlips(current, baseline);
    const weights: Record<string, number> = {
        uses_std_qualifier: 3,
        has_doc_comments: 4,
        consistent_indent: 2,
        long_var_names: 4,
        uses_advanced_stl: 5,
        has_helper_functions: 5,
        uses_const_ref_params: 4,
        uses_range_for: 4,
        uses_cstyle_cast: 2,
        uses_string_methods: 3,
    };
    const weightedFlips = flips
        .filter((flip) => flip.after === true)
        .map((flip) => ({ ...flip, weight: weights[flip.key] || 2 }));
    const score = Math.min(20, weightedFlips.reduce((sum, flip) => sum + flip.weight, 0));
    const flipCount = flips.length;
    return {
        factor: 'style_anomaly',
        name: 'F3 · 风格突变',
        inputs: {
            historyLength: historyFingerprints.length,
            current,
            baseline,
            flips,
            weightedFlips,
        },
        formula: 'score = min(20, sum(weighted positive style flips))',
        value: `${flipCount} flips / ${score} weighted points`,
        threshold: {
            lowWeight: 'consistent_indent=2, cstyle_cast=2',
            mediumWeight: 'std::=3, string_methods=3, doc_comments/long_names/const_ref/range_for=4',
            highWeight: 'advanced_stl/helper_functions=5',
        },
        score,
        weight: 20,
        reason: flipCount
            ? `本次代码有 ${flipCount} 项风格特征相对历史基线翻转，其中结构性正向翻转累计 ${score} 分。`
            : '本次代码风格与历史基线一致。',
        severity: evidenceSeverity(score, 20),
    };
}

function scoreFirstAttemptAc(session: any, pdoc: any): EvidenceItem {
    const submission = (session?.submissions || []).find((s: any) => s?.isFirstAttempt && Number(s?.status) === 1);
    const rateInfo = getAcceptRate(pdoc);
    let score = 0;
    if (submission) {
        const rate = rateInfo?.acceptRate;
        if (rate == null) score = 0;
        else if (rate >= 0.60) score = 0;
        else if (rate >= 0.40) score = 3;
        else if (rate >= 0.25) score = 6;
        else if (rate >= 0.10) score = 8;
        else score = 10;
    }
    return {
        factor: 'first_attempt_ac',
        name: 'F4 · 一击 AC',
        inputs: {
            is_first_attempt: !!submission,
            nSubmit: rateInfo?.nSubmit ?? null,
            nAccept: rateInfo?.nAccept ?? null,
            acceptRate: rateInfo?.acceptRate == null ? null : round(rateInfo.acceptRate, 4),
        },
        formula: 'first_attempt_ac && accept_rate bucket',
        value: score,
        threshold: {
            '>=60%': 0,
            '40%-60%': 3,
            '25%-40%': 6,
            '10%-25%': 8,
            '<10%': 10,
        },
        score,
        weight: 10,
        reason: submission
            ? (rateInfo
                ? `首次提交 AC，本题历史 AC 率 ${round(rateInfo.acceptRate * 100, 1)}%（${rateInfo.nAccept}/${rateInfo.nSubmit}）。`
                : '首次提交 AC，但题目缺少历史提交/通过数据，暂不加分。')
            : '未触发首次提交 AC。',
        severity: evidenceSeverity(score, 10),
    };
}

function scoreNoPostPasteEdit(session: any): EvidenceItem {
    const submission = latestSubmission(session);
    const keystrokes = Number(submission?.keystrokesSinceLastPaste ?? 0);
    const ms = Number(submission?.msSinceLastPaste ?? Number.POSITIVE_INFINITY);
    let score = 0;
    if (keystrokes === 0 && ms < 120000) score = 10;
    else if (keystrokes < 10 && ms < 60000) score = 6;
    return {
        factor: 'no_post_paste_edit',
        name: 'F5 · 粘贴后零修改',
        inputs: { keystrokes_since_last_paste: Number.isFinite(ms) ? keystrokes : null, ms_since_last_paste: Number.isFinite(ms) ? ms : null },
        formula: 'if keystrokes == 0 and ms < 120000 -> 10; elif keystrokes < 10 and ms < 60000 -> 6',
        value: score,
        threshold: { full: '0 keys && <120000ms', partial: '<10 keys && <60000ms' },
        score,
        weight: 10,
        reason: score ? `最后一次粘贴后 ${ms}ms 内提交，期间有效按键 ${keystrokes} 次。` : '粘贴后有较充分编辑或未找到粘贴到提交链路。',
        severity: evidenceSeverity(score, 10),
    };
}

function scoreMultiplePastes(session: any): EvidenceItem {
    const pastes = [...(session?.pastes || [])]
        .filter((paste: any) => !paste?.inferredFromSubmission)
        .sort((a: any, b: any) => Number(a?.ts || 0) - Number(b?.ts || 0));
    let majorReplaces = 0;
    const pairs: any[] = [];
    for (let i = 0; i < pastes.length - 1; i++) {
        const similarity = textSimilarity(pastes[i]?.text || '', pastes[i + 1]?.text || '');
        const isMajor = similarity < 0.5 && Number(pastes[i + 1]?.lines || 0) > 10;
        if (isMajor) majorReplaces++;
        pairs.push({ from: i, to: i + 1, similarity: round(similarity), majorReplace: isMajor });
    }
    let score = 0;
    if (majorReplaces === 1) score = 5;
    else if (majorReplaces === 2) score = 10;
    else if (majorReplaces >= 3) score = 15;
    return {
        factor: 'multiple_paste_revisions',
        name: 'F6 · 多轮重粘贴',
        inputs: { pasteCount: pastes.length, pairs, major_replaces: majorReplaces },
        formula: 'major_replaces = count(similarity(p_i,p_i+1) < 0.5 && next.lines > 10)',
        value: majorReplaces,
        threshold: { 0: 0, 1: 5, 2: 10, '>=3': 15 },
        score,
        weight: 15,
        reason: majorReplaces ? `检测到 ${majorReplaces} 次低相似度整段重粘贴。` : '未检测到多轮整段重粘贴。',
        severity: evidenceSeverity(score, 15),
    };
}

export function computeProctorScore(session: any, options: {
    pdoc?: any;
    historyFingerprints?: StyleFingerprint[];
} = {}) {
    const breakdown = [
        scoreCodingRate(session),
        scoreThinking(session),
        scoreStyle(session, options.historyFingerprints || []),
        scoreFirstAttemptAc(session, options.pdoc),
        scoreNoPostPasteEdit(session),
        scoreMultiplePastes(session),
    ];
    const total = Math.min(100, round(breakdown.reduce((sum, item) => sum + item.score, 0), 1));
    const severity = total >= 80 ? 'red'
        : total >= 50 ? 'orange'
            : total >= 20 ? 'yellow'
                : 'green';
    return {
        total,
        severity,
        breakdown,
        computedAt: new Date(),
    };
}
