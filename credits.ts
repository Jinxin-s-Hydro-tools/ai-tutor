import { Context, moment, ObjectId } from 'hydrooj';

import {
    COLL_CREDIT, COLL_CREDIT_ADJUST, COLL_CREDIT_LEDGER, COLL_DOMAIN_ACCESS, CREDIT_EXPIRE_DAYS, WEEKLY_CREDIT_GRANT,
} from './constants';
import { AiDomainAccessDoc } from './types';
import { creditQuery, monthKey, monthlyQuotaBase, monthlyQuotaBonus } from './utils';

export async function grantWeeklyCredits(ctx: Context) {
    const creditColl = ctx.db.collection(COLL_CREDIT as any);
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    const now = new Date();
    const expiresAt = moment(now).add(CREDIT_EXPIRE_DAYS, 'days').toDate();
    const weekKey = moment(now).format('GGGG-[W]WW');
    const cursor = ctx.db.collection(COLL_DOMAIN_ACCESS as any).find({ enabled: true }).project({ domainId: 1, uid: 1 });
    let creditBatch: any[] = [];
    let ledgerBatch: any[] = [];
    let matchedUsers = 0;
    let modifiedUsers = 0;

    const flush = async () => {
        if (!creditBatch.length) return;
        const res = await creditColl.bulkWrite(creditBatch, { ordered: false });
        if (ledgerBatch.length) await ledgerColl.bulkWrite(ledgerBatch, { ordered: false });
        matchedUsers += res.matchedCount + res.upsertedCount;
        modifiedUsers += res.modifiedCount + res.upsertedCount;
        creditBatch = [];
        ledgerBatch = [];
    };

    for await (const accessDoc of cursor) {
        if (!accessDoc.domainId || !accessDoc.uid || accessDoc.uid <= 1) continue;
        creditBatch.push({
            updateOne: {
                filter: creditQuery(accessDoc.domainId, accessDoc.uid),
                update: {
                    $inc: {
                        balance: WEEKLY_CREDIT_GRANT,
                        totalEarned: WEEKLY_CREDIT_GRANT,
                    },
                    $set: {
                        domainId: accessDoc.domainId,
                        uid: accessDoc.uid,
                        weeklyGrantAt: now,
                        weeklyGrantWeek: weekKey,
                        updatedAt: now,
                    },
                    $setOnInsert: {
                        totalSpent: 0,
                    },
                },
                upsert: true,
            },
        });
        ledgerBatch.push({
            insertOne: {
                document: {
                    _id: new ObjectId(),
                    uid: accessDoc.uid,
                    domainId: accessDoc.domainId,
                    amount: WEEKLY_CREDIT_GRANT,
                    remaining: WEEKLY_CREDIT_GRANT,
                    kind: 'weeklyGrant',
                    reason: '每周自动发放积分',
                    weekKey,
                    expiresAt,
                    at: now,
                },
            },
        });
        if (creditBatch.length >= 500) await flush();
    }
    await flush();
    const stats = { amount: WEEKLY_CREDIT_GRANT, accounts: matchedUsers, changed: modifiedUsers, week: weekKey };
    console.log(`[ai-tutor] weekly credit grant: amount=${stats.amount}, accounts=${stats.accounts}, changed=${stats.changed}, week=${stats.week}`);
    return stats;
}

