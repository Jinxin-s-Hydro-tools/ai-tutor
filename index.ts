import { Context, moment, ObjectId, PERM, PRIV, ScheduleModel, Schema } from 'hydrooj';
import { HomeHandler } from 'hydrooj/src/handler/home';

import {
    COLL_ANALYSIS, COLL_AWARD, COLL_CHECKIN, COLL_CREDIT, COLL_CREDIT_ADJUST, COLL_CREDIT_LEDGER,
    COLL_DOMAIN_ACCESS, COLL_DOMAIN_CONFIG, COLL_PROCTOR_EVENT, COLL_PROCTOR_SESSION, COLL_USAGE,
    DEFAULT_SYSTEM_PROMPT, WEEKLY_CREDIT_RESET_TASK,
} from './constants';
import {
    addCreditGrant, bootstrapCreditLots, expireCredits, grantCreditsToEnabledUsers, grantWeeklyCredits,
    resetEnabledUserMonthlyQuota,
} from './credits';
import { runDifficultyScan, validateDifficultyScanArgs } from './difficulty';
import {
    AiSuggestionAvailabilityHandler, AiSuggestionHandler, AiTutorCreditDetailHandler, AiTutorDailyCheckinHandler,
    AiTutorDomainRecordsHandler, AiTutorDomainBatchHandler, AiTutorDomainManageHandler, AiTutorDomainQuotaHandler,
    AiTutorProctorEventHandler, AiTutorProctorHandler, AiTutorProctorHomeworkEntryHandler, AiTutorProctorSessionExportHandler,
    AiTutorProctorSessionHandler,
} from './handlers';
import { processRecordJudge } from './proctor/session';
import {
    cfgNumber, creditQuery, dailyCheckinCredit, getDomainAiConfig, nextWeeklyCreditResetAt,
} from './utils';

(HomeHandler.prototype as any).getAiTutorCheckin = async function getAiTutorCheckin(domainId: string) {
    if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) return { visible: false };
    const uid = this.user._id;
    const access = await this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({
        domainId,
        uid,
        enabled: true,
    });
    if (!access) return { visible: false };
    const now = new Date();
    const dayKey = moment(now).format('YYYY-MM-DD');
    const currentMonth = moment(now).format('YYYY-MM');
    const checkinColl = this.ctx.db.collection(COLL_CHECKIN as any);
    const amount = dailyCheckinCredit(await getDomainAiConfig(this.ctx, domainId));
    await expireCredits(this.ctx, uid, domainId);
    const [todayDoc, balanceDoc, monthRows] = await Promise.all([
        checkinColl.findOne({ domainId, uid, dayKey }),
        this.ctx.db.collection(COLL_CREDIT as any).findOne(creditQuery(domainId, uid)),
        checkinColl.aggregate([
            { $match: { domainId, uid, monthKey: currentMonth } },
            { $group: { _id: null, days: { $sum: 1 }, credits: { $sum: '$amount' } } },
        ]).toArray(),
    ]);
    return {
        visible: true,
        loggedIn: true,
        amount,
        balance: (balanceDoc as any)?.balance ?? 0,
        todayChecked: !!todayDoc,
        todayAt: (todayDoc as any)?.at,
        monthDays: monthRows[0]?.days || 0,
        monthCredits: monthRows[0]?.credits || 0,
    };
};

