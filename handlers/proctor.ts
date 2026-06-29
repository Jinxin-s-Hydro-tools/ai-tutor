import { PassThrough } from 'stream';

import {
    Handler, NotFoundError, ObjectId, OplogModel, PERM, PRIV, PermissionError, param, query, Types,
} from 'hydrooj';

import {
    COLL_PROCTOR_EVENT, COLL_PROCTOR_SESSION,
} from '../constants';
import { escapeRegex } from '../utils';
import { generateProctorAiReview } from '../proctor/ai_review';
import { processProctorEvent, processRecordJudge } from '../proctor/session';

const PAGE_SIZE = 30;
const SEVERITIES = ['green', 'yellow', 'orange', 'red'] as const;
const REVIEW_STATES = ['unreviewed', 'false_positive', 'confirmed', 'watch'] as const;
const SEVERITY_LABELS: Record<string, string> = {
    green: '正常',
    yellow: '轻度',
    orange: '可疑',
    red: '严重',
};
const REVIEW_LABELS: Record<string, string> = {
    unreviewed: '未复核',
    false_positive: '误报',
    confirmed: '已确认',
    watch: '继续观察',
};

function objectIdText(value: any) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.toHexString === 'function') return value.toHexString();
    return String(value);
}

function scoreTotal(session: any) {
    return Math.max(0, Math.min(100, Number(session?.score?.total || 0)));
}

function scoreSeverity(session: any) {
    const severity = session?.score?.severity;
    if (SEVERITIES.includes(severity)) return severity;
    const total = scoreTotal(session);
    if (total >= 80) return 'red';
    if (total >= 50) return 'orange';
    if (total >= 20) return 'yellow';
    return 'green';
}

function maxPasteLines(session: any) {
    return Math.max(0, ...((session?.pastes || []).map((p: any) => Number(p?.lines || 0))));
}

function maxCodingRate(session: any) {
    let rate = 0;
    for (const item of session?.score?.breakdown || []) {
        if (item?.factor !== 'coding_rate') continue;
        const value = Number(item?.value ?? item?.inputs?.rate);
        if (Number.isFinite(value)) rate = Math.max(rate, value);
    }
    if (rate > 0) return rate;
    const lines = maxPasteLines(session);
    const away = Number(session?.tAwayTotal || 0);
    return lines > 0 && away > 0 ? lines / away : 0;
}

function styleFlips(session: any) {
    const item = (session?.score?.breakdown || []).find((e: any) => e?.factor === 'style_anomaly');
    const raw = item?.inputs?.flips ?? item?.value;
    const match = String(raw ?? '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function reviewState(session: any) {
    return session?.review?.state || 'unreviewed';
}

function formatEvidenceValue(value: any) {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) return value.map((item) => formatEvidenceValue(item)).join('；');
    if (typeof value === 'object') {
        return Object.entries(value)
            .map(([key, val]) => `${key}: ${formatEvidenceValue(val)}`)
            .join('；');
    }
    return String(value);
}

async function safeGetUser(UserModel: any, domainId: string, uid: number) {
    if (!uid) return null;
    return UserModel.getById(domainId, uid).catch(() => null);
}

async function safeGetProblem(ProblemModel: any, domainId: string, pid: any) {
    const numericPid = Number(pid);
    if (!Number.isSafeInteger(numericPid)) return null;
    return ProblemModel.get(domainId, numericPid).catch(() => null);
}

async function safeGetContest(ContestModel: any, domainId: string, tid: ObjectId | string) {
    if (!tid) return null;
    return ContestModel.get(domainId, tid instanceof ObjectId ? tid : new ObjectId(String(tid))).catch(() => null);
}