export async function grantCreditsToEnabledUsers(ctx: Context, options: {
    domainId: string;
    amount: number;
    reason: string;
    operatorUid?: number;
}) {
    const domainId = (options.domainId || '').trim();
    const amount = Math.trunc(options.amount);
    const reason = (options.reason || '').trim();
    if (!domainId) throw new Error('请填写域 ID。');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('积分值必须是正整数。');
    if (!reason) throw new Error('请填写加分原因。');
    const creditColl = ctx.db.collection(COLL_CREDIT as any);
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    const now = new Date();
    const expiresAt = moment(now).add(CREDIT_EXPIRE_DAYS, 'days').toDate();
    const cursor = ctx.db.collection(COLL_DOMAIN_ACCESS as any).find({ domainId, enabled: true }).project({ domainId: 1, uid: 1 });
    let creditBatch: any[] = [];
    let ledgerBatch: any[] = [];
    let matchedUsers = 0;
    let modifiedUsers = 0;

    const flush = async () => {
        if (!creditBatch.length) return;
        const res = await creditColl.bulkWrite(creditBatch, { ordered: false });
        if (ledgerBatch.length) await ledgerColl.bulkWrite(ledgerBatch, { ordered: false });
        matchedUsers += res.matchedCount + res.upsertedCount;
        modifiedUsers += res.modifiedCount + res.upsertedCount;
        creditBatch = [];
        ledgerBatch = [];
    };

    for await (const accessDoc of cursor) {
        if (!accessDoc.uid || accessDoc.uid <= 1) continue;
        creditBatch.push({
            updateOne: {
                filter: creditQuery(domainId, accessDoc.uid),
                update: {
                    $inc: {
                        balance: amount,
                        totalEarned: amount,
                    },
                    $set: {
                        domainId,
                        uid: accessDoc.uid,
                        updatedAt: now,
                    },
                    $setOnInsert: {
                        totalSpent: 0,
                    },
                },
                upsert: true,
            },
        });
        ledgerBatch.push({
            insertOne: {
                document: {
                    _id: new ObjectId(),
                    uid: accessDoc.uid,
                    domainId,
                    amount,
                    remaining: amount,
                    kind: 'manualScriptGrant',
                    reason,
                    operatorUid: options.operatorUid || 0,
                    expiresAt,
                    at: now,
                },
            },
        });
        if (creditBatch.length >= 500) await flush();
    }
    await flush();
    return { domainId, amount, reason, accounts: matchedUsers, changed: modifiedUsers, expiresAt };
}

export async function expireCredits(ctx: Context, uid?: number, domainId?: string) {
    const creditColl = ctx.db.collection(COLL_CREDIT as any);
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    const now = new Date();
    const query: any = {
        amount: { $gt: 0 },
        remaining: { $gt: 0 },
        expiresAt: { $lte: now },
    };
    if (uid) query.uid = uid;
    if (domainId) query.domainId = domainId;
    let expired = 0;
    let rows = 0;
    const cursor = ledgerColl.find(query).project({
        _id: 1, domainId: 1, uid: 1, remaining: 1, reason: 1, expiresAt: 1,
    });
    for await (const doc of cursor) {
        const remaining = Math.max(0, doc.remaining || 0);
        if (!remaining) continue;
        const res = await ledgerColl.updateOne(
            { _id: doc._id, remaining },
            { $set: { remaining: 0, expiredAt: now } },
        );
        if (!res.modifiedCount) continue;
        await creditColl.updateOne(
            creditQuery(doc.domainId, doc.uid),
            [
                {
                    $set: {
                        balance: { $max: [0, { $subtract: [{ $ifNull: ['$balance', 0] }, remaining] }] },
                        expiredCredits: { $add: [{ $ifNull: ['$expiredCredits', 0] }, remaining] },
                        updatedAt: now,
                    },
                },
            ] as any,
        );
        await ledgerColl.insertOne({
            _id: new ObjectId(),
            uid: doc.uid,
            domainId: doc.domainId,
            amount: -remaining,
            kind: 'expired',
            reason: '积分超过 30 天未使用，自动清空',
            refType: 'creditGrant',
            refId: doc._id,
            at: now,
        } as any);
        expired += remaining;
        rows++;
    }
    return { expired, rows };
}

