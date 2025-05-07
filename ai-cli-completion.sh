# ai-cli autocomplete

_ai_cli_completions() {
  local cur prev opts
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  opts="config history man autocomplete install-autocomplete --help -h --dry --explain"

  if [[ ${cur} == -* ]]; then
    COMPREPLY=( $(compgen -W "--dry --explain --help -h" -- ${cur}) )
    return 0
  fi

  COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
  return 0
}

complete -F _ai_cli_completions ai