async function resolveContestInput(ContestModel: any, domainId: string, input: string) {
    const clean = (input || '').trim();
    if (!clean) return { tid: undefined, tdoc: null };
    if (ObjectId.isValid(clean)) {
        const tid = new ObjectId(clean);
        return { tid, tdoc: await safeGetContest(ContestModel, domainId, tid) };
    }
    const escaped = escapeRegex(clean);
    const rows = await ContestModel.getMulti(domainId, {
        title: { $regex: new RegExp(`^${escaped}$`, 'i') },
    }).limit(2).toArray();
    const fallbackRows = rows.length ? rows : await ContestModel.getMulti(domainId, {
        title: { $regex: new RegExp(escaped, 'i') },
    }).limit(2).toArray();
    const tdoc = fallbackRows[0] || null;
    return { tid: tdoc?.docId, tdoc };
}

async function resolveProblemInput(ProblemModel: any, domainId: string, input: string) {
    const clean = (input || '').trim();
    if (!clean) return { pid: '', pdoc: null };
    const numericPid = Number(clean);
    if (Number.isSafeInteger(numericPid)) return { pid: numericPid, pdoc: await safeGetProblem(ProblemModel, domainId, numericPid) };
    const escaped = escapeRegex(clean);
    const rows = await ProblemModel.getMulti(domainId, {
        $or: [
            { pid: clean },
            { title: { $regex: new RegExp(`^${escaped}$`, 'i') } },
        ],
    }).limit(2).toArray();
    const fallbackRows = rows.length ? rows : await ProblemModel.getMulti(domainId, {
        title: { $regex: new RegExp(escaped, 'i') },
    }).limit(2).toArray();
    const pdoc = fallbackRows[0] || null;
    return { pid: pdoc?.docId || clean, pdoc };
}

function canManageTdoc(handler: Handler, tdoc: any) {
    if (!tdoc) return handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
    if (handler.user.own(tdoc)) return true;
    if (tdoc.rule === 'homework') {
        return handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK) || handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
    }
    return handler.user.hasPerm(PERM.PERM_EDIT_CONTEST) || handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
}

function normalizeSession(session: any, users: Record<number, any>, contests: Record<string, any>, problems: Record<string, any>) {
    const tidText = objectIdText(session.tid);
    const problemKey = `${session.domainId}:${session.pid}`;
    const tdoc = contests[tidText];
    const pdoc = problems[problemKey];
    const breakdown = session?.score?.breakdown || [];
    const submissions = session?.submissions || [];
    const lastSubmission = submissions.length
        ? [...submissions].sort((a: any, b: any) => Number(b?.ts || 0) - Number(a?.ts || 0))[0]
        : null;
    const ridText = objectIdText(lastSubmission?.rid);
    return {
        ...session,
        sid: objectIdText(session._id),
        tidText,
        total: scoreTotal(session),
        severity: scoreSeverity(session),
        severityLabel: SEVERITY_LABELS[scoreSeverity(session)] || '正常',
        reviewState: reviewState(session),
        reviewLabel: REVIEW_LABELS[reviewState(session)] || '未复核',
        maxPasteLines: maxPasteLines(session),
        codingRate: maxCodingRate(session),
        styleFlips: styleFlips(session),
        user: users[session.uid],
        tdoc,
        pdoc,
        sourceLabel: tdoc?.rule === 'homework' ? '作业' : '比赛',
        resultLabel: session?.submissions?.length
            ? session.submissions[session.submissions.length - 1]?.status
            : null,
        lastSubmission,
        ridText,
        isFirstAttemptAc: !!session?.submissions?.some((s: any) => s?.isFirstAttempt && Number(s?.status) === 1),
        zeroEdit: breakdown.some((e: any) => e?.factor === 'no_post_paste_edit' && Number(e?.score || 0) > 0),
        hitEvidence: breakdown
            .filter((e: any) => Number(e?.score || 0) > 0)
            .sort((a: any, b: any) => Number(b?.score || 0) - Number(a?.score || 0))
            .map((e: any) => ({
                factor: e.factor,
                name: e.name || e.factor,
                score: Number(e.score || 0),
                weight: Number(e.weight || 0),
                severity: e.severity || 'low',
                reason: e.reason || '',
            })),
    };
}

