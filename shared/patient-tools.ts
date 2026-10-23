// Tools that wait for somebody by design: an open one is never a hung tool.
export const PATIENT_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode', 'Agent', 'Task']);
