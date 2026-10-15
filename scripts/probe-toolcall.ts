/**
 * DeepSeek tool calling 稳定性探针
 * ===================================
 *
 * 为什么要有这个脚本:
 *   整个 agent 循环建立在一个假设之上 —— 模型能可靠地输出结构化的 tool call。
 *   如果模型经常返不回工具调用、或者返回的 JSON 坏了、或者参数填错,
 *   那么后面所有的循环逻辑、错误处理设计都要跟着改。
 *   所以在写主循环之前,先用数据把这个假设验证掉。
 *
 * 用法:
 *   npx tsx scripts/probe-toolcall.ts                      # 默认模型,每个用例 5 轮
 *   npx tsx scripts/probe-toolcall.ts deepseek-chat 10     # 指定模型和轮数
 *   npx tsx scripts/probe-toolcall.ts deepseek-reasoner 5
 *
 * 输出:
 *   每个用例的成功率,以及失败的具体分类。
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { z } from 'zod';

// ---------------------------------------------------------------- 配置

const MODEL = process.argv[2] ?? process.env.DEFAULT_MODEL ?? 'deepseek-chat';
const ROUNDS = Number(process.argv[3] ?? 5);

if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.includes('你的key')) {
  console.error('\n[错误] 没有找到 DEEPSEEK_API_KEY。');
  console.error('请把 .env.example 复制为 .env,并填入真实的 key。\n');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
  maxRetries: 1,
  timeout: 60_000,
});

// ---------------------------------------------------------------- 工具定义

type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// 这三个工具模拟真实 coding agent 会干的事。
const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取指定文件的完整内容。用于查看代码。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对于项目根目录的文件路径,例如 src/index.ts',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: '在代码库中搜索匹配的文本。用于定位某段代码在哪里。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的文本或正则表达式',
          },
          filePattern: {
            type: 'string',
            description: '可选。限定文件类型,例如 "*.ts"',
          },
          maxResults: {
            type: 'number',
            description: '可选。最多返回多少条结果,默认 20',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在项目根目录执行一条 shell 命令。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令',
          },
          timeoutMs: {
            type: 'number',
            description: '可选。超时毫秒数,默认 30000',
          },
        },
        required: ['command'],
      },
    },
  },
];

// ---------------------------------------------------------------- 参数校验

// 用 zod 校验模型返回的参数。这是真正跑 agent 时的做法:
// 模型返回的 JSON 不能直接信,必须过一遍 schema。
const SCHEMAS = {
  read_file: z.object({ path: z.string() }),
  search_code: z.object({
    query: z.string(),
    filePattern: z.string().optional(),
    maxResults: z.number().optional(),
  }),
  run_command: z.object({
    command: z.string(),
    timeoutMs: z.number().optional(),
  }),
};

// ---------------------------------------------------------------- 测试用例

type Expectation = {
  tool: string;
  /** 必须精确匹配的参数 */
  required?: Record<string, unknown>;
  /** 只要模型填了就算对的可选参数 */
  optionalPresent?: string[];
};

type Case = {
  id: string;
  label: string;
  prompt: string;
  expect: Expectation;
};

const CASES: Case[] = [
  {
    id: 'A',
    label: '单工具 · 字符串参数',
    prompt: '帮我看看 src/index.ts 这个文件里写了什么。',
    expect: {
      tool: 'read_file',
      required: { path: 'src/index.ts' },
    },
  },
  {
    id: 'B',
    label: '三选一 · 工具选择',
    prompt: '我想知道项目里所有出现 TODO 的地方,分别在哪几个文件。',
    expect: {
      tool: 'search_code',
      required: { query: /todo/i } as unknown as Record<string, unknown>,
    },
  },
  {
    id: 'C',
    label: '复杂 schema · 可选参数与数字',
    prompt: '搜索代码里的 "deprecated" 这个词,只看 src 目录下的 .ts 文件,最多返回 5 条结果。',
    expect: {
      tool: 'search_code',
      required: { query: /deprecated/i } as unknown as Record<string, unknown>,
      optionalPresent: ['filePattern', 'maxResults'],
    },
  },
  {
    id: 'D',
    label: '多轮 · 结果回灌后继续调用',
    prompt: '先读取 package.json,然后根据它里面的 scripts 字段,告诉我应该用哪条命令来跑测试。',
    expect: {
      tool: 'read_file',
      required: { path: 'package.json' },
    },
  },
];

// ---------------------------------------------------------------- 判定

