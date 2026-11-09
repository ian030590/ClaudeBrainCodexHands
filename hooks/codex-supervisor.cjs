const fs = require('node:fs');
const path = require('node:path');

const worker = path.join(__dirname, 'codex-worker.cjs').replaceAll('\\', '/');
const nativeAgents = new Set(['Agent', 'Task', 'TeamCreate']);

function policy(event) {
  const planning = event.permission_mode === 'plan';
  return `Claude is the supervisor; Codex CLI is the worker for this user's development tasks.
You own planning, task boundaries, acceptance criteria, review, and the final response.
Delegate implementation and substantial investigation to Codex. Do not launch Claude subagents, teams, background Claude sessions, or recursive claude commands. Agent, Task, and TeamCreate are blocked by a PreToolUse hook. Do not switch tools or disable hooks to evade this policy.
Invoke a worker with Bash. Pass the task through a single-quoted heredoc so its contents are not interpreted by the shell:

node "${worker}" --cwd "<PROJECT_ABSOLUTE_PATH>" --sandbox ${planning ? 'read-only' : 'workspace-write'} <<'CODEX_TASK'
Describe the scoped task, relevant context, allowed files, constraints, and acceptance checks here.
CODEX_TASK

Use the actual project directory, never an unrelated directory. Use --sandbox read-only for exploration or review. ${planning ? 'You are in plan mode: only read-only investigation is permitted; do not start a writing worker.' : 'Use --sandbox workspace-write for authorized implementation.'}
For long work, use Bash's background execution and retrieve its result with TaskOutput; TaskOutput is allowed. Each invocation prints its log directory, saves events.jsonl, stderr.log, status.json, and result.md, and returns a nonzero exit status on failure. Do not rerun a background task merely because it has not finished.
Pass all relevant user decisions and applicable CLAUDE.md/AGENTS.md requirements into the task. Codex does not inherit your conversation, tools, permissions, or memory. Preserve applicable antislop mode choices in that task when relevant; do not invent a saved preference.
Parallel workers may investigate independently or edit disjoint files; serialize overlapping changes. Workers use the configured Codex model and cannot launch their own Codex subagents. They cannot request interactive sandbox approvals. Report blocked operations; never disable the sandbox as a fallback.
After a worker finishes, inspect its actual diff, check for unintended changes, and independently run the relevant acceptance checks. A worker report alone is not verification. Send corrections to Codex and review again. You may read files and run checks directly. Keep implementation in Codex; do not take over implementation silently if it fails.
No commit, push, deployment, publication, or destructive action unless the user authorized that action. For questions requiring no development work, answer directly without starting a worker.`;
}

function hookResponse(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Expected a Claude hook event object.');
  }
  if (event.hook_event_name === 'PreToolUse') {
    if (!nativeAgents.has(event.tool_name)) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Native Claude subagents are disabled by the user's Codex-worker policy. This tool has NOT run and no Codex worker has started. Delegate the task through Bash to node "${worker}" --cwd "<PROJECT_ABSOLUTE_PATH>" --sandbox ${event.permission_mode === 'plan' ? 'read-only' : 'workspace-write'}, with the complete task on stdin. Then inspect the diff and verify the result yourself. Do not retry Agent/Task or bypass this guard.`,
      },
    };
  }
  if (event.hook_event_name === 'SessionStart') {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: policy(event) } };
  }
  if (event.hook_event_name === 'UserPromptSubmit') {
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Supervisor policy: Claude plans and independently verifies; Codex CLI workers implement. Native Agent/Task/TeamCreate and recursive Claude sessions are forbidden. Use node "${worker}" --cwd "<PROJECT_ABSOLUTE_PATH>" --sandbox read-only|workspace-write with the full task on stdin via Bash. ${event.permission_mode === 'plan' ? 'Plan mode: read-only workers only.' : 'Use the least sandbox permissions the task needs.'} Pass relevant constraints; inspect the actual diff and run checks before claiming completion.`,
      },
    };
  }
  return null;
}

if (require.main === module) {
  try {
    const event = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    const response = hookResponse(event);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`Codex supervisor hook failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { hookResponse, policy };
