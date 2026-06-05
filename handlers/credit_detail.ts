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
    buildUserPrompt, cfg, creditId, creditQuery, escapeRegex, isObjectiveProblem, looksInterruptedReply,
    monthKey, parseIntegerCell, resolveAiTutorDomain, resolveProvider, splitImportLine,
} from '../utils';

export class AiTutorCreditDetailHandler extends Handler {
    static readonly PAGE_SIZE = 30;

    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const currentDomainId = this.domain._id || domainId;
        const uid = this.user._id;
        const ledgerColl = this.ctx.db.collection(COLL_CREDIT_LEDGER as any);
        const awardColl = this.ctx.db.collection(COLL_AWARD as any);
        const usageColl = this.ctx.db.collection(COLL_USAGE as any);
        const balanceColl = this.ctx.db.collection(COLL_CREDIT as any);

        const [balanceDoc, ledgerDocs] = await Promise.all([
            balanceColl.findOne(creditQuery(currentDomainId, uid)),
            ledgerColl.find({ uid, domainId: currentDomainId }).sort({ at: -1, _id: -1 }).toArray(),
        ]);
        const ledgerAwardIds = ledgerDocs
            .filter((doc: any) => doc.refType === 'award' && doc.refId)
            .map((doc: any) => doc.refId);
        const ledgerUsageIds = ledgerDocs
            .filter((doc: any) => doc.refType === 'usage' && doc.refId)
            .map((doc: any) => doc.refId);
        const [legacyAwards, legacyUsages] = await Promise.all([
            awardColl.find({
                uid,
                domainId: currentDomainId,
                ...(ledgerAwardIds.length ? { _id: { $nin: ledgerAwardIds } } : {}),
            } as any).toArray(),
            usageColl.find({
                uid,
                domainId: currentDomainId,
                ...(ledgerUsageIds.length ? { _id: { $nin: ledgerUsageIds } } : {}),
            } as any).toArray(),
        ]);

        const entries = [
            ...ledgerDocs.map((doc: any) => ({
                amount: doc.amount || 0,
                reason: doc.reason || '积分变动',
                kind: doc.kind || 'ledger',
                domainId: doc.domainId,
                pid: doc.pid,
                rid: doc.rid,
                remaining: doc.remaining,
                expiresAt: doc.expiresAt,
                expiredAt: doc.expiredAt,
                refundedAt: doc.refundedAt,
                operatorUid: doc.operatorUid,
                at: doc.at,
                legacy: false,
            })),
            ...legacyAwards.map((doc: any) => ({
                amount: doc.amount || 0,
                reason: '首次通过题目奖励积分',
                kind: 'firstAcAward',
                domainId: doc.domainId,
                pid: doc.pid,
                rid: doc.rid,
                at: doc.at,
                legacy: true,
            })),
            ...legacyUsages.map((doc: any) => ({
                amount: -(doc.creditsCost || 1),
                reason: '调用 AI 教练分析提交',
                kind: 'aiAnalysis',
                domainId: doc.domainId,
                rid: doc.rid,
                at: doc.at,
                legacy: true,
            })),
        ].sort((a: any, b: any) => {
            const diff = new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime();
            return diff || String(b.rid || '').localeCompare(String(a.rid || ''));
        });

        const rowCount = entries.length;
        const pageCount = Math.max(1, Math.ceil(rowCount / AiTutorCreditDetailHandler.PAGE_SIZE));
        page = Math.min(Math.max(1, page), pageCount);
        const rows = entries.slice(
            (page - 1) * AiTutorCreditDetailHandler.PAGE_SIZE,
            page * AiTutorCreditDetailHandler.PAGE_SIZE,
        );
        const operatorUids = [...new Set(rows
            .map((row: any) => row.operatorUid)
            .filter((id: any) => typeof id === 'number'))];
        const problemKeys = [...new Set(rows
            .filter((row: any) => row.domainId && row.pid)
            .map((row: any) => `${row.domainId}:${row.pid}`))];
        const [operators, problemDocs] = await Promise.all([
            operatorUids.length
                ? global.Hydro.model.user.getList(currentDomainId, operatorUids)
                : {},
            problemKeys.length
                ? Promise.all(problemKeys.map(async (key) => {
                    const [problemDomainId, pidText] = key.split(':');
                    const pid = Number(pidText);
                    if (!Number.isSafeInteger(pid)) return [key, null];
                    const pdoc = await global.Hydro.model.problem.get(problemDomainId, pid).catch(() => null);
                    return [key, pdoc];
                }))
                : [],
        ]);
        const problems: Record<string, any> = {};
        for (const [key, pdoc] of problemDocs as any[]) {
            if (!pdoc) continue;
            const displayPid = pdoc.pid || `P${pdoc.docId || pdoc._id}`;
            problems[key] = {
                ...pdoc,
                display: `${displayPid}. ${pdoc.title || ''}`.trim(),
            };
        }

        this.response.template = 'ai_tutor_credit_detail.html';
        this.response.body = {
            balance: (balanceDoc as any)?.balance ?? 0,
            totalEarned: (balanceDoc as any)?.totalEarned ?? 0,
            totalSpent: (balanceDoc as any)?.totalSpent ?? 0,
            rows,
            operators,
            problems,
            page,
            pageCount,
            rowCount,
            domainId: currentDomainId,
            page_name: 'ai_tutor_credit_detail',
        };
    }
}
