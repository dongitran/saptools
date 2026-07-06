---
description: Auto-log task summaries and tool usage to .agents/logs/
---

# Rule: Interaction Logging

Trigger: Automatically execute upon completing any significant task (bug fix, feature, setup).

Action: 
Create a new folder for the task in .agents/logs/ formatted as: YYYY-MM-DD-task-name/

Inside this folder, create exactly 2 files:

1. summary.md
- Objective: Brief task description.
- Modified Files: List of files created/changed.
- Lessons & Decisions: Root causes, architectural choices, and context.

2. tool-trace.md
- Chronological Tool Log: A strictly sequential log of every tool call made by the agent.
- For EACH tool call, you MUST record:
  1. Full command/parameters: Exactly what was passed to the tool.
  2. Status: Success or the specific error message returned.
  3. Output size: Approximate character count of the response.
