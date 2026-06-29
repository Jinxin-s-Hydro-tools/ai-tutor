import { Context, ObjectId } from 'hydrooj';

import { COLL_PROCTOR_EVENT, COLL_PROCTOR_SESSION } from '../constants';
import { effectiveCodeLines, extractStyleFingerprint, StyleFingerprint } from './fingerprint';
import { computeProctorScore } from './scoring';

const STATUS_ACCEPTED = 1;
const MAX_PASTE_TEXT = 64 * 1024;

function asDate(value: any) {
    const date = value ? new Date(value) : new Date();
    return Number.isFinite(date.getTime()) ? date : new Date();
}

function objectIdDate(id: any) {
    if (id && typeof id.getTimestamp === 'function') return id.getTimestamp();
    return new Date();
}

function sameRid(a: any, b: any) {
    return String(a || '') === String(b || '');
}

async function loadProblem(domainId: string, pid: any) {
    const numericPid = Number(pid);
    if (!Number.isSafeInteger(numericPid)) return null;
    return global.Hydro.model.problem.get(domainId, numericPid).catch(() => null);
}

async function buildHistoryFingerprints(domainId: string, uid: number, tid: any, before: Date): Promise<StyleFingerprint[]> {
    const RecordModel = global.Hydro.model.record;
    const rows = await RecordModel.coll.find({
        domainId,
        uid,
        status: STATUS_ACCEPTED,
        code: { $exists: true, $ne: '' },
        contest: { $ne: tid },
        _id: { $lt: ObjectId.createFromTime(Math.floor(before.getTime() / 1000)) },
    }).sort({ _id: -1 }).limit(20).project({ code: 1 }).toArray();
    return rows.map((row: any) => extractStyleFingerprint(row.code || ''));
}

function addActiveUntil(session: any, ts: Date) {
    if (!session.lastActiveAt) return;
    const last = asDate(session.lastActiveAt);
    const delta = Math.max(0, Math.round((ts.getTime() - last.getTime()) / 1000));
    if (delta > 0 && delta <= 120) session.tInProblemActive = Math.max(0, Number(session.tInProblemActive || 0) + delta);
}

function closeAway(session: any, ts: Date) {
    if (!session.currentAwayStart) return;
    const start = asDate(session.currentAwayStart);
    const duration = Math.max(0, Math.round((ts.getTime() - start.getTime()) / 1000));
    if (duration >= 10) {
        session.awayPeriods ||= [];
        session.awayPeriods.push({ start, end: ts, duration });
        session.tAwayTotal = Math.max(0, Number(session.tAwayTotal || 0) + duration);
    }
    delete session.currentAwayStart;
}

async function getOrCreateSession(ctx: Context, domainId: string, tid: ObjectId, uid: number, pid: any, ts: Date) {
    const coll = ctx.db.collection(COLL_PROCTOR_SESSION as any);
    const query = { domainId, tid, uid, pid };
    let session = await coll.findOne(query);
    if (session) return session;
    session = {
        _id: new ObjectId(),
        domainId,
        tid,
        uid,
        pid,
        startedAt: ts,
        lastEventAt: ts,
        endedAt: null,
        tInProblemActive: 0,
        tAwayTotal: 0,
        awayPeriods: [],
        pastes: [],
        submissions: [],
        flags: [],
        score: {
            total: 0,
            severity: 'green',
            breakdown: [],
            computedAt: ts,
        },
        createdAt: new Date(),
    };
    try {
        await coll.insertOne(session as any);
        return session;
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        return await coll.findOne(query);
    }
}

async function saveAndScore(ctx: Context, session: any) {
    const [pdoc, historyFingerprints] = await Promise.all([
        loadProblem(session.domainId, session.pid),
        buildHistoryFingerprints(session.domainId, session.uid, session.tid, asDate(session.startedAt)),
    ]);
    session.score = computeProctorScore(session, { pdoc, historyFingerprints });
    session.lastEventAt ||= new Date();
    await ctx.db.collection(COLL_PROCTOR_SESSION as any).updateOne(
        { _id: session._id },
        {
            $set: {
                startedAt: session.startedAt,
                lastEventAt: session.lastEventAt,
                endedAt: session.endedAt || null,
                tInProblemActive: session.tInProblemActive || 0,
                tAwayTotal: session.tAwayTotal || 0,
                awayPeriods: session.awayPeriods || [],
                pastes: session.pastes || [],
                submissions: session.submissions || [],
                flags: session.flags || [],
                currentAwayStart: session.currentAwayStart || null,
                lastActiveAt: session.lastActiveAt || null,
                lastReturnAt: session.lastReturnAt || null,
                lastPasteAt: session.lastPasteAt || null,
                keystrokesSinceLastPaste: session.keystrokesSinceLastPaste || 0,
                latestCode: session.latestCode || '',
                score: session.score,
                updatedAt: new Date(),
            },
        },
    );
    return session;
}