export async function resetEnabledUserMonthlyQuota(ctx: Context, options: {
    domainId: string;
    quota: number;
    operatorUid?: number;
}) {
    const domainId = (options.domainId || '').trim();
    const quota = Math.trunc(options.quota);
    if (!domainId) throw new Error('请填写域 ID。');
    if (!Number.isSafeInteger(quota) || quota < 0) throw new Error('上限值必须是非负整数。');
    const now = new Date();
    const month = monthKey(now);
    const accessColl = ctx.db.collection(COLL_DOMAIN_ACCESS as any);
    const adjustColl = ctx.db.collection(COLL_CREDIT_ADJUST as any);
    const cursor = accessColl.find({ domainId, enabled: true }).project({
        domainId: 1, uid: 1, quotaMonth: 1, quotaLimit: 1, bonusMonth: 1, quotaBonus: 1,
    });
    let matched = 0;
    let changed = 0;
    let batch: any[] = [];
    let auditBatch: any[] = [];

    const flush = async () => {
        if (!batch.length) return;
        const res = await accessColl.bulkWrite(batch, { ordered: false });
        if (auditBatch.length) await adjustColl.bulkWrite(auditBatch, { ordered: false });
        changed += res.modifiedCount + res.upsertedCount;
        batch = [];
        auditBatch = [];
    };

    for await (const doc of cursor) {
        if (!doc.uid || doc.uid <= 1) continue;
        matched++;
        const beforeBase = monthlyQuotaBase(doc as AiDomainAccessDoc, month);
        const beforeBonus = monthlyQuotaBonus(doc as AiDomainAccessDoc, month);
        batch.push({
            updateOne: {
                filter: { domainId, uid: doc.uid, enabled: true },
                update: {
                    $set: {
                        quotaMonth: month,
                        quotaLimit: quota,
                        bonusMonth: month,
                        quotaBonus: 0,
                        updatedAt: now,
                        updatedBy: options.operatorUid || 0,
                    },
                },
            },
        });
        auditBatch.push({
            insertOne: {
                document: {
                    _id: new ObjectId(),
                    domainId,
                    uid: doc.uid,
                    amount: quota - beforeBase - beforeBonus,
                    monthKey: month,
                    kind: 'monthlyQuotaReset',
                    beforeBase,
                    afterBase: quota,
                    beforeBonus,
                    afterBonus: 0,
                    quota,
                    remark: '脚本重置本月 AI 可用上限',
                    operatorUid: options.operatorUid || 0,
                    at: now,
                },
            },
        });
        if (batch.length >= 500) await flush();
    }
    await flush();
    return { domainId, month, quota, matched, changed };
}

export async function addCreditGrant(ctx: Context, options: {
    domainId: string;
    uid: number;
    amount: number;
    kind: string;
    reason: string;
    pid?: number;
    rid?: ObjectId;
    refType?: string;
    refId?: ObjectId;
}) {
    const amount = Math.max(0, options.amount || 0);
    if (!amount) return null;
    const now = new Date();
    const expiresAt = moment(now).add(CREDIT_EXPIRE_DAYS, 'days').toDate();
    const ledgerId = new ObjectId();
    await ctx.db.collection(COLL_CREDIT as any).updateOne(
        creditQuery(options.domainId, options.uid),
        {
            $inc: { balance: amount, totalEarned: amount },
            $setOnInsert: { totalSpent: 0 },
            $set: { domainId: options.domainId, uid: options.uid, updatedAt: now },
        },
        { upsert: true },
    );
    await ctx.db.collection(COLL_CREDIT_LEDGER as any).insertOne({
        _id: ledgerId,
        uid: options.uid,
        domainId: options.domainId,
        amount,
        remaining: amount,
        kind: options.kind,
        reason: options.reason,
        pid: options.pid,
        rid: options.rid,
        refType: options.refType,
        refId: options.refId,
        expiresAt,
        at: now,
    } as any);
    return ledgerId;
}

export async function bootstrapCreditLots(ctx: Context) {
    const creditColl = ctx.db.collection(COLL_CREDIT as any);
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    const now = new Date();
    const expiresAt = moment(now).add(CREDIT_EXPIRE_DAYS, 'days').toDate();
    const cursor = creditColl.find({ domainId: { $exists: true }, uid: { $exists: true }, balance: { $gt: 0 } }).project({ _id: 1, domainId: 1, uid: 1, balance: 1 });
    let created = 0;
    for await (const doc of cursor) {
        const active = await ledgerColl.aggregate([
            {
                $match: {
                    uid: doc.uid,
                    domainId: doc.domainId,
                    amount: { $gt: 0 },
                    remaining: { $gt: 0 },
                    expiresAt: { $gt: now },
                },
            },
            { $group: { _id: null, total: { $sum: '$remaining' } } },
        ]).toArray();
        const activeRemaining = active[0]?.total || 0;
        const carry = Math.max(0, (doc.balance || 0) - activeRemaining);
        if (!carry) continue;
        await ledgerColl.insertOne({
            _id: new ObjectId(),
            uid: doc.uid,
            domainId: doc.domainId,
            amount: carry,
            remaining: carry,
            kind: 'legacyCarryover',
            reason: '历史积分结转，有效期从本规则启用开始计算',
            expiresAt,
            at: now,
        } as any);
        created++;
    }
    if (created) console.log(`[ai-tutor] bootstrap expiring credit lots: users=${created}`);
}

