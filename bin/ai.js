#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { exec } from 'child_process';

import { pipeline } from '@xenova/transformers';

const CONFIG_PATH = path.join(os.homedir(), '.ai-config.json');
const HISTORY_PATH = path.join(os.homedir(), '.ai-command-history.json');
const LOCAL_MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
let localPipeline = null;

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
  ai config                    Set your AI provider (local or openai) and API key
  ai history                   Show history of AI-generated commands
  ai man / --help / -h         Show this help message
  ai install-autocomplete      Install autocomplete to your shell config

Flags:
  --explain     Ask AI to explain the command before returning it
  --dry         Show the command but do not execute it
  --version     Show the package version

Providers:
  local       Uses the Qwen3-0.6B model running locally. (Default)
  openai      Uses the OpenAI API (requires API key).

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

async function generateCommandLocal(userPrompt, osInfo, explainMode) {
  if (!localPipeline) {
    console.log(`\nLoading local model "${LOCAL_MODEL_ID}"... (This may take a few minutes the first time)`);
    try {
      localPipeline = await pipeline('text-generation', LOCAL_MODEL_ID); // [1, 3]
      console.log('Model loaded successfully.');
    } catch (error) {
      console.error('Error loading local model:', error);
      console.log('Falling back to OpenAI (if configured)...');
      localPipeline = 'error';
      throw new Error('Local model loading failed.');
    }
  }

  if (localPipeline === 'error') {
      throw new Error('Local model is not available.');
  }


  // Qwen3 instruct format is typically ChatML: <|im_start|>user\nPrompt<|im_end|>\n<|im_start|>assistant\n
  // We instruct it to act as a shell assistant and output only the command.
  const systemMessage = `/no_think You are a shell assistant.
OS: ${osInfo}
${explainMode ? 'Explain what the command does, then return only the command.\n' : ''}Respond only with safe and correct shell command(s), no commentary or headings.
Output *only* the command required to perform the task.`;

  const prompt = `<|im_start|>system\n${systemMessage}<|im_end|>\n<|im_start|>user\n${userPrompt}<|im_end|>\n<|im_start|>assistant\n`; // [5]

  try {
    const output = await localPipeline(prompt, {
      max_new_tokens: 200,
      temperature: 0.3,
    });

    let generatedText = output[0]?.generated_text || '';

    const assistantStartTag = '<|im_start|>assistant\n';
    const assistantIndex = generatedText.indexOf(assistantStartTag);
    if (assistantIndex !== -1) {
        generatedText = generatedText.substring(assistantIndex + assistantStartTag.length).trim();
    }

    // Further refinement: remove any remaining start/end tokens or unwanted text
     generatedText = generatedText.split('<|im_end|>')[0].trim();

    // Sometimes models might repeat the prompt or add conversational filler,
    // a simple heuristic is to look for the first line that looks like a command.
    const lines = generatedText.split('\n');
    let command = generatedText; // Default to the whole output

    // Look for a line starting with a common command or symbol
    const commandStartRegex = /^\s*([a-zA-Z0-9_-]+|\.|\/|~)/;
    for (const line of lines) {
        if (commandStartRegex.test(line.trim())) {
            command = line.trim();
            break;
        }
         // If explain mode is on, the command might be after the explanation.
         // This is a simple approach and might need more sophisticated parsing
         // depending on how the model behaves with the prompt.
         if (explainMode && line.trim().startsWith('`') && line.trim().endsWith('`')) {
             command = line.trim().replace(/^`+/, '').replace(/`+$/, ''); // Extract code block
             break;
         }
    }

     // Basic cleanup: remove leading/trailing quotes or backticks
    command = command.replace(/^['"`]+/, '').replace(/['"`]+$/, '');


    return command;

  } catch (error) {
    console.error('Error generating command with local model:', error);
    throw new Error('Local model inference failed.');
  }
}


// Function to generate command using OpenAI API
async function generateCommandOpenAI(userPrompt, osInfo, apiKey, explainMode) {
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
    throw new Error('OpenAI API request failed.');
  }

  const data = await response.json();
  const output = data.choices[0].message.content.trim();
  return output;
}


async function main() {
  const args = process.argv.slice(2);

  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
      try {
          config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      } catch (e) {
          console.error('Error reading config file:', e.message);
          config = {}; // Reset config if invalid JSON
      }
  }

  // Set default provider if not in config
  if (!config.provider) {
      config.provider = 'local';
  }


  if (args[0] === 'config') {
    console.log('\nConfigure cmd-ai settings.');

    const currentProvider = config.provider || 'local';
    console.log(`Current provider: ${currentProvider}`);

    const provider = await ask('Choose AI provider (local, openai) [local]: ');
    config.provider = provider.trim().toLowerCase() || 'local';

    if (config.provider === 'openai') {
      console.log('\nTo use the OpenAI provider, you need a valid API key.');
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
      config.apiKey = trimmed;
    } else {
        // Remove apiKey if switching away from openai
        delete config.apiKey;
    }


    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('\n✅ Configuration saved successfully.');
    if (config.provider === 'local') {
         console.log(`Using local model "${LOCAL_MODEL_ID}".`);
         console.log('The model will be downloaded on first use.');
    } else if (config.provider === 'openai') {
         console.log('Using OpenAI API.');
    }
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

  if (args[0] === '--version') {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
    );

    console.log(`cmd-ai v${pkg.version}`);
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

  // --- Command Generation ---
  const explainMode = args.includes('--explain');
  const dryRun = args.includes('--dry');
  const filteredArgs = args.filter(
    arg => !['--explain', '--dry'].includes(arg)
  );
  const userPrompt = filteredArgs.join(' ');
  const osInfo = `${os.platform()} ${os.release()}`;

  let output = '';
  let executedProvider = config.provider; // Track which provider was actually used

  try {
    if (config.provider === 'local') {
        output = await generateCommandLocal(userPrompt, osInfo, explainMode);
    } else if (config.provider === 'openai') {
        if (!config.apiKey) {
            console.error('Missing OpenAI API key. Please run "ai config" first.');
             rl.close();
            process.exit(1);
        }
        output = await generateCommandOpenAI(userPrompt, osInfo, config.apiKey, explainMode);
    } else {
        console.error(`Invalid provider configured: ${config.provider}. Please run "ai config".`);
        rl.close();
        process.exit(1);
    }
  } catch (error) {
      console.error(`Error generating command: ${error.message}`);
      // Optionally, fallback to OpenAI if local failed?
      // For now, just exit on error from the chosen provider.
      rl.close();
      process.exit(1);
  }


  console.log(`\nAI Response (Provider: ${executedProvider}):\n`);
  console.log(output);

  if (isDangerous(output)) {
    console.error(
      '\n** WARNING: This command looks dangerous and will not be executed automatically. **'
    );
    saveHistory({ prompt: userPrompt, command: output, executed: false, provider: executedProvider });
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
    saveHistory({ prompt: userPrompt, command: output, executed: false, provider: executedProvider });
    rl.close();
    return;
  }

  if (dryRun) {
    console.log('\n[Dry run] Command not executed.');
    saveHistory({ prompt: userPrompt, command: output, executed: false, provider: executedProvider });
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
    saveHistory({ prompt: userPrompt, command: output, executed: true, provider: executedProvider });
    rl.close(); // Close readline interface after execution finishes
  });
}

main();