export class AiTutorProctorHandler extends Handler {
    @query('tid', Types.String, true)
    @query('uid', Types.PositiveInt, true)
    @query('q', Types.String, true)
    @query('pid', Types.String, true)
    @query('severity', Types.Range(SEVERITIES as any), true)
    @query('review', Types.Range(REVIEW_STATES as any), true)
    @query('page', Types.PositiveInt, true)
    async get(
        domainId: string, tidText = '', uid?: number, q = '', pid = '', severity = '', review = '',
        page = 1,
    ) {
        const currentDomainId = this.domain._id || domainId;
        const ContestModel = global.Hydro.model.contest;
        const UserModel = global.Hydro.model.user;
        const ProblemModel = global.Hydro.model.problem;
        const cleanTid = (tidText || '').trim();
        const resolvedContest = await resolveContestInput(ContestModel, currentDomainId, cleanTid);
        const tid = resolvedContest.tid;
        const tdoc = resolvedContest.tdoc;
        if (tid && !tdoc) throw new NotFoundError('homework/contest', tid);
        if (!canManageTdoc(this, tdoc)) throw new PermissionError(tdoc?.rule === 'homework' ? PERM.PERM_EDIT_HOMEWORK : PERM.PERM_EDIT_DOMAIN);

        const match: any = { domainId: currentDomainId };
        if (tid) match.tid = tid;
        if (uid) match.uid = uid;
        const cleanPid = (pid || '').trim();
        if (cleanPid) {
            const resolvedProblem = await resolveProblemInput(ProblemModel, currentDomainId, cleanPid);
            match.pid = resolvedProblem.pid;
        }
        if (severity) match['score.severity'] = severity;
        if (review) {
            if (review === 'unreviewed') match['review.state'] = { $exists: false };
            else match['review.state'] = review;
        }

        const keyword = (q || '').trim().slice(0, 100);
        let matchedUserCount: number | null = null;
        if (keyword && !uid) {
            const maybeUid = Number(keyword);
            if (Number.isSafeInteger(maybeUid) && maybeUid > 0) {
                match.uid = maybeUid;
            } else {
                let matchedUsers: any[] = [];
                if (typeof UserModel.getPrefixList === 'function') {
                    matchedUsers = await UserModel.getPrefixList(currentDomainId, keyword, 100);
                }
                if (!matchedUsers.length) {
                    matchedUsers = await UserModel.getMulti({
                        unameLower: { $regex: escapeRegex(keyword.toLowerCase()) },
                    }).project({ _id: 1 }).limit(100).toArray();
                }
                const uids = matchedUsers.map((user: any) => user._id).filter((id: any) => Number.isSafeInteger(id));
                matchedUserCount = uids.length;
                match.uid = { $in: uids };
            }
        }

        const sessionColl = this.ctx.db.collection(COLL_PROCTOR_SESSION as any);
        const [rawRows, pageCount, totalCount] = await this.paginate(
            sessionColl.find(match).sort({ 'score.total': -1, lastEventAt: -1, _id: -1 }),
            page,
            PAGE_SIZE,
        );
        const [summaryRows, severityRows] = await Promise.all([
            sessionColl.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        sessions: { $sum: 1 },
                        maxScore: { $max: '$score.total' },
                        signalLost: { $sum: { $cond: [{ $in: ['signal_lost', { $ifNull: ['$flags', []] }] }, 1, 0] } },
                    },
                },
            ]).toArray(),
            sessionColl.aggregate([
                { $match: match },
                { $group: { _id: '$score.severity', count: { $sum: 1 } } },
            ]).toArray(),
        ]);

        const uids = [...new Set(rawRows.map((row: any) => row.uid).filter((x: any) => typeof x === 'number'))];
        const users: Record<number, any> = {};
        await Promise.all(uids.map(async (id) => { users[id] = await safeGetUser(UserModel, currentDomainId, id); }));

        const tids = [...new Set(rawRows.map((row: any) => objectIdText(row.tid)).filter(Boolean))];
        const contests: Record<string, any> = {};
        await Promise.all(tids.map(async (id) => { contests[id] = await safeGetContest(ContestModel, currentDomainId, id); }));

        const problemKeys = [...new Set(rawRows.map((row: any) => `${row.domainId}:${row.pid}`))];
        const problems: Record<string, any> = {};
        await Promise.all(problemKeys.map(async (key) => {
            const [problemDomainId, problemPid] = key.split(':');
            problems[key] = await safeGetProblem(ProblemModel, problemDomainId, problemPid);
        }));

        const severityCounts: Record<string, number> = { green: 0, yellow: 0, orange: 0, red: 0 };
        for (const row of severityRows) {
            const key = SEVERITIES.includes(row._id) ? row._id : 'green';
            severityCounts[key] += row.count || 0;
        }
        const summary = {
            sessions: summaryRows[0]?.sessions || 0,
            maxScore: Math.round(summaryRows[0]?.maxScore || 0),
            signalLost: summaryRows[0]?.signalLost || 0,
            severityCounts,
        };

        const rows = rawRows.map((row: any) => normalizeSession(row, users, contests, problems));
        const filterOptions = await this.getFilterOptions(currentDomainId, sessionColl, UserModel, ContestModel, ProblemModel);
        const queryParts: string[] = [];
        if (tid) queryParts.push(`tid=${encodeURIComponent(objectIdText(tid))}`);
        if (uid) queryParts.push(`uid=${uid}`);
        if (keyword) queryParts.push(`q=${encodeURIComponent(keyword)}`);
        if (cleanPid) queryParts.push(`pid=${encodeURIComponent(cleanPid)}`);
        if (severity) queryParts.push(`severity=${severity}`);
        if (review) queryParts.push(`review=${review}`);

        this.response.template = 'ai_tutor_proctor.html';
        this.response.body = {
            domain: this.domain,
            rows,
            filterOptions,
            summary,
            totalCount,
            page,
            pageCount,
            qs: queryParts.join('&'),
            tid: cleanTid || (tid ? tid.toHexString() : ''),
            uid: uid || '',
            q: keyword,
            pid: cleanPid,
            severity,
            review,
            tdoc,
            backfillMessage: String(this.request.query.backfill || ''),
            matchedUserCount,
            page_name: 'domain_ai_tutor_proctor',
        };
    }

    async postBackfill() {
        const currentDomainId = this.domain._id;
        const body = this.request.body || {};
        const ContestModel = global.Hydro.model.contest;
        const UserModel = global.Hydro.model.user;
        const ProblemModel = global.Hydro.model.problem;
        const RecordModel = global.Hydro.model.record;

        const cleanTid = String(body.tid || '').trim();
        const resolvedContest = await resolveContestInput(ContestModel, currentDomainId, cleanTid);
        const tid = resolvedContest.tid;
        const tdoc = resolvedContest.tdoc;
        if (tid && !tdoc) throw new NotFoundError('homework/contest', tid);
        if (!canManageTdoc(this, tdoc)) throw new PermissionError(tdoc?.rule === 'homework' ? PERM.PERM_EDIT_HOMEWORK : PERM.PERM_EDIT_DOMAIN);

        const queryRecord: any = {
            domainId: currentDomainId,
            contest: { $exists: true },
            code: { $exists: true, $ne: '' },
        };
        if (tid) queryRecord.contest = tid;
        const uid = Number(body.uid || 0);
        const keyword = String(body.q || '').trim().slice(0, 100);
        if (Number.isSafeInteger(uid) && uid > 0) {
            queryRecord.uid = uid;
        } else if (keyword) {
            const maybeUid = Number(keyword);
            if (Number.isSafeInteger(maybeUid) && maybeUid > 0) {
                queryRecord.uid = maybeUid;
            } else {
                let matchedUsers: any[] = [];
                if (typeof UserModel.getPrefixList === 'function') {
                    matchedUsers = await UserModel.getPrefixList(currentDomainId, keyword, 100);
                }
                if (!matchedUsers.length) {
                    matchedUsers = await UserModel.getMulti({
                        unameLower: { $regex: escapeRegex(keyword.toLowerCase()) },
                    }).project({ _id: 1 }).limit(100).toArray();
                }
                const uids = matchedUsers.map((user: any) => user._id).filter((id: any) => Number.isSafeInteger(id));
                queryRecord.uid = { $in: uids };
            }
        }
        const cleanPid = String(body.pid || '').trim();
        if (cleanPid) {
            const resolvedProblem = await resolveProblemInput(ProblemModel, currentDomainId, cleanPid);
            queryRecord.pid = resolvedProblem.pid;
        }
        const limitRaw = Number(body.limit || 300);
        const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 300, 2000));

        const rows = await RecordModel.coll.find(queryRecord)
            .sort({ _id: -1 })
            .limit(limit)
            .project({
                _id: 1,
                domainId: 1,
                contest: 1,
                uid: 1,
                pid: 1,
                status: 1,
                judgeAt: 1,
                code: 1,
            })
            .toArray();

        let createdOrUpdated = 0;
        for (const rdoc of rows) {
            const session = await processRecordJudge(this.ctx, rdoc).catch((e) => {
                console.error('[ai-tutor] failed to backfill proctor session:', e);
                return null;
            });
            if (session) createdOrUpdated++;
        }
        await OplogModel.log(this, 'ai_tutor.proctorBackfill', {
            query: {
                tid: objectIdText(tid),
                uid: queryRecord.uid,
                pid: queryRecord.pid,
                limit,
            },
            scanned: rows.length,
            createdOrUpdated,
        });

        const params = new URLSearchParams();
        if (cleanTid) params.set('tid', cleanTid);
        if (keyword) params.set('q', keyword);
        if (cleanPid) params.set('pid', cleanPid);
        params.set('backfill', `已拉取 ${rows.length} 条提交，生成/更新 ${createdOrUpdated} 个 Session。`);
        this.response.redirect = `${this.url('ai_tutor_proctor')}?${params.toString()}`;
    }

    async getFilterOptions(domainId: string, sessionColl: any, UserModel: any, ContestModel: any, ProblemModel: any) {
        const [tids, uids, pids] = await Promise.all([
            sessionColl.distinct('tid', { domainId }),
            sessionColl.distinct('uid', { domainId }),
            sessionColl.distinct('pid', { domainId }),
        ]);
        const contests = (await Promise.all(tids.slice(0, 80).map(async (tid: any) => {
            const tdoc = await safeGetContest(ContestModel, domainId, tid);
            if (!tdoc) return null;
            return {
                value: tdoc.title || objectIdText(tid),
                label: `${tdoc.rule === 'homework' ? '作业' : '比赛'} · ${objectIdText(tid)}`,
            };
        }))).filter(Boolean);
        const users = (await Promise.all(uids.slice(0, 120).map(async (uid: any) => {
            const udoc = await safeGetUser(UserModel, domainId, uid);
            if (!udoc) return { value: String(uid), label: `uid ${uid}` };
            const display = udoc.displayName || udoc.uname || String(uid);
            const label = udoc.uname && udoc.uname !== display ? `uid ${uid} · ${udoc.uname}` : `uid ${uid}`;
            return { value: display, label };
        }))).filter(Boolean);
        const problems = (await Promise.all(pids.slice(0, 120).map(async (pid: any) => {
            const pdoc = await safeGetProblem(ProblemModel, domainId, pid);
            if (!pdoc) return { value: String(pid), label: `pid ${pid}` };
            return {
                value: pdoc.title || pdoc.pid || String(pid),
                label: `${pdoc.pid || pdoc.docId || pid}`,
            };
        }))).filter(Boolean);
        return { contests, users, problems };
    }
}

