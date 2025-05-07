# ai-cli

`ai-cli` is a command-line interface tool designed to integrate AI capabilities into your terminal workflow. It enables users to interact with AI models directly from the command line for various tasks such as text generation, code assistance, and more.

## Installation

To install `ai-cli`, use the following command:

```bash
npm install -g ai-cli
```

Ensure you have Node.js installed on your system before proceeding with the installation.

## Usage

Once installed, you can invoke this library using the `ai` command. For example:

```bash
ai Tell me how much free space is left on the disk
```

This will first display the suggested command based on your input. If you confirm by pressing "Enter," the command will then be executed.

```bash
ai [your task here] [--flags]
ai list all running Docker containers
ai remove all .DS_Store files recursively
ai config                         # Set your OpenAI API key
ai history                        # View past commands
ai man                            # Show help
ai install-autocomplete           # Automatically set up autocomplete
```

## Flags

- `--explain` – Ask AI to explain the command before returning it.
- `--dry` – Show the command but don’t execute it.
- `--help` or `-h` – Show help screen.

## Shell Autocompletion

Generate and install the autocompletion script:

```bash
ai install-autocomplete
```

This will:

Generate the autocomplete script at `~/.ai-cli-completion.sh`

Add source `~/.ai-cli-completion.sh` to your `.bashrc` or `.zshrc`

You can also do it manually:

```bash
ai autocomplete > ~/.ai-cli-completion.sh
echo "source ~/.ai-cli-completion.sh" >> ~/.bashrc   # or ~/.zshrc
source ~/.bashrc                                     # or ~/.zshrc
```

## Safety

`ai-cli` is designed with safety in mind. It includes mechanisms to filter harmful or inappropriate content. However, always review AI-generated outputs before using them in critical applications.

## History

All AI-generated commands are saved (with timestamp and status) in:

```bash
~/.ai-command-history.json
```

View them using:

```bash
ai history
```

## Configuration

Before using the assistant, set your OpenAI API key:

```bash
ai config
```

Your key is securely stored in:

```bash
~/.ai-config.json
```

## License

This project is licensed under the MIT License.

## Author

Made by Broda Noel.
