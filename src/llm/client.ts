import 'dotenv/config';
import OpenAI from 'openai';
import type { AssistantMessage, ChatMessage, ToolSchema } from './types';

export const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
});

/** 把当前全部消息和工具定义发出去,拿回模型这一轮的回复。 */
export async function chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<AssistantMessage> {
  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools,
    temperature: 0,
  });
  return res.choices[0]!.message;
}
