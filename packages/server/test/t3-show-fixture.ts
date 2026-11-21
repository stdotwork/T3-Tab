/**
 * What `t3 thread show --json` prints: `{ thread, messages }`, with every field of T3 Code's
 * `OrchestratorMcpThreadDetail` (T3 Code 0.1.11). There is no failure text anywhere in it.
 */
export function t3ShowJson(thread: { status: string; latestRunId?: string; title?: string }, messages: unknown[] = []): string {
  return JSON.stringify({
    thread: {
      threadId: 'th1',
      projectId: 'project-1',
      title: 'Thread',
      createdBy: 'user',
      creationSource: 'cli',
      latestRunId: null,
      activeRunId: null,
      providerInstanceId: 'claudeAgent',
      model: 'claude-haiku',
      runtimeMode: 'full-access',
      interactionMode: 'default',
      linkedPullRequest: null,
      titleRegeneration: null,
      branch: null,
      worktreePath: null,
      parentThreadId: null,
      relationshipToParent: null,
      runCount: 1,
      itemCount: 1,
      pendingRequestCount: 0,
      archived: false,
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
      ...thread,
    },
    messages,
  });
}
