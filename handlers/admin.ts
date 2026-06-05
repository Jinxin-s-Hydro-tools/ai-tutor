import {
    Handler, query, PERM, Types,
} from 'hydrooj';

import {
    COLL_CREDIT, COLL_USAGE,
} from '../constants';
import {
    cfg, creditId, escapeRegex, monthKey,
} from '../utils';

export class AiTutorDomainRecordsHandler extends Handler {
    static readonly USAGE_PAGE_SIZE = 30;

    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    @query('page', Types.PositiveInt, true)
    @query('q', Types.String, true)
    async get(domainId: string, page = 1, q = '') {
        const currentDomainId = this.domain._id || domainId;
        const usageColl = this.ctx.db.collection(COLL_USAGE as any);
        const balanceColl = this.ctx.db.collection(COLL_CREDIT as any);
        const month = monthKey();
        const UserModel = global.Hydro.model.user;
        const keyword = (q || '').trim().slice(0, 100);

        // ── Per-user usage this month ──
        const byUserRaw = await usageColl.aggregate([
            { $match: { domainId: currentDomainId, monthKey: month } },
            {
                $group: {
                    _id: '$uid',
                    calls: { $sum: 1 },
                    lastAt: { $max: '$at' },
                    avgDuration: { $avg: '$durationMs' },
                },
            },
            { $sort: { calls: -1 } },
            { $limit: 100 },
        ]).toArray();

        const uids = byUserRaw.map((x) => x._id as number);
        // Fetch user docs in batch
        const userDocs: any[] = uids.length
            ? await Promise.all(uids.map((u) => UserModel.getById(this.domain._id, u).catch(() => null)))
            : [];
        const userMap: Record<number, any> = {};
        userDocs.forEach((u, i) => { if (u) userMap[uids[i]] = u; });

        // Fetch credit balances in the current domain only.
        const balanceDocs = uids.length
            ? await balanceColl.find({
                _id: { $in: uids.map((uid) => creditId(currentDomainId, uid)) } as any,
            }).toArray()
            : [];
        const balanceMap: Record<number, any> = {};
        balanceDocs.forEach((b) => { balanceMap[b.uid as any as number] = b; });

        const monthlyCap = cfg<number>('monthlyQuota', 30);
        const byUser = byUserRaw.map((r) => ({
            uid: r._id,
            user: userMap[r._id as any as number],
            calls: r.calls,
            cap: monthlyCap,
            usageRatio: monthlyCap > 0 ? r.calls / monthlyCap : (r.calls > 0 ? 1 : 0),
            lastAt: r.lastAt,
            avgDurationMs: Math.round(r.avgDuration || 0),
            balance: balanceMap[r._id as any as number]?.balance ?? 0,
            totalEarned: balanceMap[r._id as any as number]?.totalEarned ?? 0,
            totalSpent: balanceMap[r._id as any as number]?.totalSpent ?? 0,
        }));

        // ── Call history (paginated, optionally filtered by username) ──
        const recentQuery: any = { domainId: currentDomainId };
        let matchedUserCount: number | null = null;
        if (keyword) {
            const matchedUsers = await UserModel.getMulti({
                unameLower: { $regex: escapeRegex(keyword.toLowerCase()) },
            }).project({ _id: 1 }).toArray();
            const matchedUids = matchedUsers.map((user: any) => user._id);
            matchedUserCount = matchedUids.length;
            recentQuery.uid = { $in: matchedUids };
        }
        const [recentRaw, recentPageCount, recentCount] = await this.paginate(
            usageColl.find(recentQuery).sort({ at: -1, _id: -1 }),
            page,
            AiTutorDomainRecordsHandler.USAGE_PAGE_SIZE,
        );
        const recentUids = [...new Set(recentRaw.map((r: any) => r.uid))];
        const recentUserMap: Record<number, any> = { ...userMap };
        for (const u of recentUids) {
            if (!recentUserMap[u as any as number]) {
                try { recentUserMap[u as any as number] = await UserModel.getById(this.domain._id, u); } catch { /* */ }
            }
        }
        const missingPidRows = recentRaw.filter((r: any) => !r.pid && r.rid && r.domainId);
        if (missingPidRows.length) {
            const recordPairs = await Promise.all(missingPidRows.map(async (r: any) => {
                const rdoc = await global.Hydro.model.record.get(r.domainId, r.rid).catch(() => null);
                return [String(r._id), rdoc?.pid || null];
            }));
            const pidByUsageId: Record<string, number> = {};
            for (const [usageId, pid] of recordPairs as any[]) {
                if (pid) pidByUsageId[usageId] = pid;
            }
            recentRaw.forEach((r: any) => {
                if (!r.pid && pidByUsageId[String(r._id)]) r.pid = pidByUsageId[String(r._id)];
            });
        }
        const problemKeys = [...new Set(recentRaw
            .filter((r: any) => r.domainId && r.pid)
            .map((r: any) => `${r.domainId}:${r.pid}`))];
        const problemPairs = problemKeys.length
            ? await Promise.all(problemKeys.map(async (key) => {
                const [problemDomainId, pidText] = key.split(':');
                const pid = Number(pidText);
                if (!Number.isSafeInteger(pid)) return [key, null];
                const pdoc = await global.Hydro.model.problem.get(problemDomainId, pid).catch(() => null);
                return [key, pdoc];
            }))
            : [];
        const problems: Record<string, any> = {};
        for (const [key, pdoc] of problemPairs as any[]) {
            if (!pdoc) continue;
            const displayPid = pdoc.pid || `P${pdoc.docId || pdoc._id}`;
            problems[key] = {
                ...pdoc,
                display: `${displayPid}. ${pdoc.title || ''}`.trim(),
            };
        }
        const recent = recentRaw.map((r: any) => ({
            ...r,
            user: recentUserMap[r.uid as any as number],
        }));

        // ── Overall this-month totals ──
        const [totalCalls, distinctUsers] = await Promise.all([
            usageColl.countDocuments({ domainId: currentDomainId, monthKey: month }),
            usageColl.distinct('uid', { domainId: currentDomainId, monthKey: month }),
        ]);

        this.response.template = 'ai_tutor_admin.html';
        this.response.body = {
            domain: this.domain,
            month,
            monthlyCap,
            byUser,
            recent,
            recentPage: page,
            recentPageCount,
            recentCount,
            problems,
            q: keyword,
            matchedUserCount,
            totalCalls,
            distinctUserCount: distinctUsers.length,
            page_name: 'domain_ai_tutor_records',
        };
    }
}
