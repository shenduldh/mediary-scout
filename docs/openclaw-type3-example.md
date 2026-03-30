# OpenClaw Type 3 Example

This file is an example host prompt for running Type 3 scheduled monitoring in an OpenClaw-style agent environment.

It is not the source of truth for the workflow.
The source of truth remains:

- [SKILL.md](../SKILL.md)
- [references/02-global-constraints.md](../references/02-global-constraints.md)
- [references/03-methods-reference.md](../references/03-methods-reference.md)
- [references/07-type3-checklist.md](../references/07-type3-checklist.md)

Use this example when wiring a scheduled Type 3 job into a host agent that supports cron or recurring execution.

## What This Example Is For

This example is for:

- unattended Type 3 monitoring
- a sub-agent or scheduled agent run
- environments like OpenClaw that can launch an agent on a timer

This example is not needed for:

- Type 1
- Type 2
- bootstrap

## Example Prompt

```json
{
  "kind": "agentTurn",
  "message": "You are the Type 3 monitoring agent for clawd-media-track running in unattended mode.\n\nRead `SKILL.md` first, follow the skill's mandatory reading order, and if bootstrap is complete execute Type 3 exactly as documented.\n\nIf bootstrap is incomplete, stop and report that bootstrap must be completed first.\n\nIf your host environment expects a saved local report after the run, write it only after Type 3 Step 13 completes. Treat that report as a host convention, not as part of the skill contract."
}
```

## What This Example Inherits From The Skill

This example intentionally inherits the following from the formal skill contract:

- bootstrap gate before normal execution
- mandatory reading order
- `[Type 3 - Step N]` output format
- Evidence -> Derived Facts -> Decision
- no glue scripts
- no slicing / top-N on protected collections
- mandatory Step 3b
- transfer binding rule
- verification after side effects

## Why This Prompt Is Intentionally Thin

The host prompt should not restate the skill's hard rules unless the host environment truly needs an extra local constraint.

The formal skill already owns:

- reading order
- task routing
- output format
- safety rules
- anti-glue-script rules
- verification rules

So this host-level example stays lightweight on purpose.

## What This Example Does Not Add As A Hard Rule

This example does not make host-specific reporting paths part of the formal skill contract.

For example, a host may want to save a markdown report after the run.
That can be useful, but it is a local convention of the host environment, not a requirement of the clawd-media-track skill itself.
