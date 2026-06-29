import { ProviderPreset } from './types';

export const PROVIDERS: Record<string, ProviderPreset> = {
    // ── DeepSeek (default, China-friendly, OI 教练首选) ──
    'deepseek-v4-flash': { label: 'DeepSeek V4 Flash (快·便宜，默认)', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    'deepseek-v4-pro':   { label: 'DeepSeek V4 Pro (更强推理)',        baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
    'deepseek-reasoner': { label: 'DeepSeek Reasoner (V4 思考模式)',   baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' },

    // ── OpenAI ──
    'openai-gpt-4o-mini': { label: 'OpenAI GPT-4o mini',                baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    'openai-gpt-4o':      { label: 'OpenAI GPT-4o',                     baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },

    // ── 国产 OpenAI 兼容 ──
    'qwen-turbo':   { label: '阿里 通义千问 Turbo',  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
    'qwen-plus':    { label: '阿里 通义千问 Plus',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    'kimi-latest':  { label: 'Moonshot Kimi 最新版', baseUrl: 'https://api.moonshot.cn/v1',                        model: 'kimi-latest' },
    'glm-4-flash':  { label: '智谱 GLM-4 Flash',     baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-4-flash' },
    'doubao-pro':   { label: '字节豆包 Pro',          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',          model: 'doubao-pro-32k' },

    // ── 自定义出口（baseUrl + 模型名走配置项） ──
    custom: { label: '自定义 (用下方 customBaseUrl / customModel)', baseUrl: '', model: '' },
};

export const PROVIDER_RANGE: Record<string, string> = Object.fromEntries(
    Object.entries(PROVIDERS).map(([key, p]) => [key, p.label]),
);

export const QUESTION_FOCUS: Record<string, string> = {
    idea: '我还没有想清楚解题思路',
    implementation: '我有思路，但代码实现不对',
    debug: '我看不懂评测结果，找不到错误',
    keyCode: '题目中的关键操作，我不知道代码怎么写',
    boundary: '我不确定边界情况或特殊数据怎么处理',
};

export const DEFAULT_SYSTEM_PROMPT = `你是一位 OI/NOIP（信息学奥林匹克）少儿编程教练，正在辅导一位 10–12 岁的小学生学习算法竞赛入门题（C++ / Python）。

【你的身份与说话风格】
- 像一位有耐心、爱讲故事的好朋友老师。
- 语气鼓励、温柔、轻松，多用"我们"、"一起来想想"、"试试看"。
- 必须用小学生听得懂的中文，避免专业术语。如果一定要用，先用一句生活比喻解释它。
- 多用比喻、举例子、"在脑子里跑一遍"的思考方式。例如：
  · 变量 → "贴了标签的小盒子"
  · 循环 → "重复做同一件事"
  · 字符 → "键盘上的一个按键"
  · 数组 → "一排连号的小柜子"

【你必须遵守的铁律（任何情况下都不能违反）】
1. ❌ 绝不直接给出完整的正确代码（哪怕一两行也不行）。
2. ❌ 绝不直接说出算法名（如"动态规划""贪心""二分"等术语对小学生没意义）或完整题解。
3. ❌ 绝不写"你应该把代码改成：……"然后跟代码。
4. ❌ 绝不用大段专业表述（时间复杂度、数据结构理论等）。
5. ❌ 不要替学生"做完"题目，只能引导他自己想明白。

【你应该做的】
1. ✅ 先比对题目要求和孩子代码的差距，找出**一两个最关键**的错误点（不要罗列所有问题）。
2. ✅ 用反引号 \`xxx\` 引用孩子代码里出问题的关键字或那一行，告诉他"这里好像有个小问题哦"。
3. ✅ 用提问引导他自己发现错误：
   · "你想一想，题目说要输入一个 \`字符\`，那你的代码读到的是数字还是字符呢？"
   · "如果输入是 \`*\`，电脑会把它当成什么？"
4. ✅ 用形象的比喻解释为什么会错。
5. ✅ 给"修改方向"，不给"修改后的代码"：
   · ✔ "你可以试试换一个能装字符的盒子，它的名字叫做 \`char\`。"
   · ✘ "你应该写 \`char a; cin>>a; cout<<a;\`"
6. ✅ 结尾给一句鼓励，例如："你已经把整体思路想对了，离成功只差一小步啦，加油！"

【输出格式】
- 总字数 200–350 字之间。
- 自然的段落，不要用 # 标题，不要用 \`\`\` 代码块，不要用列表项编号。
- 段落之间空一行。
- 可以用单反引号 \`x\` 引用孩子代码里的关键词或单个标识符（不算"给代码"）。

接下来用户会发给你：题目内容、孩子的代码、评测结果。请按上面的规则给出引导式反馈。`;

export const COLL_ANALYSIS = 'ai.analysis';   // one doc per record (the saved AI response, upserted)
export const COLL_USAGE = 'ai.usage';         // append-only call log; monthly cap counted here
export const COLL_CREDIT = 'ai.credit';       // one doc per (domainId, uid) balance
export const COLL_CREDIT_LEDGER = 'ai.credit_ledger'; // append-only credit change log
export const COLL_AWARD = 'ai.credit_award';  // one doc per (domainId, uid, pid) first-AC award
export const COLL_CHECKIN = 'ai.checkin';      // one doc per (domainId, uid, dayKey) daily check-in
export const COLL_DOMAIN_ACCESS = 'ai.domain_access'; // per-domain student access switch and monthly quota bonus
export const COLL_DOMAIN_CONFIG = 'ai.domain_config'; // per-domain AI provider/model/API key
export const COLL_CREDIT_ADJUST = 'ai.credit_adjust'; // legacy-named audit log for teacher-granted quota
export const COLL_PROCTOR_SESSION = 'proctor.session'; // aggregated proctoring sessions
export const COLL_PROCTOR_EVENT = 'proctor.event';     // raw proctoring event stream
export const WEEKLY_CREDIT_RESET_TASK = 'ai-tutor.weeklyCreditReset';
export const WEEKLY_CREDIT_GRANT = 5;
export const DAILY_CHECKIN_CREDIT = 150;
export const CREDIT_EXPIRE_DAYS = 30;
