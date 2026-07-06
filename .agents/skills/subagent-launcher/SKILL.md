---
name: subagent-launcher
description: Start or delegate work to a configured project subagent and ensure its configured skills are loaded. Use when AGENTS.md or the user says to call, launch, spawn, invoke, delegate to, or use a specialized subagent; when a task matches an available subagent listed in AGENTS.md; or when a platform-specific subagent command is needed for Antigravity or Codex.
---

# Subagent Launcher

## Purpose

Use this skill from the main agent to start the appropriate configured subagent without hard-coding agent-specific instructions in the launcher.

The source of truth for available subagents is `AGENTS.md`. Each subagent's concrete instructions, required skills, and role live in `.agents/agents/<name>/agent.json`.

## Selection Workflow

1. Read the nearest relevant `AGENTS.md`.
2. Select the subagent whose description and usage match the user's request.
3. Read that subagent's `.agents/agents/<name>/agent.json`.
4. Resolve every skill listed in `agent.json.skills`.
5. Pass the user's exact task plus any explicitly provided URLs, credentials, files, or constraints.
6. Do not use tools directly when `AGENTS.md` says the subagent owns that workflow.

## Required Skill Loading

Treat `agent.json.skills` as required runtime dependencies, not as proof that the platform has auto-loaded those skills.

For every skill listed in `.agents/agents/<name>/agent.json`:

1. Resolve the skill path as `.agents/skills/<skill-name>/SKILL.md`.
2. Attach the skill to the subagent as a platform-native skill item when supported.
3. If native skill attachment is unavailable, explicitly instruct the subagent to read and follow that `SKILL.md` before acting.
4. Do not make the main agent read full skill bodies unless the platform requires the content to be embedded in the subagent prompt.

## Antigravity

When `define_subagent` and `invoke_subagent` are available:

1. Define a subagent using values from `.agents/agents/<name>/agent.json`.
2. Use full permissions unless the agent config says otherwise:
   - `enable_write_tools: true`
   - `enable_mcp_tools: true`
   - `enable_subagent_tools: true`
3. Build the system prompt from:
   - The agent config `instructions`.
   - The resolved skills listed in the agent config, attached by path when supported.
   - Any platform-required skill content only if Antigravity cannot attach skills by path.
4. Invoke the subagent with the user's task.

## Codex

When `multi_agent_v1.spawn_agent` is available:

1. Spawn a `worker` agent for execution tasks, or an `explorer` agent for bounded codebase questions.
2. Prefer `fork_context: false` unless the subagent needs the current conversation history.
3. Pass the selected agent config and required skills as structured items when supported:

```json
{
  "agent_type": "worker",
  "fork_context": false,
  "items": [
    {
      "type": "text",
      "text": "Use this agent config: .agents/agents/<name>/agent.json"
    },
    {
      "type": "skill",
      "name": "<skill-name>",
      "path": "/home/eliotran/code/.agents/skills/<skill-name>/SKILL.md"
    },
    {
      "type": "text",
      "text": "Execute this delegated task: <USER_REQUEST>"
    }
  ]
}
```

4. Repeat the skill item for every skill listed in `agent.json.skills`.
5. If skill items are unavailable, write a concise prompt that lists every resolved skill path and tells the worker to read and follow them before acting.
6. Wait for the subagent only when its result is needed for the next response or next action.
7. Close completed agents when they are no longer needed.

## Reporting

Report which subagent was used, whether it completed or was blocked, and the result needed by the user. Do not claim success until the subagent reports completion.