export class AiTutorProctorSessionHandler extends Handler {
    session: any;
    tdoc: any;

    @param('sid', Types.ObjectId)
    async prepare(domainId: string, sid: ObjectId) {
        this.session = await this.ctx.db.collection(COLL_PROCTOR_SESSION as any).findOne({
            _id: sid,
            domainId: this.domain._id || domainId,
        } as any);
        if (!this.session) throw new NotFoundError('proctor session', sid);
        this.tdoc = await safeGetContest(global.Hydro.model.contest, this.session.domainId, this.session.tid);
        if (!canManageTdoc(this, this.tdoc)) throw new PermissionError(this.tdoc?.rule === 'homework' ? PERM.PERM_EDIT_HOMEWORK : PERM.PERM_EDIT_DOMAIN);
    }

    @param('sid', Types.ObjectId)
    async get(domainId: string, sid: ObjectId) {
        const UserModel = global.Hydro.model.user;
        const ProblemModel = global.Hydro.model.problem;
        const ContestModel = global.Hydro.model.contest;
        const [student, pdoc, events, comparisonRaw] = await Promise.all([
            safeGetUser(UserModel, this.session.domainId, this.session.uid),
            safeGetProblem(ProblemModel, this.session.domainId, this.session.pid),
            this.ctx.db.collection(COLL_PROCTOR_EVENT as any).find({ sessionId: sid }).sort({ ts: 1, _id: 1 }).limit(500).toArray(),
            this.ctx.db.collection(COLL_PROCTOR_SESSION as any).find({
                domainId: this.session.domainId,
                tid: this.session.tid,
                _id: { $ne: sid },
            }).sort({ 'score.total': -1, lastEventAt: -1 }).limit(8).toArray(),
        ]);
        const comparisonUids = [...new Set(comparisonRaw.map((row: any) => row.uid).filter((x: any) => typeof x === 'number'))];
        const users: Record<number, any> = {};
        await Promise.all(comparisonUids.map(async (id) => { users[id] = await safeGetUser(UserModel, this.session.domainId, id); }));
        users[this.session.uid] = student;
        const contests: Record<string, any> = { [objectIdText(this.session.tid)]: this.tdoc };
        const problems: Record<string, any> = {};
        const problemKey = `${this.session.domainId}:${this.session.pid}`;
        problems[problemKey] = pdoc;
        await Promise.all(comparisonRaw.map(async (row: any) => {
            const key = `${row.domainId}:${row.pid}`;
            if (!problems[key]) problems[key] = await safeGetProblem(ProblemModel, row.domainId, row.pid);
            const tidText = objectIdText(row.tid);
            if (!contests[tidText]) contests[tidText] = await safeGetContest(ContestModel, row.domainId, tidText);
        }));

        const session = normalizeSession(this.session, users, contests, problems);
        const comparison = [session, ...comparisonRaw.map((row: any) => normalizeSession(row, users, contests, problems))]
            .sort((a, b) => b.total - a.total)
            .slice(0, 9);
        const latestPaste = [...(this.session.pastes || [])].sort((a: any, b: any) => Number(b?.ts || 0) - Number(a?.ts || 0))[0];
        const rawSession = {
            ...this.session,
            score: {
                ...this.session.score,
                breakdown: (this.session.score?.breakdown || []).map((ev: any) => ({
                    ...ev,
                    inputsText: formatEvidenceValue(ev.inputs),
                    thresholdText: formatEvidenceValue(ev.threshold),
                })),
            },
        };
        const aiReview = this.session.aiReview || null;
        const aiReviewError = this.session.aiReviewError || null;

        this.response.template = 'ai_tutor_proctor_session.html';
        this.response.body = {
            domain: this.domain,
            session,
            rawSession,
            tdoc: this.tdoc,
            pdoc,
            student,
            events,
            comparison,
            latestPaste,
            aiReview,
            aiReviewError,
            page_name: 'domain_ai_tutor_proctor',
        };
    }