export async function apply(ctx: Context) {
    ctx.on('handler/after/Home', async (handler) => {
        if (handler.request.method !== 'get') return;
        if (handler.response.template !== 'main.html') return;
        const contents = handler.response.body?.contents;
        if (!Array.isArray(contents) || !contents.length) return;

        const rightColumn = contents.find((column: any) => Number(column.width) === 3) || contents[contents.length - 1];
        if (!Array.isArray(rightColumn.sections)) return;
        if (rightColumn.sections.some((section: any) => section?.[0] === 'ai_tutor_checkin')) return;

        const payload = await (handler as any).getAiTutorCheckin(handler.domain._id);
        if (!payload?.visible) return;
        rightColumn.sections.unshift(['ai_tutor_checkin', payload]);
    });

    // Use the official `ctx.inject(['setting'], ...)` pattern (same as ui-default does).
    // This ensures the setting service is ready and gives proper dispose-on-unload behavior.
    ctx.inject(['setting'], (c) => {
        const SM = global.Hydro.model.setting;
        c.setting.SystemSetting(
            // ── 积分/配额机制 ──
            SM.Setting('setting_basic', 'ai-tutor.creditsPerFirstAc', 1, 'number',
                'AI Tutor: 每道题首次 AC 奖励的积分',
                '每个用户每道题"第一次 AC"奖励的积分数；重复 AC 同一题不再奖励。设为 0 可禁用积分奖励。'),
            SM.Setting('setting_basic', 'ai-tutor.monthlyQuota', 30, 'number',
                'AI Tutor: 月度使用上限',
                '每用户每月最多调用 AI 的次数（防爆刷的硬封顶，每月 1 号自动重置）。即使积分充足，达到该上限后本月不能再调用。'),
            SM.Setting('setting_basic', 'ai-tutor.minSubmissions', 2, 'number',
                'AI Tutor: 提交门槛',
                '同一道题至少累计提交 N 次后才能调用 AI（防止学生题目没读就秒点 AI）。设为 1 等同于不限制。当前 record 也算 1 次。'),

            SM.Setting('setting_basic', 'ai-tutor.maxCodeChars', 3000, 'number',
                'AI Tutor: Max code chars', '提交给 AI 的代码最大字符数（超出截断）'),
            SM.Setting('setting_basic', 'ai-tutor.maxProblemChars', 4000, 'number',
                'AI Tutor: Max problem chars', '提交给 AI 的题面最大字符数（超出截断）'),
            SM.Setting('setting_basic', 'ai-tutor.temperature', 0.7, 'float',
                'AI Tutor: Temperature', '采样温度，0–1 之间'),
            SM.Setting('setting_basic', 'ai-tutor.maxTokens', 8192, 'number',
                'AI Tutor: Max output tokens', '单次最大输出 token 数（含推理 token）'),
            SM.Setting('setting_basic', 'ai-tutor.timeoutMs', 60000, 'number',
                'AI Tutor: Timeout (ms)', '单次请求最长等待时间，毫秒'),
            SM.Setting('setting_basic', 'ai-tutor.systemPrompt', DEFAULT_SYSTEM_PROMPT, 'textarea',
                'AI Tutor: System Prompt', '系统提示词，控制 AI 教练的人设与铁律'),
        );
    });

    await ctx.inject(['worker'], (c) => {
        c.worker.addHandler(WEEKLY_CREDIT_RESET_TASK, async () => {
            await expireCredits(ctx);
            await grantWeeklyCredits(ctx);
        });
    });
    ctx.addScript('aiTutorWeeklyCreditGrant', 'AI Tutor: reset monthly quota for enabled users in one domain. Args: {"domainId":"system","quota":30}', Schema.object({
        domainId: Schema.string().required().description('Domain ID'),
        quota: Schema.number().step(1).min(0).required().description('Monthly quota limit'),
    }), async (args, report) => {
        const stats = await resetEnabledUserMonthlyQuota(ctx, {
            domainId: args.domainId,
            quota: args.quota,
            operatorUid: 0,
        });
        report({ message: `Reset ${stats.domainId} enabled AI users monthly quota to ${stats.quota} for ${stats.month}. matched=${stats.matched}, changed=${stats.changed}.` });
        return true;
    });
    ctx.addScript('aiTutorGrantCredits', 'AI Tutor: grant credits to enabled users in one domain. Args: {"domainId":"system","amount":5,"reason":"月初发放 AI 积分"}', Schema.object({
        domainId: Schema.string().required().description('Domain ID'),
        amount: Schema.number().step(1).min(1).required().description('Credits to grant'),
        reason: Schema.string().required().description('Grant reason'),
    }), async (args, report) => {
        const stats = await grantCreditsToEnabledUsers(ctx, {
            domainId: args.domainId,
            amount: args.amount,
            reason: args.reason,
            operatorUid: 0,
        });
        report({ message: `Granted ${stats.amount} credits to ${stats.accounts} enabled AI users in ${stats.domainId} (${stats.changed} changed). Reason: ${stats.reason}.` });
        return true;
    });
    ctx.addScript(
        'aiTutorDifficultyScan',
        'AI Tutor: scan problems and score difficulty (JSON args: {"domainId":"system","limit":50,"overwrite":false,"includeHidden":false,"dryRun":false})',
        validateDifficultyScanArgs as any,
        async (args, report) => runDifficultyScan(ctx, args, report),
    );

    // ── Index bootstrap ──
    ctx.on('app/started', async () => {
        const swallow = () => { /* index already exists */ };
        const dbs = ctx.db;
        // Existing
        await dbs.collection(COLL_ANALYSIS as any).createIndex({ uid: 1, monthKey: 1 }).catch(swallow);
        await dbs.collection(COLL_ANALYSIS as any).createIndex({ createdAt: -1 }).catch(swallow);
        // Monthly usage log
        await dbs.collection(COLL_USAGE as any).createIndex({ uid: 1, monthKey: 1 }).catch(swallow);
        await dbs.collection(COLL_USAGE as any).createIndex({ at: -1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT as any).createIndex({ domainId: 1, uid: 1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT as any).createIndex({ uid: 1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT_LEDGER as any).createIndex({ uid: 1, at: -1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT_LEDGER as any).createIndex({ domainId: 1, uid: 1, at: -1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT_LEDGER as any).createIndex({ refType: 1, refId: 1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT_LEDGER as any).createIndex({ expiresAt: 1, remaining: 1 }).catch(swallow);
        await dbs.collection(COLL_CHECKIN as any).createIndex(
            { domainId: 1, uid: 1, dayKey: 1 },
            { unique: true },
        ).catch(swallow);
        await dbs.collection(COLL_CHECKIN as any).createIndex({ domainId: 1, uid: 1, monthKey: 1 }).catch(swallow);
        await dbs.collection(COLL_DOMAIN_ACCESS as any).createIndex(
            { domainId: 1, uid: 1 },
            { unique: true },
        ).catch(swallow);
        await dbs.collection(COLL_DOMAIN_CONFIG as any).createIndex({ domainId: 1 }, { unique: true }).catch(swallow);
        await dbs.collection(COLL_CREDIT_ADJUST as any).createIndex({ domainId: 1, at: -1 }).catch(swallow);
        await dbs.collection(COLL_CREDIT_ADJUST as any).createIndex({ domainId: 1, uid: 1, at: -1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_SESSION as any).createIndex(
            { domainId: 1, tid: 1, uid: 1, pid: 1 },
            { unique: true },
        ).catch(swallow);
        await dbs.collection(COLL_PROCTOR_SESSION as any).createIndex({ domainId: 1, tid: 1, 'score.total': -1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_SESSION as any).createIndex({ domainId: 1, uid: 1, 'score.total': -1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_SESSION as any).createIndex({ domainId: 1, pid: 1, 'score.total': -1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_SESSION as any).createIndex({ domainId: 1, 'review.state': 1, 'score.total': -1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_EVENT as any).createIndex({ sessionId: 1, ts: 1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_EVENT as any).createIndex({ sessionId: 1, type: 1, 'meta.rid': 1 }).catch(swallow);
        await dbs.collection(COLL_PROCTOR_EVENT as any).createIndex({ domainId: 1, tid: 1, uid: 1, ts: 1 }).catch(swallow);
        await dbs.collection(COLL_AWARD as any).updateMany(
            { awardKey: { $exists: false }, domainId: { $exists: true }, pid: { $exists: true } },
            [{ $set: { awardKey: { $concat: ['$domainId', ':', { $toString: '$pid' }] } } }] as any,
        ).catch(swallow);
        // Awards: unique compound to enforce "first-AC only once per user and problem identity".
        await dbs.collection(COLL_AWARD as any).createIndex(
            { uid: 1, awardKey: 1 },
            { unique: true, partialFilterExpression: { awardKey: { $exists: true } } },
        ).catch(swallow);
        // Legacy index kept for old documents and audit queries.
        await dbs.collection(COLL_AWARD as any).createIndex(
            { uid: 1, domainId: 1, pid: 1 },
            { unique: true },
        ).catch(swallow);
        await bootstrapCreditLots(ctx).catch((e) => console.error('[ai-tutor] failed to bootstrap credit lots:', e));
        await expireCredits(ctx).catch((e) => console.error('[ai-tutor] failed to expire credits:', e));

        if (process.env.NODE_APP_INSTANCE === '0' || process.env.NODE_APP_INSTANCE === undefined) {
            if (!await ScheduleModel.count({ type: 'schedule', subType: WEEKLY_CREDIT_RESET_TASK })) {
                await ScheduleModel.add({
                    type: 'schedule',
                    subType: WEEKLY_CREDIT_RESET_TASK,
                    executeAfter: nextWeeklyCreditResetAt(),
                    interval: [1, 'week'],
                });
            }
        }
    });

    // ── First-AC credit award listener ──
    // Fires after each judge completes. `updated=true` means the user's BEST status on
    // this (uid, pid) flipped — which is exactly the "first time they reached AC".
    // The unique index on ai.credit_award is a second safety net against double-award.
    ctx.on('record/judge', async (rdoc: any, updated: boolean) => {
        await processRecordJudge(ctx, rdoc).catch((e) => console.error('[ai-tutor] failed to update proctor session:', e));

        const amount = cfgNumber('creditsPerFirstAc', 1);
        if (amount <= 0) return; // award disabled
        const STATUS_ACCEPTED = 1;
        if (rdoc?.status !== STATUS_ACCEPTED) return;
        if (!updated) return; // user had already AC'd this problem before
        // Skip pretest "fake records" whose contest id starts with 23 zeros
        if (rdoc.contest?.toString().startsWith('0'.repeat(23))) return;
        const access = await ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({
            domainId: rdoc.domainId,
            uid: rdoc.uid,
            enabled: true,
        });
        if (!access) return;

        const awardColl = ctx.db.collection(COLL_AWARD as any);
        const awardKey = `${rdoc.domainId}:${rdoc.pid}`;
        const existingAward = await awardColl.findOne({
            uid: rdoc.uid,
            domainId: rdoc.domainId,
            pid: rdoc.pid,
        } as any);
        if (existingAward) return;
        const awardId = new ObjectId();
        try {
            await awardColl.insertOne({
                _id: awardId,
                uid: rdoc.uid,
                pid: rdoc.pid,
                domainId: rdoc.domainId,
                awardKey,
                rid: rdoc._id,
                amount,
                at: new Date(),
            } as any);
        } catch (e: any) {
            // E11000 duplicate key = already awarded for this (uid, domain, pid). Ignore.
            if (e?.code === 11000) return;
            console.error('[ai-tutor] failed to record award:', e);
            return;
        }
        await addCreditGrant(ctx, {
            uid: rdoc.uid,
            amount,
            kind: 'firstAcAward',
            reason: '首次通过题目奖励积分',
            domainId: rdoc.domainId,
            pid: rdoc.pid,
            rid: rdoc._id,
            refType: 'award',
            refId: awardId,
        }).catch((e) => console.error('[ai-tutor] failed to credit balance:', e));
    });

    ctx.Route('ai_suggestion_available', '/record/:rid/ai/available', AiSuggestionAvailabilityHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_suggestion', '/record/:rid/ai', AiSuggestionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_tutor_credit_detail', '/ai-tutor/credits', AiTutorCreditDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_tutor_daily_checkin', '/ai-tutor/checkin', AiTutorDailyCheckinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_tutor_domain_quota', '/domain/ai-tutor/quota', AiTutorDomainQuotaHandler);
    ctx.Route('ai_tutor_domain_batch', '/domain/ai-tutor/batch', AiTutorDomainBatchHandler);
    ctx.Route('ai_tutor_domain_records', '/domain/ai-tutor/records', AiTutorDomainRecordsHandler);
    ctx.Route('ai_tutor_proctor', '/domain/ai-tutor/proctor', AiTutorProctorHandler);
    ctx.Route('ai_tutor_proctor_event', '/domain/ai-tutor/proctor/event', AiTutorProctorEventHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_tutor_proctor_session', '/domain/ai-tutor/proctor/session/:sid', AiTutorProctorSessionHandler);
    ctx.Route('ai_tutor_proctor_session_export', '/domain/ai-tutor/proctor/session/:sid/export', AiTutorProctorSessionExportHandler);
    ctx.Route('ai_tutor_proctor_homework', '/homework/:tid/proctor', AiTutorProctorHomeworkEntryHandler);
    ctx.Route('ai_tutor_domain_manage', '/domain/ai-tutor', AiTutorDomainManageHandler);
    ctx.injectUI('DomainManage', 'ai_tutor_domain_manage', { family: 'Access Control', icon: 'user' }, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'ai_tutor_proctor', { family: 'Access Control', icon: 'flag' }, PERM.PERM_EDIT_DOMAIN);

    ctx.i18n.load('zh', {
        ai_suggestion: 'AI 刷题建议',
        ai_tutor_credit_detail: 'AI 积分明细',
        ai_tutor_domain_manage: 'AI 刷题管理',
        ai_tutor_domain_records: 'AI 用户使用记录',
        ai_tutor_proctor: 'AI 可疑普查',
        ai_tutor_domain_quota: '追加 AI 可用次数',
        ai_tutor_domain_batch: '批量设置 AI 积分 / 可用上限',
        domain_ai_tutor_manage: 'AI 刷题管理',
        domain_ai_tutor_records: 'AI 用户使用记录',
        domain_ai_tutor_proctor: 'AI 可疑普查',
        domain_ai_tutor_batch: '批量设置 AI 积分 / 可用上限',
        domain_ai_tutor_quota: '追加 AI 可用次数',
        'AI Problem Suggestion': 'AI 刷题建议',
    });
    ctx.i18n.load('en', {
        ai_suggestion: 'AI Problem Suggestion',
        ai_tutor_credit_detail: 'AI Credit Detail',
        ai_tutor_domain_manage: 'AI Tutor Access',
        ai_tutor_domain_records: 'AI Tutor User Records',
        ai_tutor_proctor: 'AI Suspicion Review',
        ai_tutor_domain_quota: 'AI Tutor Quota Adjustment',
        ai_tutor_domain_batch: 'AI Tutor Batch Adjustment',
        domain_ai_tutor_manage: 'AI Tutor Access',
        domain_ai_tutor_records: 'AI Tutor User Records',
        domain_ai_tutor_proctor: 'AI Suspicion Review',
        domain_ai_tutor_batch: 'AI Tutor Batch Adjustment',
        domain_ai_tutor_quota: 'AI Tutor Quota Adjustment',
    });
}
