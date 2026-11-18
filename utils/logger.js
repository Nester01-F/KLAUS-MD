
const chalk = require('chalk');

function banner(phoneNumber, botName) {
  const time = new Date().toLocaleString();
  console.log(chalk.cyan(`
╔══════════════════════════════════════════╗
║                                          ║
║   🤖  ${botName.padEnd(34)}║
║                                          ║
║   📱  Number : ${String(phoneNumber).padEnd(24)}║
║   🟢  Status : ONLINE                    ║
║   ⏱️   Time   : ${time.padEnd(24)}║
║                                          ║
╚══════════════════════════════════════════╝
  `));
}

module.exports = {
  banner,
  session: (msg) => console.log(chalk.cyan('  🔑 [SESSION] ' + msg)),
  connected: (msg) => console.log(chalk.green('  ✅ ' + msg)),
  warn: (msg) => console.log(chalk.yellow('  ⚠️  ' + msg)),
  error: (msg) => console.log(chalk.red('  ❌ ' + msg)),
  info: (msg) => console.log(chalk.blue('  ℹ️  ' + msg))
};
