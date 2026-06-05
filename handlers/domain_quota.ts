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
    monthKey, monthlyQuotaBase, monthlyQuotaBonus, monthlyQuotaCap, parseIntegerCell, resolveAiTutorDomain, resolveProvider, splitImportLine,
} from '../utils';

export class AiTutorDomainQuotaHandler extends Handler {
    static readonly HISTORY_PAGE_SIZE = 20;

    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async assertDomainStudent(uid: number) {
        const DomainModel = global.Hydro.model.domain;
        const found = await DomainModel.getMultiUserInDomain(this.domain._id, {
            uid,
        }).next();
        if (!found) throw new NotFoundError(`uid=${uid}`);
        return found;
    }

    @query('uid', Types.PositiveInt)
    @query('page', Types.PositiveInt, true)
    @query('returnPage', Types.PositiveInt, true)
    @query('returnQ', Types.String, true)
    @query('returnRole', Types.String, true)
    @query('returnState', Types.Range(['enabled', 'disabled']), true)
    async get(
        domainId: string, uid: number, page = 1, returnPage = 1, returnQ = '',
        returnRole = '', returnState = '',
    ) {
        await this.assertDomainStudent(uid);
        const currentDomainId = this.domain._id || domainId;
        const month = monthKey();
        const UserModel = global.Hydro.model.user;
        const accessColl = this.ctx.db.collection(COLL_DOMAIN_ACCESS as any);
        const adjustColl = this.ctx.db.collection(COLL_CREDIT_ADJUST as any);
        const creditColl = this.ctx.db.collection(COLL_CREDIT as any);
        const ledgerColl = this.ctx.db.collection(COLL_CREDIT_LEDGER as any);
        const [student, access, calls, balanceDoc, historyResult, creditHistory] = await Promise.all([
            UserModel.getById(currentDomainId, uid),
            accessColl.findOne({ domainId: currentDomainId, uid }) as Promise<AiDomainAccessDoc | null>,
            this.ctx.db.collection(COLL_USAGE as any).countDocuments({
                domainId: currentDomainId,
                uid,
                monthKey: month,
            }),
            creditColl.findOne(creditQuery(currentDomainId, uid)),
            this.paginate(
                adjustColl.find({ domainId: currentDomainId, uid, kind: 'monthlyQuotaBonus' }).sort({ at: -1, _id: -1 }),
                page,
                AiTutorDomainQuotaHandler.HISTORY_PAGE_SIZE,
            ),
            ledgerColl.find({ domainId: currentDomainId, uid }).sort({ at: -1, _id: -1 }).limit(10).toArray(),
        ]);
        if (!student) throw new NotFoundError(`uid=${uid}`);
        const [history, historyPageCount, historyCount] = historyResult;
        const operatorUids = [...new Set([
            ...history.map((doc: any) => doc.operatorUid),
            ...creditHistory.map((doc: any) => doc.operatorUid),
        ].filter((id: any) => typeof id === 'number'))];
        const operators = operatorUids.length ? await UserModel.getList(currentDomainId, operatorUids) : {};
        const baseCap = monthlyQuotaBase(access, month);
        const bonus = monthlyQuotaBonus(access, month);
        const cleanReturnQ = (returnQ || '').trim().slice(0, 100);
        const cleanReturnRole = (returnRole || '').trim().slice(0, 100);
        let qs = `uid=${uid}`;
        if (returnPage > 1) qs += `&returnPage=${returnPage}`;
        if (cleanReturnQ) qs += `&returnQ=${encodeURIComponent(cleanReturnQ)}`;
        if (cleanReturnRole) qs += `&returnRole=${encodeURIComponent(cleanReturnRole)}`;
        if (returnState) qs += `&returnState=${returnState}`;

        this.response.template = 'ai_tutor_domain_quota.html';
        this.response.body = {
            domain: this.domain,
            student,
            uid,
            month,
            calls,
            baseCap,
            bonus,
            cap: monthlyQuotaCap(access, month),
            balance: (balanceDoc as any)?.balance ?? 0,
            history,
            creditHistory,
            operators,
            historyCount,
            page,
            historyPageCount,
            qs,
            returnPage,
            returnQ: cleanReturnQ,
            returnRole: cleanReturnRole,
            returnState,
            page_name: 'domain_ai_tutor_quota',
        };
    }

