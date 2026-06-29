export interface StyleFingerprint {
    uses_std_qualifier: boolean;
    has_doc_comments: boolean;
    consistent_indent: boolean;
    long_var_names: boolean;
    uses_advanced_stl: boolean;
    has_helper_functions: boolean;
    uses_const_ref_params: boolean;
    uses_range_for: boolean;
    uses_cstyle_cast: boolean;
    uses_string_methods: boolean;
}

export const FINGERPRINT_KEYS: (keyof StyleFingerprint)[] = [
    'uses_std_qualifier',
    'has_doc_comments',
    'consistent_indent',
    'long_var_names',
    'uses_advanced_stl',
    'has_helper_functions',
    'uses_const_ref_params',
    'uses_range_for',
    'uses_cstyle_cast',
    'uses_string_methods',
];

function stripCommentsAndStrings(code: string) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

export function effectiveCodeLines(code = '') {
    return code.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line)
        .filter((line) => !line.startsWith('//'))
        .filter((line) => !/^\/\*|\*|\*\/$/.test(line))
        .filter((line) => !/^[{}]+;?$/.test(line))
        .length;
}

function hasConsistentIndent(code: string) {
    const indents = code.split(/\r?\n/)
        .filter((line) => line.trim())
        .filter((line) => /^\s+/.test(line))
        .map((line) => line.match(/^\s+/)?.[0] || '');
    if (indents.length < 5) return false;
    const tabOnly = indents.every((indent) => /^\t+$/.test(indent));
    if (tabOnly) return true;
    for (const size of [2, 4]) {
        if (indents.every((indent) => /^ +$/.test(indent) && indent.length % size === 0)) return true;
    }
    return false;
}

function averageIdentifierLength(code: string) {
    const words = stripCommentsAndStrings(code).match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
    const ignored = new Set([
        'include', 'using', 'namespace', 'std', 'int', 'long', 'double', 'float', 'char', 'bool',
        'void', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
        'class', 'struct', 'public', 'private', 'protected', 'const', 'auto', 'signed', 'unsigned',
        'true', 'false', 'cin', 'cout', 'endl',
    ]);
    const ids = words.filter((word) => word.length >= 2 && !ignored.has(word));
    if (!ids.length) return 0;
    return ids.reduce((sum, word) => sum + word.length, 0) / ids.length;
}

export function extractStyleFingerprint(code = ''): StyleFingerprint {
    const clean = stripCommentsAndStrings(code);
    const functionDefs = clean.match(/\b(?:int|long\s+long|double|float|bool|char|string|void|vector\s*<[^>]+>)\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*\{/g) || [];
    return {
        uses_std_qualifier: (clean.match(/\bstd::\w+/g) || []).length >= 3,
        has_doc_comments: /\/\*\*|\/\/\/|\/\/\s*@(?:param|return)\b/.test(code),
        consistent_indent: hasConsistentIndent(code),
        long_var_names: averageIdentifierLength(code) >= 7,
        uses_advanced_stl: /unordered_map|priority_queue|set\s*<\s*pair|tuple\s*<|auto&&|<ranges>/.test(clean),
        has_helper_functions: functionDefs.some((fn) => !/\bmain\s*\(/.test(fn)),
        uses_const_ref_params: /\bconst\s+(?:string|vector\s*<[^>]+>|[A-Za-z_]\w*)\s*&\s*[A-Za-z_]\w*/.test(clean),
        uses_range_for: /\bfor\s*\(\s*(?:const\s+)?(?:auto|char|int|long\s+long|string)\s+[A-Za-z_]\w*\s*:\s*[^)]+\)/.test(clean),
        uses_cstyle_cast: /\([A-Za-z_][A-Za-z0-9_]*(?:\s*[*&])?\)\s*[^;,)]+/.test(clean),
        uses_string_methods: /\.(?:substr|size|length|push_back|find|erase|insert)\s*\(/.test(clean),
    };
}

export function baselineFingerprint(history: StyleFingerprint[]) {
    if (!history.length) return null;
    const baseline: Partial<StyleFingerprint> = {};
    for (const key of FINGERPRINT_KEYS) {
        const trues = history.filter((fp) => fp[key]).length;
        baseline[key] = trues >= Math.ceil(history.length / 2);
    }
    return baseline as StyleFingerprint;
}

export function fingerprintFlips(current: StyleFingerprint, baseline: StyleFingerprint) {
    return FINGERPRINT_KEYS
        .filter((key) => current[key] !== baseline[key])
        .map((key) => ({
            key,
            before: baseline[key],
            after: current[key],
        }));
}
