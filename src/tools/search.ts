import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import type { Tool } from '../llm/types';

const run = promisify(execFile);

const schema = z.object({
  query: z.string(),
  filePattern: z.string().optional(),
  maxResults: z.number().optional(),
});

export const searchTool: Tool<z.infer<typeof schema>> = {
  name: 'search_code',
  description:
    '在项目里搜索文本,返回命中的文件路径、行号和该行内容。会自动跳过 .gitignore 里忽略的文件。',

  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的文本' },
      filePattern: { type: 'string', description: '可选。限定文件类型,例如 "*.ts"' },
      maxResults: { type: 'number', description: '可选。最多返回多少条结果,默认 30' },
    },
    required: ['query'],
  },

  schema,

  async execute({ query, filePattern, maxResults = 30 }) {
    const args = ['--line-number', '--no-heading', '--color', 'never'];
    if (filePattern) args.push('--glob', filePattern);
    // -- 之后的内容一律当成位置参数,避免查询以 - 开头时被误认成选项
    args.push('--', query, '.');

    try {
      const { stdout } = await run(rgPath, args, { maxBuffer: 8 * 1024 * 1024 });
      const lines = stdout.split('\n').filter(Boolean);
      if (lines.length === 0) return '没有找到匹配的内容。';

      const shown = lines.slice(0, maxResults);
      const suffix =
        lines.length > maxResults ? `\n...(共 ${lines.length} 条,只显示了前 ${maxResults} 条)` : '';
      return shown.join('\n') + suffix;
    } catch (err) {
      // ripgrep 没找到匹配时退出码是 1,这不是错误
      if ((err as { code?: number }).code === 1) return '没有找到匹配的内容。';
      return `搜索失败: ${(err as Error).message}`;
    }
  },
};
