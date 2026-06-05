import { ObjectId } from 'hydrooj';

export interface AiAnalysisHistoryEntry {
    content: string;
    model: string;
    promptText: string;
    durationMs: number;
    createdAt: Date;
    monthKey: string;
    questionFocus?: string;
    questionFocusLabel?: string;
    studentNote?: string;
    interrupted?: boolean;
    finishReason?: string;
    dialogue?: any[];
}

export interface AiAnalysisDoc {
    _id: ObjectId;           // record id (rid)
    uid: number;             // user who triggered
    pid: number;             // problem doc id
    domainId: string;
    content: string;         // AI response (markdown plain text)
    model: string;
    promptText: string;      // full prompt sent to AI (for transparency)
    durationMs: number;
    createdAt: Date;
    monthKey: string;        // YYYY-MM, for cheap quota counting
    questionFocus?: string;  // student's selected difficulty category
    questionFocusLabel?: string;
    studentNote?: string;    // student's own description before asking AI
    interrupted?: boolean;
    finishReason?: string;
    history?: AiAnalysisHistoryEntry[];  // previous analyses, oldest first
}

export interface AiDomainAccessDoc {
    domainId: string;
    uid: number;
    enabled: boolean;
    quotaMonth?: string;      // month when quotaLimit overrides the system monthly cap
    quotaLimit?: number;      // per-domain monthly cap for this user
    bonusMonth?: string;      // month when manually granted calls are usable
    quotaBonus?: number;      // extra calls beyond the system monthly cap
    updatedAt: Date;
    updatedBy: number;
}

export interface AiDomainConfigDoc {
    _id: string;
    domainId: string;
    provider: string;
    customBaseUrl?: string;
    customModel?: string;
    apiKey?: string;
    updatedAt: Date;
    updatedBy: number;
}

export interface ProviderPreset {
    label: string;           // shown in the dropdown
    baseUrl: string;
    model: string;
}

export interface DifficultyScanArgs {
    domainId?: string | string[];
    limit?: number;
    overwrite?: boolean;
    includeHidden?: boolean;
    dryRun?: boolean;
}

export interface DifficultyScore {
    difficulty: number;
    reason: string;
}
