#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { exec } from 'child_process';

import { pipeline } from '@huggingface/transformers';

const CONFIG_PATH = path.join(os.homedir(), '.ai-config.json');
const HISTORY_PATH = path.join(os.homedir(), '.ai-command-history.json');
const LOCAL_MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
let localPipeline = null;
let localPipelineStatus = 'unloaded'; // 'unloaded', 'loading', 'loaded', 'error', 'downloading'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let lastProgress = 0;

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function saveHistory(entry) {
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      // Limit history size to prevent huge files
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')).slice(-1000); // Keep last 1000 entries
    } catch (e) {
      console.error('Error reading history file, starting fresh:', e.message);
      history = [];
    }
  }
  history.push({ ...entry, timestamp: new Date().toISOString() });
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('Error writing history file:', e.message);
  }
}

function isDangerous(command) {
  // Normalize command for safer checking
  const normalized = command
    .toLowerCase()
    .replace(/\s+/g, ' ') // normalize spacing
    .replace(/\\+$/, '') // remove trailing backslashes used for line continuation, check single lines
    .replace(/\n/g, ';'); // treat newlines like semicolons for splitting

  // Split into potential subcommands (separated by ;, &&, ||)
  // Basic split might not handle complex quoting/escaping perfectly, but good for common cases
  const subcommands = normalized
    .split(/;|&&|\|\||\(|\)|\{|\}/)
    .map(s => s.trim())
    .filter(s => s !== '');

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
    'dd of=/dev/', // More specific dd pattern
    ':(){:|:&};:',
    '>:()', // Fork bomb variants
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'init 0',
    'init 6',
    'kill -9 1', // Killing init/systemd
    'mv /', // Moving root
    'chmod 000',
    'chmod -r 000 /',
    'chown root', // Changing ownership of critical files/dirs
    'yes > /dev/', // Overwriting devices
    '>/dev/', // Overwriting devices
    'mount -o bind / /dev/null', // Potential FS manipulation
    'crontab -r', // Removing all cron jobs
    'echo .* >', // Dangerous output redirection
    'cat /dev/urandom >', // Dangerous output redirection
    'find / -exec rm',
    'find / -delete', // Dangerous find commands
    'wipefs',
    'shred', // Data destruction tools
    'nohup .* >/dev/null 2>&1 &', // Running commands detached and discarding output (can hide malicious activity) - maybe too broad? Let's skip for now.
    'curl .* | sh',
    'wget .* | sh', // Downloading and piping to shell
    'base64 -d <<< .* | sh', // Decoding and piping to shell
  ];

  // Basic check for pipe to sh/bash/etc. or similar execution
  if (
    /\s*\|\s*(sh|bash|zsh|csh|ksh|python|perl|ruby)\s*(-c|\s|$)/.test(
      normalized
    )
  ) {
    console.warn(
      'Potential dangerous pattern: Piping output to a shell or interpreter.'
    );
    return true; // Flag as dangerous
  }

  return subcommands.some(sub => {
    // Check if subcommand starts with a dangerous pattern
    return blackListPatterns.some(pattern => sub.startsWith(pattern));
  });
}

