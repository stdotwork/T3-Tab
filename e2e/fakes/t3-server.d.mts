// Types for the fake T3 environment, so the server's unit tests can use it too.
export interface FakeT3 {
  origin: string;
  issued(): string[];
  log(): Array<{ method?: string; path?: string; bearer?: string; tool?: string; args?: Record<string, unknown> }>;
  revokeAll(): void;
  close(): Promise<void>;
}

export const FAKE_PROJECTS: Array<Record<string, unknown>>;
export const FAKE_CAPABILITIES: Record<string, unknown>;
export function startFakeT3(options?: { pageSize?: number }): Promise<FakeT3>;
export function approveInBrowser(
  authorizeUrl: string,
  decision: 'read-only' | 'full-access' | 'deny',
): Promise<{ callback: string; status: number; text: string }>;
