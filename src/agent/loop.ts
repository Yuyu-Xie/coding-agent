import { chat } from '../llm/client';
import { findTool, toolSchemas } from '../tools';
import type { AssistantMessage, ChatMessage } from '../llm/types';

const SYSTEM_PROMPT = `你是一个代码助手,工作在当前项目目录下。

你可以使用工具查看和修改代码。规则:
- 不知道文件内容时先读取,不要凭空猜测。
- 修改文件前必须先读取它,拿到准确的原文。
- 任务完成后,用中文简要说明你做了什么。`;

const MAX_TURNS = 20;

/**
 * agent 主循环。
 *
 * 每一轮做三件事:
 *   1. 把全部历史消息 + 工具定义发给模型
 *   2. 如果模型返回了 tool_calls,逐个执行,把结果作为 tool 消息追加到历史
 *   3. 如果模型没返回 tool_calls,说明它认为任务完成了,结束
 *
 * 注意历史消息是累积的,每轮都会把之前所有内容重发一遍。
 * 这是 API 无状态决定的,也是上下文会越来越大的原因。
 */
export async function runAgent(task: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const reply = await chat(messages, toolSchemas());

    // 没有工具调用 = 模型认为任务结束了
    if (!reply.tool_calls?.length) {
      return reply.content ?? '(模型没有给出回答)';
    }

    // 有工具调用。先把模型这条消息本身放进历史,再逐个执行工具
    messages.push(reply);

    for (const call of reply.tool_calls) {
      const result = await runTool(call);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return `已经执行了 ${MAX_TURNS} 轮仍未结束,主动停止。`;
}

type ToolCall = NonNullable<AssistantMessage['tool_calls']>[number];

async function runTool(call: ToolCall): Promise<string> {
  if (call.type !== 'function') return '不支持的工具调用类型';

  const tool = findTool(call.function.name);
  if (!tool) return `没有名为 ${call.function.name} 的工具`;

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return `参数不是合法的 JSON: ${call.function.arguments.slice(0, 200)}`;
  }

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
    return `参数不符合要求: ${issues}`;
  }

  return tool.execute(parsed.data);
}