    @param('sid', Types.ObjectId)
    async postReview(domainId: string, sid: ObjectId) {
        const state = String(this.request.body?.state || '').trim();
        if (!REVIEW_STATES.includes(state as any) || state === 'unreviewed') {
            this.response.body = { error: '无效的复核状态。' };
            this.response.status = 400;
            return;
        }
        const note = String(this.request.body?.note || '').trim().slice(0, 500);
        const review = {
            state,
            note,
            operatorUid: this.user._id,
            updatedAt: new Date(),
        };
        await Promise.all([
            this.ctx.db.collection(COLL_PROCTOR_SESSION as any).updateOne(
                { _id: sid, domainId: this.session.domainId },
                { $set: { review } },
            ),
            OplogModel.log(this, 'ai_tutor.proctorReview', {
                sessionId: sid,
                state,
                note,
            }),
        ]);
        this.response.redirect = this.url('ai_tutor_proctor_session', { sid });
    }

    @param('sid', Types.ObjectId)
    async postAiReview(domainId: string, sid: ObjectId) {
        const UserModel = global.Hydro.model.user;
        const ProblemModel = global.Hydro.model.problem;
        const ContestModel = global.Hydro.model.contest;
        const [student, pdoc, events, comparisonRaw] = await Promise.all([
            safeGetUser(UserModel, this.session.domainId, this.session.uid),
            safeGetProblem(ProblemModel, this.session.domainId, this.session.pid),
            this.ctx.db.collection(COLL_PROCTOR_EVENT as any).find({ sessionId: sid }).sort({ ts: 1, _id: 1 }).limit(500).toArray(),
            this.ctx.db.collection(COLL_PROCTOR_SESSION as any).find({
                domainId: this.session.domainId,
                tid: this.session.tid,
                _id: { $ne: sid },
            }).sort({ 'score.total': -1, lastEventAt: -1 }).limit(8).toArray(),
        ]);
        const comparisonUids = [...new Set(comparisonRaw.map((row: any) => row.uid).filter((x: any) => typeof x === 'number'))];
        const users: Record<number, any> = {};
        await Promise.all(comparisonUids.map(async (id) => { users[id] = await safeGetUser(UserModel, this.session.domainId, id); }));
        users[this.session.uid] = student;
        const contests: Record<string, any> = { [objectIdText(this.session.tid)]: this.tdoc };
        const problems: Record<string, any> = {};
        const problemKey = `${this.session.domainId}:${this.session.pid}`;
        problems[problemKey] = pdoc;
        await Promise.all(comparisonRaw.map(async (row: any) => {
            const key = `${row.domainId}:${row.pid}`;
            if (!problems[key]) problems[key] = await safeGetProblem(ProblemModel, row.domainId, row.pid);
            const tidText = objectIdText(row.tid);
            if (!contests[tidText]) contests[tidText] = await safeGetContest(ContestModel, row.domainId, tidText);
        }));
        const session = normalizeSession(this.session, users, contests, problems);
        const comparison = [session, ...comparisonRaw.map((row: any) => normalizeSession(row, users, contests, problems))]
            .sort((a, b) => b.total - a.total)
            .slice(0, 9);

        const koa = this.context;
        const stream = new PassThrough();
        koa.req.socket.setTimeout(0);
        koa.req.socket.setNoDelay(true);
        koa.req.socket.setKeepAlive(true);
        koa.set('Content-Type', 'text/event-stream; charset=utf-8');
        koa.set('Cache-Control', 'no-cache, no-transform');
        koa.set('Connection', 'keep-alive');
        koa.set('X-Accel-Buffering', 'no');
        (koa as any).compress = false;
        this.request.websocket = true;
        koa.status = 200;
        koa.body = stream;

        const send = (obj: any) => {
            try {
                stream.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch { /* client closed */ }
        };
        const db = this.ctx.db;
        const operatorUid = this.user._id;
        const sessionDoc = this.session;
        const tdoc = this.tdoc;

        (async () => {
            try {
                const aiReview = await generateProctorAiReview(this.ctx, {
                    session: sessionDoc,
                    tdoc,
                    pdoc,
                    student,
                    events,
                    comparison,
                    operatorUid,
                    onChunk: (content) => send({ type: 'chunk', content }),
                });
                await Promise.all([
                    db.collection(COLL_PROCTOR_SESSION as any).updateOne(
                        { _id: sid, domainId: sessionDoc.domainId },
                        { $set: { aiReview, aiReviewError: null, updatedAt: new Date() } },
                    ),
                    OplogModel.log(this, 'ai_tutor.proctorAiReview', {
                        sessionId: sid,
                        model: aiReview.model,
                        providerKey: aiReview.providerKey,
                        durationMs: aiReview.durationMs,
                    }),
                ]);
                send({
                    type: 'done',
                    durationMs: aiReview.durationMs,
                    model: aiReview.model,
                    providerKey: aiReview.providerKey,
                    interrupted: !!aiReview.interrupted,
                });
                stream.end();
            } catch (e: any) {
                const message = e?.message || String(e);
                await db.collection(COLL_PROCTOR_SESSION as any).updateOne(
                    { _id: sid, domainId: sessionDoc.domainId },
                    {
                        $set: {
                            aiReviewError: {
                                message,
                                at: new Date(),
                                operatorUid,
                            },
                            updatedAt: new Date(),
                        },
                    },
                );
                send({ type: 'error', error: message });
                stream.end();
            }
        })();
    }
}

export class AiTutorProctorSessionExportHandler extends AiTutorProctorSessionHandler {
    @param('sid', Types.ObjectId)
    async get(domainId: string, sid: ObjectId) {
        const events = await this.ctx.db.collection(COLL_PROCTOR_EVENT as any)
            .find({ sessionId: sid }).sort({ ts: 1, _id: 1 }).toArray();
        this.binary(JSON.stringify({
            session: this.session,
            events,
            exportedAt: new Date(),
        }, null, 2), `proctor-session-${sid.toHexString()}.json`);
    }
}

export class AiTutorProctorHomeworkEntryHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = await safeGetContest(global.Hydro.model.contest, this.domain._id || domainId, tid);
        if (!tdoc || tdoc.rule !== 'homework') throw new NotFoundError('homework', tid);
        if (!canManageTdoc(this, tdoc)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
        this.response.redirect = this.url('ai_tutor_proctor', { query: { tid: tid.toHexString() } });
    }
}

