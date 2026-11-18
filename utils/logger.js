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

function errorTrace(error, context = '') {
  const contextStr = context ? `[${context}] ` : '';
  console.error(chalk.red(`  ❌ ${contextStr}${error.message}`));
  
  if (error.stack) {
    // Print the stack trace in gray so it's less aggressive but still readable
    const stackLines = error.stack.split('\n').slice(1).join('\n');
    console.error(chalk.gray(stackLines));
  }
}

module.exports = {
  banner,
  session: (msg) => console.log(chalk.cyan('  🔑 [SESSION] ' + msg)),
  connected: (msg) => console.log(chalk.green('  ✅ ' + msg)),
  success: (msg) => console.log(chalk.green('  ✅ ' + msg)), // Added in case your code calls .success()
  warn: (msg) => console.log(chalk.yellow('  ⚠️  ' + msg)),
  error: (msg) => console.log(chalk.red('  ❌ ' + msg)),
  info: (msg) => console.log(chalk.blue('  ℹ️  ' + msg)),
  errorTrace // <--- This was missing and caused your crash
};
