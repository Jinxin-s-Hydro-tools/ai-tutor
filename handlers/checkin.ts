import {
    ForbiddenError, Handler, moment, ObjectId, PRIV,
} from 'hydrooj';

import {
    COLL_CHECKIN, COLL_CREDIT, COLL_DOMAIN_ACCESS,
} from '../constants';
import { addCreditGrant, expireCredits } from '../credits';
import {
    creditQuery, dailyCheckinCredit, getDomainAiConfig,
} from '../utils';

export class AiTutorDailyCheckinHandler extends Handler {
    async get() {
        this.response.redirect = this.url('homepage');
    }

    async getState(domainId: string, uid: number, amount: number) {
        const now = new Date();
        const dayKey = moment(now).format('YYYY-MM-DD');
        const currentMonth = moment(now).format('YYYY-MM');
        const checkinColl = this.ctx.db.collection(COLL_CHECKIN as any);
        const [todayDoc, balanceDoc, monthRows] = await Promise.all([
            checkinColl.findOne({ domainId, uid, dayKey }),
            this.ctx.db.collection(COLL_CREDIT as any).findOne(creditQuery(domainId, uid)),
            checkinColl.aggregate([
                { $match: { domainId, uid, monthKey: currentMonth } },
                { $group: { _id: null, days: { $sum: 1 }, credits: { $sum: '$amount' } } },
            ]).toArray(),
        ]);
        return {
            ok: true,
            amount,
            balance: (balanceDoc as any)?.balance ?? 0,
            todayChecked: !!todayDoc,
            monthDays: monthRows[0]?.days || 0,
            monthCredits: monthRows[0]?.credits || 0,
        };
    }

    async postClaim(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const currentDomainId = this.domain._id || domainId;
        const uid = this.user._id;
        const access = await this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({
            domainId: currentDomainId,
            uid,
            enabled: true,
        });
        if (!access) throw new ForbiddenError('AI Tutor is not enabled for this user in current domain.');
        const amount = dailyCheckinCredit(await getDomainAiConfig(this.ctx, currentDomainId));
        const now = new Date();
        const dayKey = moment(now).format('YYYY-MM-DD');
        const monthKey = moment(now).format('YYYY-MM');
        const checkinId = new ObjectId();
        const checkinColl = this.ctx.db.collection(COLL_CHECKIN as any);

        try {
            await checkinColl.insertOne({
                _id: checkinId,
                domainId: currentDomainId,
                uid,
                dayKey,
                monthKey,
                amount,
                at: now,
            } as any);
        } catch (e: any) {
            if (e?.code !== 11000) throw e;
            this.response.body = await this.getState(currentDomainId, uid, amount);
            return;
        }

        try {
            await addCreditGrant(this.ctx, {
                uid,
                domainId: currentDomainId,
                amount,
                kind: 'dailyCheckin',
                reason: '每日签到奖励积分',
                refType: 'checkin',
                refId: checkinId,
            });
        } catch (e) {
            await checkinColl.deleteOne({ _id: checkinId }).catch(() => { /* best effort rollback */ });
            throw e;
        }

        this.response.body = await this.getState(currentDomainId, uid, amount);
    }
}