function printHelp() {
  console.log(`
Usage: ai [prompt or command] [--flags]

Examples:
  ai list files in current directory
  ai remove all docker containers
  ai list files in current directory and save to file.txt
  ai config                    Set your AI provider (local or openai) and API key
  ai history                   Show history of AI-generated commands
  ai man / --help / -h         Show this help message
  ai install-autocomplete      Install autocomplete to your shell config

Flags:
  --explain     Ask AI to explain the command before returning it
  --dry         Show the command but do not execute it
  --version     Show the package version

Providers:
  local       Uses the Qwen3-0.6B ONNX model running locally. (Default)
  gemini      Uses the Google Gemini API (requires API key).
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
    console.error(`Autocomplete script not found at: ${sourcePath}\n`);
    console.error(
      `Please ensure you are running 'ai install-autocomplete' from the directory where cmd-ai was installed globally, or locate the 'cmd-ai-completion.sh' script manually.\n`
    );
    process.exit(1);
  }

  // Copy script to home directory
  try {
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, 0o644); // Read/write for user, read for others
    console.log(`✅ Autocomplete script copied to: ${targetPath}`);
  } catch (e) {
    console.error(`Error copying autocomplete script: ${e.message}\n`);
    process.exit(1);
  }

  // Detect shell config file
  const shell = process.env.SHELL || '';
  let rcFile = null;
  if (shell.includes('zsh')) {
    rcFile = path.join(os.homedir(), '.zshrc');
  } else if (shell.includes('bash')) {
    rcFile = path.join(os.homedir(), '.bashrc');
  } else if (shell.includes('ksh')) {
    rcFile = path.join(os.homedir(), '.kshrc');
  }

  const sourceCmd = `source ${targetPath}`;

  if (rcFile) {
    try {
      const rcContent = fs.existsSync(rcFile)
        ? fs.readFileSync(rcFile, 'utf-8')
        : '';

      if (!rcContent.includes(sourceCmd)) {
        // Check if the source command exists line-by-line or within commented sections
        const lines = rcContent.split('\n');
        const alreadySourced = lines.some(line =>
          line.trim().replace(/^#\s*/, '').includes(sourceCmd)
        );

        if (!alreadySourced) {
          fs.appendFileSync(rcFile, `\n# cmd-ai autocomplete\n${sourceCmd}\n`);
          console.log(`✅ Updated ${rcFile} to include autocomplete.`);
        } else {
          console.log(
            `ℹ️ ${rcFile} already includes the autocomplete script (or a commented version).`
          );
        }
      } else {
        console.log(`ℹ️ ${rcFile} already includes the autocomplete script.`);
      }

      console.log('\nℹ️ Please restart your terminal or run:');
      console.log(`   source ${rcFile}\n`);
    } catch (e) {
      console.error(
        `Error updating shell config file ${rcFile}: ${e.message}\n`
      );
      console.log('\n🚨 Could not update shell config file automatically.');
      console.log(
        `Please manually add this line to your shell config (${rcFile} or similar):`
      );
      console.log(`   ${sourceCmd}\n`);
    }
  } else {
    console.log('\n🚨 Could not detect shell config file automatically.');
    console.log(
      `Please manually add this line to your shell config (.bashrc, .zshrc, etc.):`
    );
    console.log(`   ${sourceCmd}\n`);
  }
}

// Callback function for download progress
function downloadProgressCallback({ file, progress, total }) {
  if (progress !== undefined && total !== undefined) {
    // Check for undefined as progress might be NaN/Infinity sometimes
    const percentage = Math.round((progress / total) * 100);
    if (percentage > lastProgress || percentage === 0 || percentage === 100) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      const fileName = file ? path.basename(file) : 'Model file';
      process.stdout.write(`Downloading ${fileName}: ${percentage}%\n`);
      lastProgress = percentage;
    }
    if (percentage === 100 && lastProgress === 100) {
      process.stdout.write('\n');
      lastProgress = 0;
    }
  } else if (file) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`Downloading ${path.basename(file)}...\n`);
  }
}

// Function to download the local model explicitly
async function downloadLocalModel() {
  if (
    localPipelineStatus === 'loaded' ||
    localPipelineStatus === 'loading' ||
    localPipelineStatus === 'downloading'
  ) {
    console.log('Local model is already loaded, loading, or downloading.');
    return;
  }
  localPipelineStatus = 'downloading';
  console.log(`\nInitiating download for local model "${LOCAL_MODEL_ID}"...`);
  console.log('Files will be cached for future use.');
  try {
    // Use pipeline to trigger download. It will cache the model files.
    // We don't need to assign it to localPipeline here, just trigger the download.
    await pipeline(
      'text-generation',
      LOCAL_MODEL_ID,
      { dtype: 'fp32' },
      {
        progress_callback: downloadProgressCallback,
      }
    );
    console.log('Model download complete.');
    localPipelineStatus = 'unloaded';
  } catch (error) {
    console.error('\nError during model download:', error);
    localPipelineStatus = 'error';
    throw new Error(
      'Local model download failed. Please check your internet connection, disk space, and permissions.'
    );
  }
}

