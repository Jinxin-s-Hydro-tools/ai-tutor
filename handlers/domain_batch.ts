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

export class AiTutorDomainBatchHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get() {
        await this.renderPage();
    }

    async renderPage(extra: any = {}) {
        const UserModel = global.Hydro.model.user;
        const groups = await UserModel.listGroup(this.domain._id);
        this.response.template = 'ai_tutor_domain_batch.html';
        this.response.body = {
            domain: this.domain,
            groups,
            textMode: extra.textMode || 'both',
            importText: extra.importText || '',
            groupName: extra.groupName || '',
            groupAction: extra.groupAction || 'credit',
            groupAmount: extra.groupAmount ?? 1,
            remark: extra.remark || '',
            messages: extra.messages || [],
            previewRows: extra.previewRows || [],
            previewType: extra.previewType || '',
            canImport: !!extra.canImport,
            page_name: 'domain_ai_tutor_batch',
        };
    }

    async assertDomainWritable(domainId: string) {
        if (domainId === this.domain._id) return true;
        if (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) return true;
        return false;
    }

    async buildTextRows(importText: string, textMode: string) {
        const UserModel = global.Hydro.model.user;
        const DomainModel = global.Hydro.model.domain;
        const month = monthKey();
        const rows: any[] = [];
        const messages: string[] = [];
        const domainCache = new Map<string, any>();
        const validModes = new Set(['credit', 'quota', 'both']);
        if (!validModes.has(textMode)) textMode = 'both';

        for (const [i, raw] of (importText || '').split('\n').entries()) {
            if (!raw.trim()) continue;
            const lineNum = i + 1;
            const cols = splitImportLine(raw);
            const row: any = {
                lineNum,
                raw,
                username: cols[0] || '',
                domainInput: cols[1] || '',
                errors: [],
                ok: false,
            };
            const expectedCols = textMode === 'both' ? 4 : 3;
            if (cols.length !== expectedCols) {
                row.errors.push(`列数应为 ${expectedCols} 列`);
            }
            if (!row.username) row.errors.push('用户名不能为空');
            if (!row.domainInput) row.errors.push('域不能为空');

            let creditDelta: number | null = null;
            let quotaDelta: number | null = null;
            if (textMode === 'credit') {
                creditDelta = parseIntegerCell(cols[2]);
                if (creditDelta === null) row.errors.push('域内积分必须是整数');
            } else if (textMode === 'quota') {
                quotaDelta = parseIntegerCell(cols[2]);
                if (quotaDelta === null) row.errors.push('域内本月可用上限必须是整数');
            } else {
                creditDelta = parseIntegerCell(cols[2]);
                quotaDelta = parseIntegerCell(cols[3]);
                if (creditDelta === null) row.errors.push('域内积分必须是整数');
                if (quotaDelta === null) row.errors.push('域内本月可用上限必须是整数');
            }

            if (!row.errors.length) {
                const userDoc = await UserModel.getByUname('system', row.username).catch(() => null);
                if (!userDoc) row.errors.push(`用户 "${row.username}" 不存在`);
                else {
                    row.uid = userDoc._id;
                    row.uname = userDoc.uname || row.username;
                }
            }
            if (!row.errors.length) {
                if (!domainCache.has(row.domainInput)) {
                    domainCache.set(row.domainInput, await resolveAiTutorDomain(this.ctx, row.domainInput));
                }
                const ddoc = domainCache.get(row.domainInput);
                if (!ddoc) row.errors.push(`域 "${row.domainInput}" 不存在`);
                else {
                    row.domainId = ddoc._id;
                    row.domainName = ddoc.name || ddoc._id;
                    if (!await this.assertDomainWritable(ddoc._id)) row.errors.push(`没有权限修改域 "${ddoc._id}"`);
                }
            }
            if (!row.errors.length) {
                const member = await DomainModel.getMultiUserInDomain(row.domainId, { uid: row.uid }).next();
                if (!member) row.errors.push(`用户不在域 "${row.domainId}" 中`);
            }
            if (!row.errors.length) {
                const [creditDoc, accessDoc] = await Promise.all([
                    this.ctx.db.collection(COLL_CREDIT as any).findOne(creditQuery(row.domainId, row.uid)),
                    this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({ domainId: row.domainId, uid: row.uid }),
                ]);
                row.creditDelta = creditDelta;
                row.quotaDelta = quotaDelta;
                if (creditDelta !== null) {
                    row.creditBefore = Math.max(0, (creditDoc as any)?.balance || 0);
                    row.creditEffective = creditDelta < 0 ? -Math.min(row.creditBefore, -creditDelta) : creditDelta;
                    row.creditAfter = row.creditBefore + row.creditEffective;
                }
                if (quotaDelta !== null) {
                    row.quotaBefore = (accessDoc as any)?.bonusMonth === month ? Math.max(0, (accessDoc as any)?.quotaBonus || 0) : 0;
                    row.quotaAfter = Math.max(0, row.quotaBefore + quotaDelta);
                    row.quotaEffective = row.quotaAfter - row.quotaBefore;
                }
                row.ok = true;
            }
            if (row.errors.length) messages.push(`Line ${lineNum}: ${row.errors.join('；')}`);
            rows.push(row);
        }
        messages.push(`可导入 ${rows.filter((row) => row.ok).length} 行，错误 ${rows.filter((row) => !row.ok).length} 行。`);
        return { rows, messages, canImport: rows.length > 0 && rows.every((row) => row.ok) };
    }

    async buildGroupRows(groupName: string, groupAction: string, groupAmount: number) {
        const UserModel = global.Hydro.model.user;
        const groups = await UserModel.listGroup(this.domain._id);
        const group = groups.find((item: any) => item.name === groupName);
        const messages: string[] = [];
        if (!group) return { rows: [], messages: [`小组 "${groupName}" 不存在。`], canImport: false };
        if (!['credit', 'quota'].includes(groupAction)) groupAction = 'credit';
        if (!Number.isInteger(groupAmount) || groupAmount === 0) {
            return { rows: [], messages: ['调整值必须是非 0 整数。'], canImport: false };
        }
        const uids = Array.isArray(group.uids) ? group.uids.filter((uid: any) => typeof uid === 'number') : [];
        const users = uids.length ? await UserModel.getList(this.domain._id, uids) : {};
        const rows: any[] = [];
        const month = monthKey();
        for (const uid of uids) {
            const [creditDoc, accessDoc] = await Promise.all([
                this.ctx.db.collection(COLL_CREDIT as any).findOne(creditQuery(this.domain._id, uid)),
                this.ctx.db.collection(COLL_DOMAIN_ACCESS as any).findOne({ domainId: this.domain._id, uid }),
            ]);
            const row: any = {
                ok: true,
                uid,
                username: users[uid]?.uname || `uid=${uid}`,
                domainId: this.domain._id,
                groupName,
                groupAction,
            };
            if (groupAction === 'credit') {
                row.creditDelta = groupAmount;
                row.creditBefore = Math.max(0, (creditDoc as any)?.balance || 0);
                row.creditEffective = groupAmount < 0 ? -Math.min(row.creditBefore, -groupAmount) : groupAmount;
                row.creditAfter = row.creditBefore + row.creditEffective;
            } else {
                row.quotaDelta = groupAmount;
                row.quotaBefore = (accessDoc as any)?.bonusMonth === month ? Math.max(0, (accessDoc as any)?.quotaBonus || 0) : 0;
                row.quotaAfter = Math.max(0, row.quotaBefore + groupAmount);
                row.quotaEffective = row.quotaAfter - row.quotaBefore;
            }
            rows.push(row);
        }
        messages.push(`小组 "${groupName}" 共 ${rows.length} 个用户。`);
        return { rows, messages, canImport: rows.length > 0 };
    }

    async applyRows(rows: any[], remark: string, source: string) {
        const now = new Date();
        const month = monthKey(now);
        const adjustColl = this.ctx.db.collection(COLL_CREDIT_ADJUST as any);
        let changedCredit = 0;
        let changedQuota = 0;
        for (const row of rows) {
            if (!row.ok) continue;
            if (typeof row.creditDelta === 'number') {
                const result = await adjustCreditClamped(this.ctx, {
                    domainId: row.domainId,
                    uid: row.uid,
                    amount: row.creditDelta,
                    reason: `批量手动修改积分：${remark || source}`,
                    operatorUid: this.user._id,
                });
                if (result.effectiveAmount) {
                    changedCredit++;
                    await adjustColl.insertOne({
                        _id: new ObjectId(),
                        domainId: row.domainId,
                        uid: row.uid,
                        amount: result.effectiveAmount,
                        kind: 'batchManualCredit',
                        beforeBalance: result.beforeBalance,
                        afterBalance: result.afterBalance,
                        remark,
                        source,
                        operatorUid: this.user._id,
                        ledgerId: result.ledgerId,
                        at: now,
                    } as any);
                }
            }
            if (typeof row.quotaDelta === 'number') {
                const result = await adjustQuotaBonusClamped(this.ctx, {
                    domainId: row.domainId,
                    uid: row.uid,
                    amount: row.quotaDelta,
                    reason: remark || source,
                    operatorUid: this.user._id,
                });
                if (result.effectiveAmount) {
                    changedQuota++;
                    await adjustColl.insertOne({
                        _id: new ObjectId(),
                        domainId: row.domainId,
                        uid: row.uid,
                        amount: result.effectiveAmount,
                        monthKey: month,
                        kind: 'batchMonthlyQuotaBonus',
                        beforeBonus: result.beforeBonus,
                        afterBonus: result.afterBonus,
                        remark,
                        source,
                        operatorUid: this.user._id,
                        at: now,
                    } as any);
                }
            }
        }
        await OplogModel.log(this, 'ai_tutor.batchAdjust', {
            source,
            rows: rows.length,
            changedCredit,
            changedQuota,
            remark,
        });
        return { changedCredit, changedQuota };
    }

    @param('textMode', Types.Range(['credit', 'quota', 'both']))
    @param('importText', Types.Content)
    @param('remark', Types.String, true)
    async postTextPreview(domainId: string, textMode: string, importText: string, remark = '') {
        const result = await this.buildTextRows(importText, textMode);
        await this.renderPage({
            textMode,
            importText,
            remark,
            messages: result.messages,
            previewRows: result.rows,
            previewType: 'text',
            canImport: result.canImport,
        });
    }

    @param('textMode', Types.Range(['credit', 'quota', 'both']))
    @param('importText', Types.Content)
    @param('remark', Types.String, true)
    async postTextImport(domainId: string, textMode: string, importText: string, remark = '') {
        const result = await this.buildTextRows(importText, textMode);
        if (!result.canImport) {
            await this.renderPage({
                textMode,
                importText,
                remark,
                messages: ['存在错误，未导入。', ...result.messages],
                previewRows: result.rows,
                previewType: 'text',
                canImport: false,
            });
            return;
        }
        const stats = await this.applyRows(result.rows, (remark || '').trim(), 'text');
        await this.renderPage({
            textMode,
            importText,
            remark,
            messages: [`导入完成：积分变动 ${stats.changedCredit} 人，可用上限变动 ${stats.changedQuota} 人。`, ...result.messages],
            previewRows: result.rows,
            previewType: 'text',
            canImport: false,
        });
    }

    @param('groupName', Types.String)
    @param('groupAction', Types.Range(['credit', 'quota']))
    @param('groupAmount', Types.Int)
    @param('remark', Types.String, true)
    async postGroupPreview(domainId: string, groupName: string, groupAction: string, groupAmount: number, remark = '') {
        const result = await this.buildGroupRows(groupName, groupAction, groupAmount);
        await this.renderPage({
            groupName,
            groupAction,
            groupAmount,
            remark,
            messages: result.messages,
            previewRows: result.rows,
            previewType: 'group',
            canImport: result.canImport,
        });
    }

    @param('groupName', Types.String)
    @param('groupAction', Types.Range(['credit', 'quota']))
    @param('groupAmount', Types.Int)
    @param('remark', Types.String, true)
    async postGroupImport(domainId: string, groupName: string, groupAction: string, groupAmount: number, remark = '') {
        const result = await this.buildGroupRows(groupName, groupAction, groupAmount);
        if (!result.canImport) {
            await this.renderPage({
                groupName,
                groupAction,
                groupAmount,
                remark,
                messages: ['存在错误，未导入。', ...result.messages],
                previewRows: result.rows,
                previewType: 'group',
                canImport: false,
            });
            return;
        }
        const stats = await this.applyRows(result.rows, (remark || '').trim(), `group:${groupName}`);
        await this.renderPage({
            groupName,
            groupAction,
            groupAmount,
            remark,
            messages: [`导入完成：积分变动 ${stats.changedCredit} 人，可用上限变动 ${stats.changedQuota} 人。`, ...result.messages],
            previewRows: result.rows,
            previewType: 'group',
            canImport: false,
        });
    }
}
