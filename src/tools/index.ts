import type { Tool, ToolSchema } from '../llm/types';
import { bashTool } from './bash';
import { editTool } from './edit';
import { readTool } from './read';
import { searchTool } from './search';

/** 所有可用的工具。加新工具只需要在这里加一行。 */
export const tools: Tool<any>[] = [readTool, searchTool, editTool, bashTool];

/** 转成发给模型的格式 */
export function toolSchemas(): ToolSchema[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function findTool(name: string): Tool<any> | undefined {
  return tools.find((t) => t.name === name);
}
