import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '../llm/types';

const schema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
});

/**
 * 编辑策略:字符串精确替换。
 *
 * 模型给出 oldString(原文)和 newString(新内容),我们在文件里找到 oldString 替换掉。
 * 要求 oldString 在文件中唯一出现 —— 不唯一就拒绝执行,让模型补上下文重试。
 *
 * 为什么不用行号:行号在多次编辑后会失效,而且模型数行号经常数错。
 * 为什么不用整文件重写:大文件浪费 token,而且模型容易漏抄内容。
 */
export const editTool: Tool<z.infer<typeof schema>> = {
  name: 'edit_file',
  description:
    '把文件里的一段内容替换成新的内容。oldString 必须与文件中的原文完全一致,且在文件中唯一出现,否则会失败。修改前必须先 read_file 看清原文。',

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      oldString: {
        type: 'string',
        description: '要被替换的原文。必须与文件中完全一致(包括缩进和空格),且只出现一次',
      },
      newString: { type: 'string', description: '替换成的新内容' },
    },
    required: ['path', 'oldString', 'newString'],
  },

  schema,

  async execute({ path, oldString, newString }) {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      return `修改失败:找不到文件 ${path}`;
    }

    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      return `修改失败:在 ${path} 里找不到这段内容。请先 read_file 确认原文,注意缩进和空格必须完全一致。`;
    }
    if (occurrences > 1) {
      return `修改失败:这段内容在 ${path} 里出现了 ${occurrences} 次,无法确定改哪一处。请多带上几行上下文让它唯一。`;
    }

    await writeFile(path, content.replace(oldString, newString), 'utf8');
    return `已修改 ${path}`;
  },
};