const BASE_SYSTEM = `你是一个代码助手,可以使用工具帮用户查看和操作代码库。
需要工具时直接调用,不要凭空猜测文件内容。`;

type Verdict = 'ok' | 'no_tool_call' | 'wrong_tool' | 'bad_json' | 'schema_fail' | 'wrong_args' | 'api_error';

type RunRecord = {
  verdict: Verdict;
  detail?: string;
  latencyMs: number;
  tokens: number;
};

/** 字符串归一化:去掉前后空白、引号、开头的 ./ */
function norm(v: unknown): string {
  return String(v).trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return expected.test(String(actual));
  if (typeof expected === 'number') return Number(actual) === expected;
  return norm(actual) === norm(expected);
}

/**
 * D 用例特殊:它要多跑一轮。第一次 read_file 返回结果后,
 * 把结果回灌给模型,看它会不会接着调用 run_command 或者直接回答。
 */
async function runMultiTurn(c: Case): Promise<RunRecord> {
  const start = Date.now();
  let tokens = 0;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: BASE_SYSTEM },
    { role: 'user', content: c.prompt },
  ];

  try {
    // ---- 第 1 轮 ----
    const r1 = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      temperature: 0,
    });
    tokens += r1.usage?.total_tokens ?? 0;

    const tc1 = r1.choices[0]?.message?.tool_calls?.[0];
    if (!tc1) {
      return { verdict: 'no_tool_call', detail: '第 1 轮没有返回工具调用', latencyMs: Date.now() - start, tokens };
    }

    // ---- 把工具结果回灌,看第 2 轮 ----
    messages.push(r1.choices[0]!.message);
    messages.push({
      role: 'tool',
      tool_call_id: tc1.id,
      content: '{"name":"coding-agent","version":"0.1.0","scripts":{"dev":"tsx src/cli/index.ts","probe":"tsx scripts/probe-toolcall.ts","typecheck":"tsc --noEmit"}}',
    });

    const r2 = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      temperature: 0,
    });
    tokens += r2.usage?.total_tokens ?? 0;

    const msg2 = r2.choices[0]?.message;
    // 第 2 轮两种表现都算合格:继续调工具,或者直接给答案。
    // 不合格的表现是:空回复,或者胡编内容。
    if (!msg2) {
      return { verdict: 'no_tool_call', detail: '第 2 轮返回了空消息', latencyMs: Date.now() - start, tokens };
    }
    if (!msg2.tool_calls?.length && !msg2.content?.trim()) {
      return { verdict: 'no_tool_call', detail: '第 2 轮既没调工具也没给回答', latencyMs: Date.now() - start, tokens };
    }

    return { verdict: 'ok', latencyMs: Date.now() - start, tokens };
  } catch (err) {
    return {
      verdict: 'api_error',
      detail: err instanceof Error ? err.message.slice(0, 120) : String(err),
      latencyMs: Date.now() - start,
      tokens,
    };
  }
}

/** A/B/C 用例:单轮,检查工具名和参数 */
async function runSingleTurn(c: Case): Promise<RunRecord> {
  const start = Date.now();

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: BASE_SYSTEM },
        { role: 'user', content: c.prompt },
      ],
      tools: TOOLS,
      temperature: 0,
    });

    const tokens = res.usage?.total_tokens ?? 0;
    const latencyMs = Date.now() - start;
    const tc = res.choices[0]?.message?.tool_calls?.[0];

    if (!tc) {
      const text = res.choices[0]?.message?.content?.slice(0, 60) ?? '(空)';
      return { verdict: 'no_tool_call', detail: `返回了文本: ${text}`, latencyMs, tokens };
    }

    // openai SDK v7 里 tool_call 是联合类型,自定义工具调用没有 .function 字段。
    // 我们只用标准函数调用,所以先收窄类型。
    if (tc.type !== 'function') {
      return { verdict: 'wrong_tool', detail: `返回了 ${tc.type} 类型的调用`, latencyMs, tokens };
    }

    if (tc.function.name !== c.expect.tool) {
      return { verdict: 'wrong_tool', detail: `选了 ${tc.function.name},期望 ${c.expect.tool}`, latencyMs, tokens };
    }

    let args: unknown;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return { verdict: 'bad_json', detail: tc.function.arguments.slice(0, 80), latencyMs, tokens };
    }

    const schema = SCHEMAS[c.expect.tool as keyof typeof SCHEMAS];
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return { verdict: 'schema_fail', detail: JSON.stringify(parsed.error.issues[0] ?? {}), latencyMs, tokens };
    }

    const obj = args as Record<string, unknown>;
    for (const [k, v] of Object.entries(c.expect.required ?? {})) {
      if (!matches(obj[k], v)) {
        return { verdict: 'wrong_args', detail: `${k}=${JSON.stringify(obj[k])}`, latencyMs, tokens };
      }
    }
    for (const k of c.expect.optionalPresent ?? []) {
      if (obj[k] === undefined) {
        return { verdict: 'wrong_args', detail: `缺少可选参数 ${k}`, latencyMs, tokens };
      }
    }

    return { verdict: 'ok', latencyMs, tokens };
  } catch (err) {
    return {
      verdict: 'api_error',
      detail: err instanceof Error ? err.message.slice(0, 120) : String(err),
      latencyMs: Date.now() - start,
      tokens: 0,
    };
  }
}