    @param('uid', Types.PositiveInt)
    @param('amount', Types.PositiveInt)
    @param('remark', Types.String)
    @param('returnPage', Types.PositiveInt, true)
    @param('returnQ', Types.String, true)
    @param('returnRole', Types.String, true)
    @param('returnState', Types.String, true)
    async postGrant(
        domainId: string, uid: number, amount: number, remark: string, returnPage = 1, returnQ = '',
        returnRole = '', returnState = '',
    ) {
        if (amount > 1000) {
            this.response.body = { error: '单次追加次数不能超过 1000。' };
            this.response.status = 400;
            return;
        }
        remark = (remark || '').trim();
        if (!remark) {
            this.response.body = { error: '请填写追加说明，以便保留操作依据。' };
            this.response.status = 400;
            return;
        }
        if (remark.length > 200) {
            this.response.body = { error: '追加说明请控制在 200 字以内。' };
            this.response.status = 400;
            return;
        }
        await this.assertDomainStudent(uid);
        const now = new Date();
        const month = monthKey(now);
        const accessColl = this.ctx.db.collection(COLL_DOMAIN_ACCESS as any);
        await accessColl.updateOne(
            { domainId: this.domain._id, uid },
            { $setOnInsert: { enabled: false, bonusMonth: month, quotaBonus: 0 } },
            { upsert: true },
        );
        await accessColl.updateOne(
            { domainId: this.domain._id, uid, bonusMonth: { $ne: month } },
            { $set: { bonusMonth: month, quotaBonus: 0 } },
        );
        const updated = await accessColl.findOneAndUpdate(
            { domainId: this.domain._id, uid, bonusMonth: month },
            {
                $inc: { quotaBonus: amount },
                $set: {
                    updatedAt: now,
                    updatedBy: this.user._id,
                },
            },
            { returnDocument: 'after' },
        ) as AiDomainAccessDoc;
        const nextBonus = Math.max(0, updated.quotaBonus || 0);
        const currentBonus = nextBonus - amount;

        await Promise.all([
            this.ctx.db.collection(COLL_CREDIT_ADJUST as any).insertOne({
                _id: new ObjectId(),
                domainId: this.domain._id,
                uid,
                amount,
                monthKey: month,
                kind: 'monthlyQuotaBonus',
                beforeBonus: currentBonus,
                afterBonus: nextBonus,
                remark,
                operatorUid: this.user._id,
                at: now,
            } as any),
            OplogModel.log(this, 'ai_tutor.grantQuota', {
                targetUid: uid,
                amount,
                monthKey: month,
                beforeBonus: currentBonus,
                afterBonus: nextBonus,
                remark,
            }),
        ]);
        const queryParams: Record<string, string | number> = { uid };
        if (returnPage > 1) queryParams.returnPage = returnPage;
        const cleanReturnQ = (returnQ || '').trim().slice(0, 100);
        if (cleanReturnQ) queryParams.returnQ = cleanReturnQ;
        const cleanReturnRole = (returnRole || '').trim().slice(0, 100);
        if (cleanReturnRole) queryParams.returnRole = cleanReturnRole;
        if (['enabled', 'disabled'].includes(returnState)) queryParams.returnState = returnState;
        this.response.redirect = this.url('ai_tutor_domain_quota', { query: queryParams });
    }

    @param('uid', Types.PositiveInt)
    @param('creditAmount', Types.Int)
    @param('creditRemark', Types.String)
    @param('returnPage', Types.PositiveInt, true)
    @param('returnQ', Types.String, true)
    @param('returnRole', Types.String, true)
    @param('returnState', Types.String, true)
    async postAdjustCredit(
        domainId: string, uid: number, creditAmount: number, creditRemark: string, returnPage = 1,
        returnQ = '', returnRole = '', returnState = '',
    ) {
        if (!creditAmount) {
            this.response.body = { error: '积分变动值不能为 0。' };
            this.response.status = 400;
            return;
        }
        if (Math.abs(creditAmount) > 1000) {
            this.response.body = { error: '单次积分变动不能超过 1000。' };
            this.response.status = 400;
            return;
        }
        creditRemark = (creditRemark || '').trim();
        if (!creditRemark) {
            this.response.body = { error: '请填写积分修改说明，以便保留操作依据。' };
            this.response.status = 400;
            return;
        }
        if (creditRemark.length > 200) {
            this.response.body = { error: '积分修改说明请控制在 200 字以内。' };
            this.response.status = 400;
            return;
        }
        await this.assertDomainStudent(uid);
        const now = new Date();
        const result = await adjustCreditManually(this.ctx, {
            domainId: this.domain._id,
            uid,
            amount: creditAmount,
            reason: `手动修改积分：${creditRemark}`,
            operatorUid: this.user._id,
        });
        if (!result) {
            this.response.body = { error: '学生当前本域积分不足，无法扣减这么多积分。' };
            this.response.status = 400;
            return;
        }
        await Promise.all([
            this.ctx.db.collection(COLL_CREDIT_ADJUST as any).insertOne({
                _id: new ObjectId(),
                domainId: this.domain._id,
                uid,
                amount: creditAmount,
                kind: 'manualCredit',
                beforeBalance: result.beforeBalance,
                afterBalance: result.afterBalance,
                remark: creditRemark,
                operatorUid: this.user._id,
                ledgerId: result.ledgerId,
                at: now,
            } as any),
            OplogModel.log(this, 'ai_tutor.adjustCredit', {
                targetUid: uid,
                amount: creditAmount,
                beforeBalance: result.beforeBalance,
                afterBalance: result.afterBalance,
                remark: creditRemark,
            }),
        ]);
        const queryParams: Record<string, string | number> = { uid };
        if (returnPage > 1) queryParams.returnPage = returnPage;
        const cleanReturnQ = (returnQ || '').trim().slice(0, 100);
        if (cleanReturnQ) queryParams.returnQ = cleanReturnQ;
        const cleanReturnRole = (returnRole || '').trim().slice(0, 100);
        if (cleanReturnRole) queryParams.returnRole = cleanReturnRole;
        if (['enabled', 'disabled'].includes(returnState)) queryParams.returnState = returnState;
        this.response.redirect = this.url('ai_tutor_domain_quota', { query: queryParams });
    }
}
