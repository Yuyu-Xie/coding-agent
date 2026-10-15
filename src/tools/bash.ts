import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Tool } from '../llm/types';

const run = promisify(exec);

const schema = z.object({ command: z.string() });

export const bashTool: Tool<z.infer<typeof schema>> = {
  name: 'run_command',
  description: '在当前工作目录执行一条 shell 命令,返回它的输出。命令超过 30 秒会被中止。',

  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
    },
    required: ['command'],
  },

  schema,

  async execute({ command }) {
    try {
      const { stdout, stderr } = await run(command, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = [stdout, stderr].filter((s) => s.trim()).join('\n');
      return output.trim() || '(命令执行成功,没有输出)';
    } catch (err) {
      // 命令失败时 exec 会抛异常,但 stdout/stderr 里往往有有用的信息
      const e = err as { stdout?: string; stderr?: string; message: string };
      return `命令执行失败:\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`;
    }
  },
};