// --- Helper function to parse model output ---
function parseModelOutput(output, explainMode) {
  let explanation = null;
  let command = output.trim(); // Start with the whole output

  // Regex to find fenced code blocks (e.g., ```bash...```)
  // Capture group 1 is the content inside. Use 's' flag for . to match newlines.
  const fencedCodeBlockRegex = /```(?:\w+)?\s*([\s\S]+?)```/s;

  const fencedMatch = command.match(fencedCodeBlockRegex);

  if (fencedMatch) {
    // Found a fenced code block
    command = fencedMatch[1].trim(); // The content inside the block is the command
    // Everything before the first block is potentially explanation
    const explanationPart = output.substring(0, fencedMatch.index).trim();
    if (explanationPart) {
      explanation = explanationPart;
    }

    // Basic cleanup of leading/trailing quotes/backticks/whitespace from command
    // Although code blocks usually don't have this, being defensive
    command = command.replace(/^['"`\s]+/, '').replace(/['"`\s]+$/, '');

    // Remove leading conversational filler from explanation part
    if (explanation) {
      const conversationalStarts =
        /^(?:(hi|hello|hey|greetings|i am|i'm|as a large language model|i cannot|i'm sorry|i understand|okay|sure|alright|of course|you can|you could|to do that|here is|here's)|[^\s]+:)/i;
      const explanationLines = explanation
        .split('\n')
        .filter(line => line.trim() !== '');
      let cleanedExplanationLines = [];
      for (const line of explanationLines) {
        if (conversationalStarts.test(line.trim())) {
          // Stop if a conversational line is encountered
          break;
        }
        cleanedExplanationLines.push(line);
      }
      explanation = cleanedExplanationLines.join('\n').trim();
      if (explanation === '') explanation = null; // If cleanup resulted in empty string
    }
  } else {
    // No fenced code block found. Fallback to line-by-line analysis.
    // Use a more robust check for command start, including symbols like >, |
    const commandStartRegex =
      /^[a-zA-Z0-9_-]+|^\.|\/|~|^[>|!$%&*+,-./:;=?@^_~]/; // Starts with word char, ., /, ~, or common shell symbols/operators
    const conversationalLineRegex =
      /^(?:(hi|hello|hey|greetings|i am|i'm|as a large language model|i cannot|i'm sorry|i understand|okay|sure|alright|of course|you can|you could|to do that|here is|here's)|[^\s]+:)/i;

    const lines = output.split('\n'); // Keep empty lines for line numbering context in slicing

    let firstCommandLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmedLine = lines[i].trim();
      if (trimmedLine === '') continue; // Skip empty lines for this check

      // Find the first line that looks like a command and not conversation
      if (
        commandStartRegex.test(trimmedLine) &&
        !conversationalLineRegex.test(trimmedLine.toLowerCase())
      ) {
        firstCommandLineIndex = i;
        break;
      }
    }

    if (firstCommandLineIndex !== -1) {
      // Found a line that looks like a command start
      if (explainMode) {
        // In explain mode, lines before are explanation, that line + all subsequent are command
        explanation = lines.slice(0, firstCommandLineIndex).join('\n').trim();
        if (explanation === '') explanation = null;

        command = lines.slice(firstCommandLineIndex).join('\n').trim(); // Join all lines from the first command line onwards
      } else {
        // In non-explain mode, just take the first identified command line and *all* subsequent lines.
        // This handles `cmd1\ncmd2` outside a block in non-explain mode.
        command = lines.slice(firstCommandLineIndex).join('\n').trim();
        explanation = null; // No explanation extracted in this mode/fallback
      }

      // Basic cleanup of leading/trailing quotes/backticks/whitespace from command
      command = command.replace(/^['"`\s]+/, '').replace(/['"`\s]+$/, '');
      // Remove leading/trailing common shell prompts if model included them
      command = command.replace(/^\$\s+/, '').replace(/^#\s+/, '');
    } else {
      // No line found that looks like a command start.
      // This might happen if the model is overly conversational or gave an error/unparseable response.
      console.warn(
        'Warning: Could not identify a clear command start line or code block in the model output.'
      );
      // In this case, return the full output as the command, and no explanation separation was possible.
      command = output.trim(); // Use the original trimmed output
      explanation = null; // No clear explanation/command separation possible
    }
  }

  // Final check on command - if extraction resulted in empty string, fallback to full output
  if (command === '') {
    console.warn(
      'Warning: Command extraction resulted in an empty string. Using full output as command.'
    );
    command = output.trim();
    explanation = null; // Reset explanation as separation failed
  }

  // Final cleanup of explanation
  if (explanation) {
    explanation = explanation.trim();
    if (explanation === '') explanation = null;
  }

  return { explanation, command };
}

// Modify generateCommandLocal to return raw output string
async function generateCommandLocal(
  userPrompt,
  osInfo,
  shellInfo,
  explainMode
) {
  if (localPipelineStatus === 'error') {
    throw new Error(
      'Local model is in an error state. Please re-configure using "ai config".'
    );
  }
  if (localPipelineStatus === 'downloading') {
    console.log('Waiting for local model download to complete...');
    // Simple loop to wait, potentially add timeout
    while (localPipelineStatus === 'downloading') {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (localPipelineStatus === 'error') {
      throw new Error('Local model download failed during wait.');
    }
    if (localPipelineStatus === 'unloaded') {
      // Download finished, now it needs loading
      // continue to loading logic below
    } else if (localPipelineStatus === 'loaded') {
      // Download finished and maybe something else loaded it? Unlikely but safe.
      // continue to inference
    }
  }

  if (!localPipeline) {
    localPipelineStatus = 'loading';
    console.log(
      `\nLoading local model "${LOCAL_MODEL_ID}"... (This may take a moment on first load)`
    );
    try {
      localPipeline = await pipeline(
        'text-generation',
        LOCAL_MODEL_ID,
        { dtype: 'fp32' },
        {
          progress_callback: downloadProgressCallback,
        }
      );
      console.log('Model loaded successfully.');
      localPipelineStatus = 'loaded';
    } catch (error) {
      console.error('\nError loading local model:', error);
      localPipelineStatus = 'error';
      localPipeline = null;
      throw new Error('Local model loading or initialization failed.');
    }
  }

  // We instruct it to act as a shell assistant. /no_think is a special instruction to avoid thinking for qwen3 models.
  // The instruction now asks it to explain *then* provide the command, optionally in a code block.
  const systemMessage = `
/no_think You are a helpful shell (${shellInfo}) assistant, running on ${osInfo} OS.
The user will ask for a task he wants to accomplish or needs help with.
For example: "List all files in this folder", "Remove all docker containers", "List files in current directory and save to file.txt", etc.
Your goal is to provide the user with a safe and correct shell command(s) to accomplish the task.
${
  explainMode
    ? 'First, provide a brief explanation of the command. Then, provide the command, ideally in a fenced code block (e.g., ```bash\n...\n```).\n'
    : 'Respond only with the command, ideally in a fenced code block (e.g., ```bash\n...\n```). No commentary or headings.'
}
Output *only* the explanation and the command, or just the command.`; // Added instruction for code block

  const prompt = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userPrompt },
  ];

  try {
    const output = await localPipeline(prompt, {
      max_new_tokens: explainMode ? 600 : 150, // Allow more tokens for explanation
      temperature: 0.3,
    });

    let response = output[0]?.generated_text[2].content;
    response = response.replace(/<think>[\s\S]*?<\/think>/g, '');

    let generatedText = response || '';

    return generatedText;
  } catch (error) {
    console.error('Error generating command with local model:', error);
    // Check if the error suggests model file issues
    if (
      error.message.includes('Not a valid file') ||
      error.message.includes('Error loading model')
    ) {
      console.error(
        'It seems the local model files are missing or corrupt. Try running "ai config" to re-download.'
      );
      localPipelineStatus = 'error'; // Indicate a potential persistent issue
      localPipeline = null;
    }
    throw new Error('Local model inference failed.');
  }
}

async function generateCommandGemini(
  userPrompt,
  osInfo,
  shellInfo,
  apiKey,
  explainMode
) {
  const config = {
    responseMimeType: 'text/plain',
  };
  const model = 'gemini-2.0-flash-lite';

  const explainText = explainMode
    ? 'First, provide a brief explanation of the command. Then, provide the command, ideally in a fenced code block (e.g., ```bash\n...\n```).\n'
    : 'Respond only with the command, ideally in a fenced code block (e.g., ```bash\n...\n```). No commentary or headings.\n';

  const fullPrompt = `
  You are a helpful shell (${shellInfo}) assistant, running on ${osInfo} OS.
  The user will ask for a task he wants to accomplish or needs help with.
  For example: "List all files in this folder", "Remove all docker containers", "List files in current directory and save to file.txt", etc.
  Your goal is to provide the user with a safe and correct shell command(s) to accomplish the task.
  ${explainText}
  Task: "${userPrompt}"
  `.trim();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: fullPrompt,
                },
              ],
              role: 'user',
            },
          ],
          generationConfig: config,
        }),
      }
    ).then(res => res.json());

    const rawOutput = response.candidates[0].content.parts[0].text;

    if (!rawOutput || rawOutput.trim() === '') {
      throw new Error('Gemini API returned an empty response.');
    }

    return rawOutput.trim();
  } catch (error) {
    console.error('Google Gemini API error:', error.message);
    let detail = '';
    if (error.status) detail += ` Status: ${error.status}`;
    if (error.code) detail += ` Code: ${error.code}`;
    if (error.details) detail += ` Details: ${JSON.stringify(error.details)}`;
    if (error.stack) console.error('Stack:', error.stack);

    throw new Error(`Google Gemini API request failed.${detail}`);
  }
}

