import type OpenAI from 'openai';
import type { z } from 'zod';

/** 发给模型的消息。直接用 openai SDK 的类型,不自己造轮子。 */
export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

/** 模型的回复。可能带文本,也可能带 tool_calls。 */
export type AssistantMessage = OpenAI.Chat.ChatCompletionMessage;

/** 发给模型的工具描述 */
export type ToolSchema = OpenAI.Chat.ChatCompletionTool;

/**
 * 一个工具的完整定义,三部分:
 *   1. parameters —— 发给模型看的 JSON Schema,告诉它参数该长什么样
 *   2. schema     —— 收回来时用的 zod 校验器,模型返回的参数必须先过这关
 *   3. execute    —— 真正干活的逻辑
 *
 * 前两者分开是有意的:模型看到的描述和程序强制的约束是两回事。
 * 模型不总是按 schema 填,所以必须有一道程序级的把关。
 */
export interface Tool<Args = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodType<Args>;
  execute(args: Args): Promise<string>;
}