export async function processProctorEvent(ctx: Context, payload: {
    domainId: string;
    uid: number;
    tid: ObjectId;
    pid: number | string;
    type: string;
    ts?: Date | string | number;
    text?: string;
    lines?: number;
    length?: number;
    count?: number;
    rid?: ObjectId;
    meta?: Record<string, any>;
}) {
    const ts = asDate(payload.ts);
    const session = await getOrCreateSession(ctx, payload.domainId, payload.tid, payload.uid, payload.pid, ts);
    session.lastEventAt = ts;
    session.startedAt ||= ts;
    session.tInProblemActive ||= 0;
    session.tAwayTotal ||= 0;
    session.awayPeriods ||= [];
    session.pastes ||= [];
    session.submissions ||= [];
    session.flags ||= [];

    const type = payload.type;
    if (type === 'enter') {
        session.lastActiveAt = ts;
    } else if (type === 'leave') {
        addActiveUntil(session, ts);
        session.currentAwayStart = ts;
        delete session.lastActiveAt;
    } else if (type === 'return') {
        closeAway(session, ts);
        session.lastReturnAt = ts;
        session.lastActiveAt = ts;
    } else if (type === 'heartbeat') {
        addActiveUntil(session, ts);
        session.lastActiveAt = ts;
    } else if (type === 'keystroke') {
        addActiveUntil(session, ts);
        session.lastActiveAt = ts;
        session.keystrokesSinceLastPaste = Math.max(0, Number(session.keystrokesSinceLastPaste || 0) + Math.max(1, Number(payload.count || 1)));
    } else if (type === 'paste') {
        addActiveUntil(session, ts);
        session.lastActiveAt = ts;
        const text = String(payload.text || '').slice(0, MAX_PASTE_TEXT);
        const lines = Math.max(0, Math.trunc(Number(payload.lines || effectiveCodeLines(text))));
        const paste = {
            ts,
            length: Math.min(MAX_PASTE_TEXT, Math.max(0, Number(payload.length || text.length))),
            lines,
            text,
            truncated: String(payload.text || '').length > MAX_PASTE_TEXT,
            awayBeforeMs: session.lastReturnAt ? Math.max(0, ts.getTime() - asDate(session.lastReturnAt).getTime()) : null,
            awaySinceSessionStart: Number(session.tAwayTotal || 0),
            activeSinceSessionStart: Number(session.tInProblemActive || 0),
            fingerprint: extractStyleFingerprint(text),
        };
        session.pastes.push(paste);
        session.lastPasteAt = ts;
        session.keystrokesSinceLastPaste = 0;
    } else if (type === 'submit') {
        addActiveUntil(session, ts);
        session.lastActiveAt = ts;
        const rid = payload.rid;
        if (rid && !session.submissions.some((item: any) => sameRid(item.rid, rid))) {
            session.submissions.push({
                ts,
                rid,
                status: null,
                isFirstAttempt: false,
                keystrokesSinceLastPaste: session.keystrokesSinceLastPaste || 0,
                msSinceLastPaste: session.lastPasteAt ? Math.max(0, ts.getTime() - asDate(session.lastPasteAt).getTime()) : null,
            });
        }
    }

    await ctx.db.collection(COLL_PROCTOR_EVENT as any).insertOne({
        _id: new ObjectId(),
        sessionId: session._id,
        domainId: payload.domainId,
        tid: payload.tid,
        uid: payload.uid,
        pid: payload.pid,
        type,
        ts,
        meta: payload.meta || {
            lines: payload.lines,
            length: payload.length,
            count: payload.count,
            rid: payload.rid,
        },
    } as any);
    return await saveAndScore(ctx, session);
}

export async function processRecordJudge(ctx: Context, rdoc: any) {
    if (!rdoc?.contest || rdoc.contest.toString().startsWith('0'.repeat(23))) return null;
    const ts = objectIdDate(rdoc._id);
    const session = await getOrCreateSession(ctx, rdoc.domainId, rdoc.contest, rdoc.uid, rdoc.pid, ts);
    session.lastEventAt = rdoc.judgeAt || ts;
    session.submissions ||= [];
    session.pastes ||= [];
    const RecordModel = global.Hydro.model.record;
    const attemptsBefore = await RecordModel.coll.countDocuments({
        domainId: rdoc.domainId,
        uid: rdoc.uid,
        pid: rdoc.pid,
        contest: rdoc.contest,
        _id: { $lt: rdoc._id },
    });
    const submitTs = objectIdDate(rdoc._id);
    const entry = {
        ts: submitTs,
        rid: rdoc._id,
        status: rdoc.status,
        isFirstAttempt: attemptsBefore === 0,
        keystrokesSinceLastPaste: session.keystrokesSinceLastPaste || 0,
        msSinceLastPaste: session.lastPasteAt ? Math.max(0, submitTs.getTime() - asDate(session.lastPasteAt).getTime()) : null,
    };
    session.submissions = session.submissions.filter((item: any) => !sameRid(item.rid, rdoc._id)).concat(entry);
    if (rdoc.code) {
        session.latestCode = String(rdoc.code).slice(0, MAX_PASTE_TEXT);
        const inferredPaste = {
            ts: submitTs,
            length: session.latestCode.length,
            lines: effectiveCodeLines(session.latestCode),
            text: session.latestCode,
            inferredFromSubmission: true,
            awayBeforeMs: null,
            awaySinceSessionStart: Number(session.tAwayTotal || 0),
            activeSinceSessionStart: Number(session.tInProblemActive || 0),
            fingerprint: extractStyleFingerprint(session.latestCode),
        };
        const inferredIndex = session.pastes.findIndex((paste: any) => paste?.inferredFromSubmission);
        if (inferredIndex >= 0) {
            session.pastes[inferredIndex] = {
                ...session.pastes[inferredIndex],
                ...inferredPaste,
            };
        } else if (!session.pastes.some((paste: any) => !paste?.inferredFromSubmission)) {
            session.pastes.push(inferredPaste);
        }
    }
    await ctx.db.collection(COLL_PROCTOR_EVENT as any).updateOne(
        { sessionId: session._id, type: 'submit', 'meta.rid': rdoc._id },
        {
            $setOnInsert: {
                _id: new ObjectId(),
                sessionId: session._id,
                domainId: rdoc.domainId,
                tid: rdoc.contest,
                uid: rdoc.uid,
                pid: rdoc.pid,
                type: 'submit',
                ts: submitTs,
                meta: { rid: rdoc._id, status: rdoc.status, source: 'record/judge' },
            },
        },
        { upsert: true },
    );
    return await saveAndScore(ctx, session);
}