// Function to generate command using OpenAI API
async function generateCommandOpenAI(
  userPrompt,
  osInfo,
  shellInfo,
  apiKey,
  explainMode
) {
  const explainText = explainMode
    ? 'First, provide a brief explanation of the command. Then, provide the command, ideally in a fenced code block (e.g., ```bash\n...\n```).\n'
    : 'Respond only with the command, ideally in a fenced code block (e.g., ```bash\n...\n```). No commentary or headings.\n'; // Added instruction for code block

  const fullPrompt = `
You are a helpful shell (${shellInfo}) assistant, running on ${osInfo} OS.
  The user will ask for a task he wants to accomplish or needs help with.
  For example: "List all files in this folder", "Remove all docker containers", "List files in current directory and save to file.txt", etc.
  Your goal is to provide the user with a safe and correct shell command(s) to accomplish the task.
${explainText}
Task: "${userPrompt}"
`.trim();

  try {
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
      const errorBody = await response.json(); // Attempt to parse error body
      console.error('OpenAI API error:', errorBody);
      let errorMessage = `OpenAI API request failed: ${response.status} ${response.statusText}`;
      if (errorBody && errorBody.error && errorBody.error.message) {
        errorMessage += ` - ${errorBody.error.message}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const rawOutput = data.choices[0].message.content.trim();

    return rawOutput;
  } catch (error) {
    // Handle network errors etc.
    console.error('OpenAI API communication error:', error.message);
    throw new Error(`Failed to communicate with OpenAI API: ${error.message}`);
  }
}

async function main() {
  // Ensure readline is closed on process exit for clean shutdown
  process.on('exit', () => {
    if (!rl.closed) {
      rl.close();
    }
  });

  // Handle Ctrl+C (SIGINT) gracefully
  rl.on('SIGINT', () => {
    console.log('\nOperation cancelled.');
    if (!rl.closed) {
      rl.close();
    }
    process.exit(1);
  });

  const args = process.argv.slice(2);

  let config = {
    provider: 'local',
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      // Merge existing config with defaults, ensuring 'provider' is kept if present
      config = { ...config, ...existingConfig };
    } catch (e) {
      console.error('Error reading config file:', e.message);
      // Keep default config if file is corrupt
    }
  }

  // Ensure provider is one of the valid options
  if (!['local', 'openai', 'gemini'].includes(config.provider)) {
    console.warn(
      `Invalid provider "${config.provider}" found in config. Falling back to "local". Run "ai config" to fix.`
    );
    config.provider = 'local';
  }

  if (args[0] === 'config') {
    console.log('\nConfigure cmd-ai settings.');

    const currentProvider = config.provider || 'local';
    console.log(`Current provider: ${currentProvider}`);

    const provider = await ask(
      'Choose AI provider (local, openai, gemini) [local]: '
    );
    const selectedProvider = provider.trim().toLowerCase() || 'local';

    if (!['local', 'openai', 'gemini'].includes(selectedProvider)) {
      console.error(
        'Invalid provider selected. Please choose "local", "openai", or "gemini".'
      );
      rl.close();
      process.exit(1);
    }

    config.provider = selectedProvider;

    if (config.provider === 'openai') {
      // Clear Gemini key if switching from gemini
      if (config.geminiApiKey) delete config.geminiApiKey;
      console.log('\nTo use the OpenAI provider, you need a valid API key.');
      console.log('If you don’t have one, follow these steps:\n');
      console.log('1. Go to https://platform.openai.com/account/api-keys');
      console.log('2. Log in or create a free OpenAI account');
      console.log('3. Click “+ Create new secret key”');
      console.log(
        '4. Copy the key (starts with "sk-...") and paste it below\n'
      );

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
      if (config.apiKey) delete config.apiKey;
    }

    if (config.provider === 'gemini') {
      // Remove apiKey if switching away from openai
      if (config.apiKey) delete config.apiKey;
      console.log(
        '\nTo use the Google Gemini provider, you need a valid API key.'
      );
      console.log('If you don’t have one, follow these steps:\n');
      console.log('1. Go to https://aistudio.google.com/app/apikey');
      console.log('2. Log in or create a Google account');
      console.log('3. Create or copy an existing API key\n');

      const key = await ask('Paste your Google Gemini API key: ');
      const trimmed = key.trim();

      if (trimmed.length < 30) {
        // Basic length check
        console.error(
          'Invalid key format. The key should be longer than 30 characters.'
        );
        rl.close();
        process.exit(1);
      }
      config.geminiApiKey = trimmed;
    } else {
      // Remove geminiApiKey if switching away from gemini
      if (config.geminiApiKey) delete config.geminiApiKey;
    }

    if (config.provider === 'local') {
      // Trigger download/check if local is selected
      try {
        await downloadLocalModel();
        localPipeline = null; // Ensure pipeline is null to force load on first generation
      } catch (e) {
        console.error(`\nFailed during local model setup: ${e.message}`);
        rl.close();
        process.exit(1);
      }
    }

    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('\n✅ Configuration saved successfully.');
      if (config.provider === 'local') {
        console.log(`Using local model "${LOCAL_MODEL_ID}".`);
        console.log('Model files are downloaded or updated.');
      } else if (config.provider === 'openai') {
        console.log('Using OpenAI API.');
      } else if (config.provider === 'gemini') {
        console.log('Using Google Gemini API.');
      }
      console.log('You can now run commands like:');
      console.log('  ai list all files in this folder\n');
    } catch (e) {
      console.error('Error saving config file:', e.message);
      process.exit(1);
    }

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

    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
      );
      console.log(`cmd-ai v${pkg.version}`);
    } catch (error) {
      console.error(
        'Could not read package.json to determine version: ' + error.message
      );
      console.log('cmd-ai version unknown');
    }

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
    try {
      const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
      if (history.length === 0) {
        console.log('Command history is empty.');
        rl.close();
        return;
      }
      history.forEach((entry, idx) => {
        console.log(
          `\n--- History Entry #${idx + 1} ---\nTimestamp: ${
            entry.timestamp
          }\nPrompt: ${entry.prompt}\nCommand:\n${entry.command}\nExecuted: ${
            entry.executed
          }${entry.provider ? ` (Provider: ${entry.provider})` : ''}${
            entry.notes ? `\nNotes: ${entry.notes}` : ''
          }`
        );
      });
    } catch (e) {
      console.error('Error reading or parsing history file:', e.message);
    }
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
  const osInfo = `${os.platform()} ${os.release()} (${os.arch()})`; // Add architecture
  const shellInfo = process.env.SHELL
    ? path.basename(process.env.SHELL)
    : 'sh, zsh, ksh, etc';

  if (!userPrompt) {
    printHelp();
    rl.close();
    process.exit(0);
  }

  let rawModelOutput = '';
  let executedProvider = config.provider;

  try {
    if (config.provider === 'local') {
      console.log('Explain mode:', explainMode);
      rawModelOutput = await generateCommandLocal(
        userPrompt,
        osInfo,
        shellInfo,
        explainMode
      );
    } else if (config.provider === 'openai') {
      if (!config.apiKey) {
        console.error(
          'Missing OpenAI API key for the "openai" provider. Please run "ai config" first.'
        );
        rl.close();
        process.exit(1);
      }
      rawModelOutput = await generateCommandOpenAI(
        userPrompt,
        osInfo,
        shellInfo,
        config.apiKey,
        explainMode
      );
    } else if (config.provider === 'gemini') {
      if (!config.geminiApiKey) {
        console.error(
          'Missing Google Gemini API key for the "gemini" provider. Please run "ai config" first.'
        );
        rl.close();
        process.exit(1);
      }
      // Gemini API does not support streaming by default with generateContent, so no progress display here easily
      rawModelOutput = await generateCommandGemini(
        userPrompt,
        osInfo,
        shellInfo,
        config.geminiApiKey,
        explainMode
      );
    } else {
      // Should not happen with default config handling, but as a safeguard
      console.error(
        `Invalid provider configured: ${config.provider}. Please run "ai config".`
      );
    }
  } catch (error) {
    console.error(`\nError generating command: ${error.message}`);
    saveHistory({
      prompt: userPrompt,
      command: 'Error generating command',
      executed: false,
      provider: executedProvider,
      notes: `Generation failed: ${error.message}`,
    });
    rl.close();
    process.exit(1);
  }

  // --- Parse the raw model output ---
  const { explanation, command } = parseModelOutput(
    rawModelOutput,
    explainMode
  );

  console.log(`\nAI Response (Provider: ${executedProvider}):`);

  // Print explanation if explain mode is on and explanation was extracted
  if (explainMode && explanation) {
    console.log('\n--- Explanation ---');
    console.log(explanation);
  }

  // Always print the extracted command
  console.log('\n--- Proposed Command ---');
  console.log(command);
  console.log('----------------------');

  if (!command || command.trim() === '') {
    console.error('\nCould not extract a valid command from the AI response.');
    console.log('Full AI output was:');
    console.log(rawModelOutput); // Show user the raw output if parsing failed
    saveHistory({
      prompt: userPrompt,
      command: rawModelOutput,
      executed: false,
      provider: executedProvider,
      notes: 'Command extraction failed',
    }); // Save raw output if command extraction fails
    rl.close();
    return;
  }

  if (isDangerous(command)) {
    console.error(
      '\n** WARNING: This command looks dangerous and will not be executed automatically. **'
    );
    saveHistory({
      prompt: userPrompt,
      command: command,
      executed: false,
      provider: executedProvider,
      notes: 'Dangerous command detected',
    });
    rl.close();
    return;
  }

  const confirm = await ask(
    dryRun
      ? '\n[Dry run] Press ENTER to simulate execution, or Ctrl+C to cancel: '
      : '\nDo you want to run the proposed command(s)? (Y/n): ' // Clearer prompt for potential multiple commands
  );
  const shouldRun =
    confirm.trim() === '' || confirm.trim().toLowerCase() === 'y';

  if (!shouldRun) {
    console.log('Operation cancelled.');
    saveHistory({
      prompt: userPrompt,
      command: command,
      executed: false,
      provider: executedProvider,
      notes: 'Cancelled by user',
    });
    rl.close();
    return;
  }

  if (dryRun) {
    console.log('\n[Dry run] Command not executed.');
    saveHistory({
      prompt: userPrompt,
      command: command,
      executed: false,
      provider: executedProvider,
      notes: 'Dry run',
    });
    rl.close();
    return;
  }

  // Close readline before executing command to avoid interference
  rl.close();

  console.log('\nExecuting command...');
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`\nExecution error:\n${error.message}`);
      saveHistory({
        prompt: userPrompt,
        command: command,
        executed: false,
        provider: executedProvider,
        notes: `Execution failed: ${error.message}`,
      });
    } else {
      if (stdout) console.log(`\nStdout:\n${stdout}`);
      if (stderr) console.error(`\nStderr:\n${stderr}`);
      if (!stdout && !stderr) {
        console.log('\nCommand executed successfully with no output.');
      }
      saveHistory({
        prompt: userPrompt,
        command: command,
        executed: true,
        provider: executedProvider,
      });
    }
  });
}

// Handle unhandled promise rejections
process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
  // Application specific error handling
  if (rl && !rl.closed) {
    rl.close();
  }
  if (!process.exitCode) {
    // Prevent double exit
    process.exit(1); // Exit with a non-zero code
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  if (rl && !rl.closed) {
    rl.close();
  }
  if (!process.exitCode) {
    // Prevent double exit
    process.exit(1); // Exit with a non-zero code
  }
});

main();