// ---------------------------------------------------------------- 主流程

const VERDICT_LABEL: Record<Verdict, string> = {
  ok: '成功',
  no_tool_call: '没调工具',
  wrong_tool: '工具选错',
  bad_json: 'JSON 坏了',
  schema_fail: '参数不符合 schema',
  wrong_args: '参数值错',
  api_error: '接口报错',
};

async function main() {
  console.log('');
  console.log('='.repeat(64));
  console.log(`  DeepSeek tool calling 稳定性探针`);
  console.log(`  模型: ${MODEL}`);
  console.log(`  每个用例跑 ${ROUNDS} 轮,共 ${CASES.length * ROUNDS} 次调用`);
  console.log('='.repeat(64));

  const all: RunRecord[] = [];

  for (const c of CASES) {
    console.log(`\n用例 ${c.id} · ${c.label}`);
    const records: RunRecord[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const rec = c.id === 'D' ? await runMultiTurn(c) : await runSingleTurn(c);
      records.push(rec);
      all.push(rec);

      const mark = rec.verdict === 'ok' ? '✓' : '✗';
      const extra = rec.verdict === 'ok' ? '' : `  ${VERDICT_LABEL[rec.verdict]}${rec.detail ? ` — ${rec.detail}` : ''}`;
      process.stdout.write(`  ${mark} 第 ${i + 1} 轮  ${(rec.latencyMs / 1000).toFixed(1)}s${extra}\n`);
    }

    const ok = records.filter((r) => r.verdict === 'ok').length;
    console.log(`  → ${ok}/${ROUNDS} 成功`);
  }

  // ---- 汇总 ----
  const total = all.length;
  const okCount = all.filter((r) => r.verdict === 'ok').length;
  const apiErrors = all.filter((r) => r.verdict === 'api_error').length;
  const behaviorErrors = total - okCount - apiErrors;

  const avgLatency = all.reduce((s, r) => s + r.latencyMs, 0) / total;
  const totalTokens = all.reduce((s, r) => s + r.tokens, 0);

  console.log('\n' + '='.repeat(64));
  console.log('  汇总');
  console.log('='.repeat(64));
  console.log(`  总调用次数      ${total}`);
  console.log(`  成功            ${okCount}  (${((okCount / total) * 100).toFixed(1)}%)`);
  console.log(`  模型行为问题    ${behaviorErrors}  (${((behaviorErrors / total) * 100).toFixed(1)}%)`);
  console.log(`  接口/网络报错   ${apiErrors}  (${((apiErrors / total) * 100).toFixed(1)}%)`);
  console.log(`  平均延迟        ${(avgLatency / 1000).toFixed(2)}s`);
  console.log(`  总 token        ${totalTokens}`);

  const byVerdict = new Map<Verdict, number>();
  for (const r of all) {
    if (r.verdict !== 'ok') byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);
  }
  if (byVerdict.size > 0) {
    console.log('\n  失败分类:');
    for (const [v, n] of byVerdict) console.log(`    ${VERDICT_LABEL[v].padEnd(18)} ${n}`);
  }

  // ---- 结论 ----
  const rate = behaviorErrors / total;
  console.log('\n' + '='.repeat(64));
  if (rate === 0 && apiErrors === 0) {
    console.log('  结论:全部通过。tool calling 可以放心用在主循环里。');
  } else if (rate <= 0.1) {
    console.log('  结论:基本可用。行为错误率 <=10%,主循环里加参数校验和重试即可。');
  } else {
    console.log('  结论:错误率偏高。需要先解决这个问题,或者考虑降级方案(文本协议解析)。');
  }
  console.log('='.repeat(64) + '\n');
}

main().catch((err) => {
  console.error('\n探针运行失败:', err);
  process.exit(1);
});
