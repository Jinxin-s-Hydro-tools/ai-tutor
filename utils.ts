import { Context, moment, SystemModel } from 'hydrooj';

import { COLL_DOMAIN_CONFIG, DAILY_CHECKIN_CREDIT, PROVIDERS } from './constants';
import { AiDomainAccessDoc, AiDomainConfigDoc } from './types';

export function monthKey(d: Date = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function creditId(domainId: string, uid: number) {
    return `${domainId}:${uid}`;
}

export function creditQuery(domainId: string, uid: number) {
    return { _id: creditId(domainId, uid) as any };
}

export function cfg<T = string>(key: string, fallback: T): T {
    const v = SystemModel.get(`ai-tutor.${key}`);
    return (v === undefined || v === null || v === '') ? fallback : (v as T);
}

export function cfgNumber(key: string, fallback: number): number {
    const v = SystemModel.get(`ai-tutor.${key}`);
    if (v === undefined || v === null || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export function monthlyQuotaBase(access: AiDomainAccessDoc | null | undefined, month = monthKey()) {
    if (access?.quotaMonth === month && Number.isSafeInteger(access.quotaLimit)) {
        return Math.max(0, access.quotaLimit || 0);
    }
    return Math.max(0, Math.trunc(cfgNumber('monthlyQuota', 30) || 0));
}

export function monthlyQuotaBonus(access: AiDomainAccessDoc | null | undefined, month = monthKey()) {
    return access?.bonusMonth === month ? Math.max(0, access.quotaBonus || 0) : 0;
}

export function monthlyQuotaCap(access: AiDomainAccessDoc | null | undefined, month = monthKey()) {
    return monthlyQuotaBase(access, month) + monthlyQuotaBonus(access, month);
}

export async function getDomainAiConfig(ctx: Context, domainId: string): Promise<AiDomainConfigDoc | null> {
    return ctx.db.collection(COLL_DOMAIN_CONFIG as any).findOne({ _id: domainId }) as Promise<AiDomainConfigDoc | null>;
}

export function dailyCheckinCredit(config: AiDomainConfigDoc | null | undefined) {
    const amount = Math.trunc(Number(config?.dailyCheckinCredit ?? DAILY_CHECKIN_CREDIT));
    return Number.isSafeInteger(amount) && amount > 0 ? amount : DAILY_CHECKIN_CREDIT;
}

export async function resolveProvider(ctx: Context, domainId: string): Promise<{
    baseUrl: string;
    model: string;
    apiKey: string;
    providerKey: string;
}> {
    const config = await getDomainAiConfig(ctx, domainId);
    const choice = config?.provider || 'deepseek-v4-flash';
    const preset = PROVIDERS[choice] || PROVIDERS['deepseek-v4-flash'];

    let baseUrl = preset.baseUrl;
    let model = preset.model;
    if (choice === 'custom') {
        baseUrl = config?.customBaseUrl || '';
        model = config?.customModel || '';
    }

    const apiKey = config?.apiKey || '';
    return { baseUrl, model, apiKey, providerKey: choice };
}

export function truncate(s: string, max: number): string {
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max)}\n...(已截断，共 ${s.length} 字符)` : s;
}

export function looksInterruptedReply(text: string) {
    const s = (text || '').trim();
    if (!s) return false;
    if (/[。！？.!?）)」』”'`】]$/.test(s)) return false;
    if (s.length < 80) return true;
    return /(?:因为|如果|但是|所以|比如|这个|一个|唯一一个|是|为|把|被|在|和|或|跟|对|要|能|可以|应该|不是|没有|需要|先|再|第|只要)$/.test(s)
        || /[，、：；（(「『“"]$/.test(s);
}

export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isObjectiveProblem(pdoc: any) {
    return pdoc?.config?.type === 'objective'
        || (typeof pdoc?.config === 'string' && /type:\s*objective\b/.test(pdoc.config));
}

export function nextWeeklyCreditResetAt() {
    const next = moment().startOf('isoWeek').add(1, 'week').hour(3).minute(0).second(0).millisecond(0);
    return next.toDate();
}

export function splitImportLine(raw: string) {
    let cols = raw.split(',').map((t) => t.trim());
    if (cols.length < 2) cols = raw.split('\t').map((t) => t.trim());
    while (cols.length && !cols[cols.length - 1]) cols.pop();
    return cols;
}

export function parseIntegerCell(value: string) {
    if (!/^-?\d+$/.test((value || '').trim())) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return null;
    return n;
}

export async function resolveAiTutorDomain(ctx: Context, input: string) {
    const DomainModel = global.Hydro.model.domain;
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    const byId = await DomainModel.get(trimmed).catch(() => null);
    if (byId) return byId;
    return ctx.db.collection('domain').findOne({ name: trimmed });
}

export function buildUserPrompt(
    pdoc: any,
    rdoc: any,
    langDisplay: string,
    statusText: string,
    questionFocusLabel = '',
    studentNote = '',
): string {
    const failed = (rdoc.testCases || [])
        .filter((tc: any) => tc.status && tc.status !== 1) // 1 = STATUS_ACCEPTED
        .slice(0, 3)
        .map((tc: any, i: number) => `  · 第 ${i + 1} 个失败点：${tc.message || ''}`.trim())
        .join('\n');

    const maxProblem = cfgNumber('maxProblemChars', 4000);
    const maxCode = cfgNumber('maxCodeChars', 3000);

    const questionContext = questionFocusLabel && studentNote
        ? `## 我这次遇到的卡点
- 我想问的方向：${questionFocusLabel}
- 我已经补充的信息：${truncate(studentNote, 500)}

请先回应我的这个具体卡点，再结合我的提交给一两个提示，不要直接替我完成题目。

`
        : '';

    return `${questionContext}## 题目
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