export async function deductCredit(ctx: Context, uid: number, meta: {
    domainId: string;
    pid?: number;
    rid?: ObjectId;
    reason: string;
}) {
    await expireCredits(ctx, uid, meta.domainId);
    const now = new Date();
    const creditColl = ctx.db.collection(COLL_CREDIT as any);
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    const deductRes = await creditColl.updateOne(
        { ...creditQuery(meta.domainId, uid), balance: { $gte: 1 } },
        { $inc: { balance: -1, totalSpent: 1 }, $set: { updatedAt: now } },
    );
    if (deductRes.modifiedCount === 0) return null;

    let left = 1;
    const allocations: { ledgerId: ObjectId; amount: number }[] = [];
    const cursor = ledgerColl.find({
        uid,
        domainId: meta.domainId,
        amount: { $gt: 0 },
        remaining: { $gt: 0 },
        expiresAt: { $gt: now },
    }).sort({ expiresAt: 1, at: 1, _id: 1 });
    for await (const doc of cursor) {
        if (left <= 0) break;
        const take = Math.min(left, doc.remaining || 0);
        if (!take) continue;
        const res = await ledgerColl.updateOne(
            { _id: doc._id, remaining: { $gte: take } },
            { $inc: { remaining: -take } },
        );
        if (!res.modifiedCount) continue;
        allocations.push({ ledgerId: doc._id, amount: take });
        left -= take;
    }

    const ledgerId = new ObjectId();
    await ledgerColl.insertOne({
        _id: ledgerId,
        uid,
        domainId: meta.domainId,
        amount: -1,
        kind: 'aiAnalysis',
        reason: meta.reason,
        pid: meta.pid,
        rid: meta.rid,
        allocations,
        at: now,
    } as any).catch(() => { /* ledger is best-effort */ });
    return { ledgerId, allocations };
}

export async function refundDeductedCredit(ctx: Context, domainId: string, uid: number, deduction: any) {
    const now = new Date();
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    await ctx.db.collection(COLL_CREDIT as any).updateOne(
        creditQuery(domainId, uid),
        { $inc: { balance: 1, totalSpent: -1 }, $set: { updatedAt: now } },
    );
    for (const allocation of deduction?.allocations || []) {
        await ledgerColl.updateOne(
            { _id: allocation.ledgerId },
            { $inc: { remaining: allocation.amount } },
        );
    }
    if (deduction?.ledgerId) {
        await ledgerColl.updateOne({ _id: deduction.ledgerId }, { $set: { refundedAt: now } });
    }
    await ledgerColl.insertOne({
        _id: new ObjectId(),
        uid,
        domainId,
        amount: 1,
        remaining: 0,
        kind: 'refund',
        reason: 'AI 调用失败，退回已扣积分',
        refType: 'deduction',
        refId: deduction?.ledgerId,
        at: now,
    } as any).catch(() => { /* ledger is best-effort */ });
}

