const chalk = require('chalk');

function banner(data) {
  let name = 'KLAUS MD';
  let phone = 'Unknown';

  // Handle both object { botName: '...' } and string formats
  if (typeof data === 'object' && data !== null) {
    name = data.botName || name;
  } else if (typeof data === 'string') {
    phone = data;
  }

  const time = new Date().toLocaleString();
  console.log(chalk.cyan(`
╔══════════════════════════════════════════╗
║                                          ║
║   🤖  ${String(name).padEnd(34)}║
║                                          ║
║   📱  Number : ${String(phone).padEnd(24)}║
║   🟢  Status : ONLINE                    ║
║   ⏱️   Time   : ${String(time).padEnd(24)}║
║                                          ║
╚══════════════════════════════════════════╝
  `));
}

module.exports = {
  banner,
  step: (current, total, msg) => {
    if (total === undefined) {
      console.log(chalk.magenta('  ⚙️  ' + current));
    } else {
      console.log(chalk.magenta(`  ⚙️  [${current}/${total}] ${msg}`));
    }
  },
  divider: () => console.log(chalk.gray('  ──────────────────────────────────────────')),
  boot: (botName, subtitle) => console.log(chalk.cyan(`\n  🚀 Booting ${botName} | ${subtitle}\n`)),
  kvBlock: (title, data) => {
    console.log(chalk.cyan(`  ── ${title} ──`));
    for (const [key, value] of Object.entries(data)) {
      console.log(chalk.white(`    ${key}: `) + chalk.gray(value));
    }
  },
  connection: (msg) => console.log(chalk.cyan('  🌐 [CONNECTION] ' + msg)),
  stat: (msg) => console.log(chalk.gray('  📊 [STAT] ' + msg)),
  command: (name, sender) => console.log(chalk.yellow(`  🎯 Command: ${name} | From: ${sender}`)),
  commandStart: (name, sender, args) => console.log(chalk.gray(`     ↳ args: ${args && args.length ? args.join(' ') : 'none'}`)),
  commandEnd: (name, ms) => console.log(chalk.green(`  ✔ Finished ${name} in ${ms}ms`)),
  incoming: (chatId, sender, isGroup, length) => console.log(chalk.blue(`  📥 [${isGroup ? 'Group' : 'DM'}] Msg from ${sender.split('@')[0]} (${length} chars)`)),
  info: (msg) => console.log(chalk.blue('  ℹ️  ' + msg)),
  success: (msg) => console.log(chalk.green('  ✅ ' + msg)),
  warn: (msg) => console.log(chalk.yellow('  ⚠️  ' + msg)),
  error: (msg) => console.log(chalk.red('  ❌ ' + msg)),
  errorTrace: (error, context = '') => {
    const contextStr = context ? `[${context}] ` : '';
    console.error(chalk.red(`  ❌ ${contextStr}${error.message}`));
    if (error.stack) {
      console.error(chalk.gray(error.stack.split('\n').slice(1).join('\n')));
    }
  }
};
