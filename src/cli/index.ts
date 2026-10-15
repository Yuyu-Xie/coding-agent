import { createInterface } from 'node:readline/promises';
import { runAgent } from '../agent/loop';

async function main() {
  const task = process.argv.slice(2).join(' ').trim();

  // 带了参数:执行一次就退出
  if (task) {
    console.log(await runAgent(task));
    return;
  }

  // 没带参数:进入交互模式
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('输入任务回车执行,输入 exit 退出。\n');

  while (true) {
    const input = (await rl.question('> ')).trim();
    if (input === 'exit') break;
    if (!input) continue;
    console.log('\n' + (await runAgent(input)) + '\n');
  }

  rl.close();
}

main();