export async function adjustCreditManually(ctx: Context, options: {
    domainId: string;
    uid: number;
    amount: number;
    reason: string;
    operatorUid: number;
}) {
    const amount = Math.trunc(options.amount || 0);
    if (!amount) return null;
    await expireCredits(ctx, options.uid, options.domainId);
    const now = new Date();
    const creditColl = ctx.db.collection(COLL_CREDIT as any);
    const ledgerColl = ctx.db.collection(COLL_CREDIT_LEDGER as any);
    const beforeDoc = await creditColl.findOne(creditQuery(options.domainId, options.uid));
    const beforeBalance = Math.max(0, (beforeDoc as any)?.balance || 0);
    if (amount < 0 && beforeBalance < -amount) return null;

    const ledgerId = new ObjectId();
    if (amount > 0) {
        const expiresAt = moment(now).add(CREDIT_EXPIRE_DAYS, 'days').toDate();
        await creditColl.updateOne(
            creditQuery(options.domainId, options.uid),
            {
                $inc: { balance: amount, totalEarned: amount },
                $setOnInsert: { totalSpent: 0 },
                $set: { domainId: options.domainId, uid: options.uid, updatedAt: now },
            },
            { upsert: true },
        );
        await ledgerColl.insertOne({
            _id: ledgerId,
            uid: options.uid,
            domainId: options.domainId,
            amount,
            remaining: amount,
            kind: 'manual',
            reason: options.reason,
            operatorUid: options.operatorUid,
            expiresAt,
            at: now,
        } as any);
    } else {
        const debit = -amount;
        const res = await creditColl.updateOne(
            { ...creditQuery(options.domainId, options.uid), balance: { $gte: debit } },
            {
                $inc: { balance: -debit, totalSpent: debit },
                $set: { domainId: options.domainId, uid: options.uid, updatedAt: now },
                $setOnInsert: { totalEarned: 0 },
            },
            { upsert: false },
        );
        if (!res.modifiedCount) return null;

        let left = debit;
        const allocations: { ledgerId: ObjectId; amount: number }[] = [];
        const cursor = ledgerColl.find({
            uid: options.uid,
            domainId: options.domainId,
            amount: { $gt: 0 },
            remaining: { $gt: 0 },
            expiresAt: { $gt: now },
        }).sort({ expiresAt: 1, at: 1, _id: 1 });
        for await (const doc of cursor) {
            if (left <= 0) break;
            const take = Math.min(left, doc.remaining || 0);
            if (!take) continue;
            const takeRes = await ledgerColl.updateOne(
                { _id: doc._id, remaining: { $gte: take } },
                { $inc: { remaining: -take } },
            );
            if (!takeRes.modifiedCount) continue;
            allocations.push({ ledgerId: doc._id, amount: take });
            left -= take;
        }
        await ledgerColl.insertOne({
            _id: ledgerId,
            uid: options.uid,
            domainId: options.domainId,
            amount,
            kind: 'manual',
            reason: options.reason,
            operatorUid: options.operatorUid,
            allocations,
            at: now,
        } as any);
    }

    const afterDoc = await creditColl.findOne(creditQuery(options.domainId, options.uid));
    return {
        ledgerId,
        beforeBalance,
        afterBalance: Math.max(0, (afterDoc as any)?.balance || 0),
    };
}

export async function adjustCreditClamped(ctx: Context, options: {
    domainId: string;
    uid: number;
    amount: number;
    reason: string;
    operatorUid: number;
}) {
    const current = await ctx.db.collection(COLL_CREDIT as any).findOne(creditQuery(options.domainId, options.uid));
    const beforeBalance = Math.max(0, (current as any)?.balance || 0);
    const amount = options.amount < 0 ? -Math.min(beforeBalance, -options.amount) : options.amount;
    if (!amount) return { beforeBalance, afterBalance: beforeBalance, effectiveAmount: 0, ledgerId: null };
    const result = await adjustCreditManually(ctx, { ...options, amount });
    return { ...result, effectiveAmount: amount };
}

export async function adjustQuotaBonusClamped(ctx: Context, options: {
    domainId: string;
    uid: number;
    amount: number;
    reason: string;
    operatorUid: number;
}) {
    const now = new Date();
    const month = monthKey(now);
    const accessColl = ctx.db.collection(COLL_DOMAIN_ACCESS as any);
    const existing = await accessColl.findOne({ domainId: options.domainId, uid: options.uid }) as AiDomainAccessDoc | null;
    const beforeBonus = existing?.bonusMonth === month ? Math.max(0, existing.quotaBonus || 0) : 0;
    const afterBonus = Math.max(0, beforeBonus + Math.trunc(options.amount || 0));
    const effectiveAmount = afterBonus - beforeBonus;
    await accessColl.updateOne(
        { domainId: options.domainId, uid: options.uid },
        {
            $setOnInsert: { enabled: false },
            $set: {
                bonusMonth: month,
                quotaBonus: afterBonus,
                updatedAt: now,
                updatedBy: options.operatorUid,
            },
        },
        { upsert: true },
    );
    return { beforeBonus, afterBonus, effectiveAmount, month };
}
