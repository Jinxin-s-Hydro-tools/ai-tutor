import { PassThrough } from 'stream';

import {
    ForbiddenError, Handler, NotFoundError, ObjectId, OplogModel, param, PermissionError, query,
    PERM, PRIV, Types,
} from 'hydrooj';

import {
    COLL_ANALYSIS, COLL_AWARD, COLL_CREDIT, COLL_CREDIT_ADJUST, COLL_CREDIT_LEDGER, COLL_DOMAIN_ACCESS,
    COLL_DOMAIN_CONFIG, COLL_USAGE, DEFAULT_SYSTEM_PROMPT, PROVIDERS, PROVIDER_RANGE, QUESTION_FOCUS,
} from '../constants';
import {
    adjustCreditClamped, adjustCreditManually, adjustQuotaBonusClamped, deductCredit, expireCredits,
    refundDeductedCredit,
} from '../credits';
import { AiAnalysisDoc, AiDomainAccessDoc } from '../types';
import {
    buildUserPrompt, cfg, creditId, creditQuery, escapeRegex, isObjectiveProblem, looksInterruptedReply,
    getDomainAiConfig, monthKey, monthlyQuotaBonus, monthlyQuotaCap, parseIntegerCell, resolveAiTutorDomain,
    resolveProvider, splitImportLine,
} from '../utils';

export class AiTutorDomainManageHandler extends Handler {
    static readonly PAGE_SIZE = 20;

    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async assertDomainStudent(uid: number) {
        const DomainModel = global.Hydro.model.domain;
        const found = await DomainModel.getMultiUserInDomain(this.domain._id, {
            uid,
        }).next();
        if (!found) throw new NotFoundError(`uid=${uid}`);
    }

    redirectToList(page = 1, q = '', role = '', state = '') {
        const queryParams: Record<string, string | number> = {};
        if (page > 1) queryParams.page = page;
        if (q) queryParams.q = q;
        if (role) queryParams.role = role;
        if (['enabled', 'disabled'].includes(state)) queryParams.state = state;
        this.response.redirect = this.url('ai_tutor_domain_manage', { query: queryParams });
    }

    @query('page', Types.PositiveInt, true)
    @query('q', Types.String, true)
    @query('role', Types.String, true)
    @query('state', Types.Range(['enabled', 'disabled']), true)
    async get(domainId: string, page = 1, q = '', role = '', state = '') {
        const currentDomainId = this.domain._id || domainId;
        const month = monthKey();
        const DomainModel = global.Hydro.model.domain;
        const UserModel = global.Hydro.model.user;
        const keyword = (q || '').trim().slice(0, 100);
        const roles = await DomainModel.getRoles(currentDomainId);
        const selectedRole = roles.some((item: any) => item._id === role) ? role : '';
        const memberFilter: any = selectedRole ? { role: selectedRole } : {};
        if (keyword) {
            const matchingUsers = await UserModel.getMulti({
                unameLower: { $regex: escapeRegex(keyword.toLowerCase()) },
            }).project({ _id: 1 }).toArray();
            memberFilter.uid = { $in: matchingUsers.map((user: any) => user._id) };
        }
        if (state) {
            const enabledAccess = await this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).find({
                domainId: currentDomainId,
                enabled: true,
            }).project({ uid: 1 }).toArray();
            const enabledUids = enabledAccess.map((doc: any) => doc.uid as number);
            memberFilter.uid ||= {};
            if (state === 'enabled') {
                memberFilter.uid.$in = memberFilter.uid.$in
                    ? memberFilter.uid.$in.filter((uid: number) => enabledUids.includes(uid))
                    : enabledUids;
            } else {
                memberFilter.uid.$nin = enabledUids;
            }
        }

