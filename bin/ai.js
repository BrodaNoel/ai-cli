#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { exec } from 'child_process';

const CONFIG_PATH = path.join(os.homedir(), '.ai-config.json');
const HISTORY_PATH = path.join(os.homedir(), '.ai-command-history.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function saveHistory(entry) {
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    } catch {}
  }
  history.push({ ...entry, timestamp: new Date().toISOString() });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function isDangerous(command) {
  const blackListPatterns = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf .*',
    'rm -rf *',
    'rm --no-preserve-root',
    'rm -r --no-preserve-root /',
    'mkfs',
    'mkfs.ext4',
    'mkfs.xfs',
    'mkfs.vfat',
    'dd if=',
    ':(){:|:&};:',
    '>:()',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'init 0',
    'init 6',
    'kill -9 1',
    'mv /',
    'chmod 000',
    'chmod -R 000 /',
    'chown root',
    'yes > /dev/sda',
    'yes > /dev/null',
    '>/dev/sda',
    '>/dev/null',
    'mount -o bind / /dev/null',
    'crontab -r',
    'echo .* >',
    'cat /dev/urandom >',
    'find / -exec rm',
    'find / -delete',
  ];

  const normalized = command
    .toLowerCase()
    .replace(/\s+/g, ' ') // normalize spacing
    .replace(/\n/g, ';'); // treat newlines like semicolons

  const subcommands = normalized.split(/;|\&\&|\|\|/).map(s => s.trim());

  return subcommands.some(sub => {
    return blackListPatterns.some(pattern => sub.includes(pattern));
  });
}

function printHelp() {
  console.log(`
Usage: ai [prompt or command] [--flags]

Examples:
  ai list files in current directory
  ai remove all docker containers
  ai config                    Set your OpenAI API key
  ai history                   Show history of AI-generated commands
  ai man / --help / -h         Show this help message
  ai install-autocomplete      Install autocomplete to your shell config

Flags:
  --explain     Ask AI to explain the command before returning it
  --dry         Show the command but do not execute it

Autocomplete:
  Run the following to enable autocomplete:
    ai install-autocomplete
`);
}

function installAutocompleteScript() {
  const sourcePath = path.join(process.cwd(), 'cmd-ai-completion.sh');
  const targetPath = path.join(os.homedir(), '.cmd-ai-completion.sh');

  if (!fs.existsSync(sourcePath)) {
    console.error(`Autocomplete script not found at: ${sourcePath}`);
    process.exit(1);
  }

  // Copy script to home directory
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o644);
  console.log(`✅ Autocomplete script copied to: ${targetPath}`);

  // Detect shell config file
  const shell = process.env.SHELL || '';
  const rcFile = shell.includes('zsh')
    ? path.join(os.homedir(), '.zshrc')
    : shell.includes('bash')
    ? path.join(os.homedir(), '.bashrc')
    : null;

  const sourceCmd = `source ${targetPath}`;

  if (rcFile) {
    const rcContent = fs.existsSync(rcFile)
      ? fs.readFileSync(rcFile, 'utf-8')
      : '';
    if (!rcContent.includes(sourceCmd)) {
      fs.appendFileSync(rcFile, `\n# cmd-ai autocomplete\n${sourceCmd}\n`);
      console.log(`✅ Updated ${rcFile} to include autocomplete.`);
    } else {
      console.log(`ℹ️ ${rcFile} already includes the autocomplete script.`);
    }

    console.log('\nℹ️ Please restart your terminal or run:');
    console.log(`   source ${rcFile}\n`);
  } else {
    console.log('\n🚨 Could not detect shell config file automatically.');
    console.log(`Please manually add this line to your shell config:`);
    console.log(`   source ${targetPath}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'config') {
    console.log('\nTo use cmd-ai, you need a valid OpenAI API key.');
    console.log('If you don’t have one, follow these steps:\n');
    console.log('1. Go to https://platform.openai.com/account/api-keys');
    console.log('2. Log in or create a free OpenAI account');
    console.log('3. Click “+ Create new secret key”');
    console.log('4. Copy the key (starts with "sk-...") and paste it below\n');

    const key = await ask('Paste your OpenAI API key: ');
    const trimmed = key.trim();

    if (!trimmed.startsWith('sk-') || trimmed.length < 30) {
      console.error(
        'Invalid key format. It should start with "sk-" and be longer than 30 characters.'
      );
      rl.close();
      process.exit(1);
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey: trimmed }, null, 2));
    console.log('\n✅ API key saved successfully.');
    console.log('You can now run commands like:');
    console.log('  ai list all files in this folder\n');
    rl.close();
    return;
  }

  if (['man', '--help', '-h'].includes(args[0])) {
    printHelp();
    rl.close();
    return;
  }

  if (args[0] === 'install-autocomplete') {
    installAutocompleteScript();
    rl.close();
    return;
  }

  if (args[0] === 'history') {
    if (!fs.existsSync(HISTORY_PATH)) {
      console.log('No command history found.');
      rl.close();
      return;
    }
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    history.forEach((entry, idx) => {
      console.log(
        `\n#${idx + 1} (${entry.timestamp})\nPrompt: ${
          entry.prompt
        }\nCommand:\n${entry.command}\nExecuted: ${entry.executed}`
      );
    });
    rl.close();
    return;
  }

  let apiKey;
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    apiKey = config.apiKey;
    if (!apiKey) throw new Error();
  } catch {
    console.error('Missing API key. Please run "ai config" first.');
    rl.close();
    process.exit(1);
  }

  const explainMode = args.includes('--explain');
  const dryRun = args.includes('--dry');
  const filteredArgs = args.filter(
    arg => !['--explain', '--dry'].includes(arg)
  );
  const userPrompt = filteredArgs.join(' ');
  const osInfo = `${os.platform()} ${os.release()}`;
  const explainText = explainMode
    ? 'Explain what the command does, then return it.\n'
    : '';

  const fullPrompt = `
You are a shell assistant.
OS: ${osInfo}
${explainText}Respond only with safe and correct shell command(s), no commentary or headings.
Task: "${userPrompt}"
`.trim();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo-0125',
      messages: [{ role: 'user', content: fullPrompt }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    console.error('OpenAI API error:', await response.text());
    rl.close();
    process.exit(1);
  }

  const data = await response.json();
  const output = data.choices[0].message.content.trim();

  console.log('\nAI Response:\n');
  console.log(output);

  if (isDangerous(output)) {
    console.error(
      '\n** WARNING: This command looks dangerous and will not be executed automatically. **'
    );
    saveHistory({ prompt: userPrompt, command: output, executed: false });
    rl.close();
    return;
  }

  const confirm = await ask(
    dryRun
      ? '\n[Dry run] Press ENTER to simulate, or Ctrl+C to cancel: '
      : '\nDo you want to run it? (Y/n): '
  );
  const shouldRun =
    confirm.trim() === '' || confirm.trim().toLowerCase() === 'y';

  if (!shouldRun) {
    console.log('Operation cancelled.');
    saveHistory({ prompt: userPrompt, command: output, executed: false });
    rl.close();
    return;
  }

  if (dryRun) {
    console.log('\n[Dry run] Command not executed.');
    saveHistory({ prompt: userPrompt, command: output, executed: false });
    rl.close();
    return;
  }

  exec(output, (error, stdout, stderr) => {
    if (error) {
      console.error(`Execution error:\n${error.message}`);
    } else {
      if (stderr) console.error(`Stderr:\n${stderr}`);
      console.log(`Output:\n${stdout}`);
    }
    saveHistory({ prompt: userPrompt, command: output, executed: true });
  });
  rl.close();
}

main();