export class AiTutorProctorEventHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const body = this.request.body || {};
        const tidText = String(body.tid || '').trim();
        const type = String(body.type || '').trim();
        const allowed = new Set(['enter', 'leave', 'return', 'paste', 'keystroke', 'submit', 'heartbeat']);
        if (!ObjectId.isValid(tidText) || !allowed.has(type)) {
            this.response.status = 400;
            this.response.body = { error: 'invalid proctor event' };
            return;
        }
        const pidRaw = body.pid;
        const pidNum = Number(pidRaw);
        const pid = Number.isSafeInteger(pidNum) ? pidNum : String(pidRaw || '').trim();
        if (!pid) {
            this.response.status = 400;
            this.response.body = { error: 'missing pid' };
            return;
        }
        const tid = new ObjectId(tidText);
        const tdoc = await global.Hydro.model.contest.get(this.domain._id || domainId, tid).catch(() => null);
        if (!tdoc || !['homework', 'acm', 'oi', 'ioi', 'strict'].includes(tdoc.rule)) {
            this.response.status = 404;
            this.response.body = { error: 'contest/homework not found' };
            return;
        }
        const rid = body.rid && ObjectId.isValid(String(body.rid)) ? new ObjectId(String(body.rid)) : undefined;
        const session = await processProctorEvent(this.ctx, {
            domainId: this.domain._id || domainId,
            uid: this.user._id,
            tid,
            pid,
            type,
            ts: body.ts,
            text: typeof body.text === 'string' ? body.text : '',
            lines: Number(body.lines || 0),
            length: Number(body.length || 0),
            count: Number(body.count || 0),
            rid,
            meta: {
                rid,
                lines: Number(body.lines || 0) || undefined,
                length: Number(body.length || 0) || undefined,
                count: Number(body.count || 0) || undefined,
                truncated: !!body.truncated,
            },
        });
        this.response.body = {
            ok: true,
            sessionId: session?._id?.toString?.(),
            score: session?.score?.total || 0,
        };
    }
}
