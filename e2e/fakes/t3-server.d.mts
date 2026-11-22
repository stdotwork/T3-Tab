// Types for the fake T3 environment, so the server's unit tests can use it too.
export interface FakeT3 {
  origin: string;
  issued(): string[];
  log(): Array<{ method?: string; path?: string; bearer?: string; tool?: string; args?: Record<string, unknown> }>;
  revokeAll(): void;
  acceptToken(token: string): void;
  close(): Promise<void>;
}

export function startFakeT3(options?: { pageSize?: number; advertiseIss?: boolean; callbackIss?: 'right' | 'wrong' | 'missing' }): Promise<FakeT3>;
export function approveInBrowser(
  authorizeUrl: string,
  decision: 'read-only' | 'full-access' | 'deny',
): Promise<{ callback: string; status: number; text: string }>;
