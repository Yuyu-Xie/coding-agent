import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '../llm/types';

const MAX_LINES = 2000;

const schema = z.object({ path: z.string() });

export const readTool: Tool<z.infer<typeof schema>> = {
  name: 'read_file',
  description: `读取一个文件的完整内容。超过 ${MAX_LINES} 行会被截断。`,

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径,相对于当前工作目录' },
    },
    required: ['path'],
  },

  schema,

  async execute({ path }) {
    try {
      const content = await readFile(path, 'utf8');
      const lines = content.split('\n');
      if (lines.length <= MAX_LINES) return content;
      return (
        lines.slice(0, MAX_LINES).join('\n') +
        `\n\n...(文件共 ${lines.length} 行,这里只显示了前 ${MAX_LINES} 行)`
      );
    } catch {
      return `读取失败:找不到文件 ${path}`;
    }
  },
};