        const [domainAiConfig, memberResult] = await Promise.all([
            getDomainAiConfig(this.ctx, currentDomainId),
            this.paginate(
                DomainModel.getMultiUserInDomain(currentDomainId, memberFilter).sort({ uid: 1 }),
                page,
                AiTutorDomainManageHandler.PAGE_SIZE,
            ),
        ]);
        const [memberDocs, pageCount, rowCount] = memberResult;
        const uids = memberDocs.map((d: any) => d.uid as number);
        const [users, accessDocs, balanceDocs, usageRows] = await Promise.all([
            UserModel.getList(currentDomainId, uids),
            uids.length
                ? this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).find({ domainId: currentDomainId, uid: { $in: uids } as any }).toArray()
                : [],
            uids.length
                ? this.ctx.db.collection(COLL_CREDIT as any).find({
                    _id: { $in: uids.map((uid) => creditId(currentDomainId, uid)) } as any,
                }).toArray()
                : [],
            uids.length
                ? this.ctx.db.collection(COLL_USAGE as any).aggregate([
                    { $match: { domainId: currentDomainId, monthKey: month, uid: { $in: uids } } },
                    { $group: { _id: '$uid', calls: { $sum: 1 }, lastAt: { $max: '$at' } } },
                ]).toArray()
                : [],
        ]);
        const accessMap: Record<number, any> = {};
        const balanceMap: Record<number, any> = {};
        const usageMap: Record<number, any> = {};
        accessDocs.forEach((doc: any) => { accessMap[doc.uid] = doc; });
        balanceDocs.forEach((doc: any) => { balanceMap[doc.uid] = doc; });
        usageRows.forEach((doc: any) => { usageMap[doc._id] = doc; });
        const baseCap = cfg<number>('monthlyQuota', 30);
        const rows = memberDocs.map((member: any) => {
            const access = accessMap[member.uid] || {};
            const bonus = monthlyQuotaBonus(access, month);
            return {
                uid: member.uid,
                user: users[member.uid],
                role: member.role,
                enabled: !!access.enabled,
                balance: balanceMap[member.uid]?.balance ?? 0,
                calls: usageMap[member.uid]?.calls ?? 0,
                cap: monthlyQuotaCap(access, month),
                bonus,
                lastAt: usageMap[member.uid]?.lastAt,
            };
        });
        let qs = keyword ? `q=${encodeURIComponent(keyword)}` : '';
        if (selectedRole) qs += `${qs ? '&' : ''}role=${encodeURIComponent(selectedRole)}`;
        if (state) qs += `${qs ? '&' : ''}state=${state}`;

        this.response.template = 'ai_tutor_domain_manage.html';
        this.response.body = {
            domain: this.domain,
            month,
            baseCap,
            domainAiConfig: domainAiConfig || {},
            providerRange: PROVIDER_RANGE,
            providerLabel: PROVIDERS[domainAiConfig?.provider || 'deepseek-v4-flash']?.label || '',
            apiKeyConfigured: !!domainAiConfig?.apiKey,
            rows,
            page,
            pageCount,
            rowCount,
            q: keyword,
            roles,
            role: selectedRole,
            state,
            qs,
            page_name: 'domain_ai_tutor_manage',
        };
    }

    @param('provider', Types.String)
    @param('customBaseUrl', Types.String, true)
    @param('customModel', Types.String, true)
    @param('apiKey', Types.String, true)
    @param('clearApiKey', Types.Boolean, true)
    async postSaveConfig(
        domainId: string, provider: string, customBaseUrl = '', customModel = '', apiKey = '', clearApiKey = false,
    ) {
        provider = (provider || '').trim();
        if (!PROVIDERS[provider]) {
            this.response.body = { error: '请选择有效的 AI 提供方。' };
            this.response.status = 400;
            return;
        }
        customBaseUrl = (customBaseUrl || '').trim();
        customModel = (customModel || '').trim();
        if (provider === 'custom' && (!customBaseUrl || !customModel)) {
            this.response.body = { error: '自定义提供方需要同时填写 Base URL 与模型名称。' };
            this.response.status = 400;
            return;
        }
        apiKey = (apiKey || '').trim();
        const now = new Date();
        const update: any = {
            $set: {
                domainId: this.domain._id,
                provider,
                customBaseUrl: provider === 'custom' ? customBaseUrl : '',
                customModel: provider === 'custom' ? customModel : '',
                updatedAt: now,
                updatedBy: this.user._id,
            },
            $setOnInsert: { _id: this.domain._id },
        };
        if (clearApiKey) update.$unset = { apiKey: '' };
        else if (apiKey) update.$set.apiKey = apiKey;
        await Promise.all([
            this.ctx.db.collection(COLL_DOMAIN_CONFIG as any).updateOne(
                { _id: this.domain._id },
                update,
                { upsert: true },
            ),
            OplogModel.log(this, 'ai_tutor.saveDomainConfig', {
                domainId: this.domain._id,
                provider,
                customBaseUrl: provider === 'custom' ? customBaseUrl : '',
                customModel: provider === 'custom' ? customModel : '',
                apiKeyChanged: !!apiKey || !!clearApiKey,
            }),
        ]);
        this.redirectToList();
    }

    @param('uid', Types.PositiveInt)
    @param('enabled', Types.Boolean)
    @param('returnPage', Types.PositiveInt, true)
    @param('returnQ', Types.String, true)
    @param('returnRole', Types.String, true)
    @param('returnState', Types.String, true)
    async postToggle(
        domainId: string, uid: number, enabled = false, returnPage = 1, returnQ = '',
        returnRole = '', returnState = '',
    ) {
        await this.assertDomainStudent(uid);
        await this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).updateOne(
            { domainId: this.domain._id, uid },
            {
                $set: {
                    enabled,
                    updatedAt: new Date(),
                    updatedBy: this.user._id,
                },
            },
            { upsert: true },
        );
        this.redirectToList(
            returnPage,
            (returnQ || '').trim().slice(0, 100),
            (returnRole || '').trim().slice(0, 100),
            returnState,
        );
    }

}
