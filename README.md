# contextplanner-pi

A [pi](https://pi.dev) extension that adds structured planning, web research, and subagent delegation.

## Features

- **Plan mode** (`/plan`) — structured workflow: understand → design → write plan → approve → execute
- **Web research** — Exa AI semantic search (`/exa-login`, `plan_research` tool)
- **Subagent delegation** — spawn child pi processes for independent tasks
- **Session goals** (`/goal`, `plan_set_goal`) — persistent session intention tracking

## Install

```bash
pi install git:github.com/pdennis/contextplanner-pi
```

## Setup

### Exa API key (for web research)

Set your key via environment variable or the built-in command:

```bash
# Option A: command
# In pi, run: /exa-login

# Option B: env var
export EXA_API_KEY=your-key-here
```

Get a key at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys).

## Commands

| Command | Description |
|---------|-------------|
| `/plan` or `Ctrl+Shift+X` | Enter plan mode |
| `/plan-cancel` | Cancel plan mode |
| `/goal` | View or edit the session goal |
| `/exa-login` | Set your Exa API key |
| `/exa-logout` | Remove stored Exa API key |

## Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `plan_set_goal` | Set/update session goal |
| `plan_question` | Ask clarifying question during planning |
| `plan_set_phase` | Update planning phase indicator |
| `plan_write` | Write plan to file |
| `plan_submit` | Submit plan for approval |
| `plan_research` | Spawn research subagent (Exa search) |
| `subagent` | Delegate task to child pi |
| `exa_search` | Semantic web search |
| `exa_find_similar` | Find pages similar to a URL |
| `exa_get_contents` | Extract content from URLs |

## License

MIT
