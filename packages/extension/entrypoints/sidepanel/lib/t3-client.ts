/** The panel's live connection to T3 Code: providers, projects, the thread list and the threads being watched. */
import type { EnvironmentTheme } from '../../../src/t3/theme-palette';
import { errorText } from './api';
import { RpcSocket } from './t3-rpc';
import { forgetSession, pairWithT3, SessionRefused, socketUrl, storedSession, type T3Session } from './t3-session';
import { t3ThreadView, type T3Projection, type ThreadView } from './thread-model';

export interface ModelOptionChoice {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  type: 'select' | 'boolean';
  role?: string;
  options?: ModelOptionChoice[];
  currentValue?: string | boolean;
}

export interface ProviderModel {
  slug: string;
  name: string;
  shortName?: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  capabilities?: { optionDescriptors?: ModelOption[] } | null;
}

export interface Provider {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  models: ProviderModel[];
  supportedRuntimeModes?: string[];
  unavailableReason?: string;
}

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
  archivedAt?: string | null;
  defaultModelSelection?: ModelSelection | null;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  status?: string;
  runtimeMode?: string;
  modelSelection?: ModelSelection;
  providerInstanceId?: string;
  updatedAt?: string;
  latestUserMessageAt?: string | null;
  pendingRuntimeRequest?: { id: string; kind: string } | null;
}

export type T3Status = 'off' | 'connecting' | 'ready' | 'lost';

export interface T3State {
  status: T3Status;
  error?: string;
  origin?: string;
  providers: Provider[];
  projects: Project[];
  threads: ThreadShell[];
  defaultTheme: string;
  defaultAppearance: string;
  themes: EnvironmentTheme[];
  threadStop: boolean;
}

type ConfigEvent =
  | { type: 'snapshot'; config: { providers: Provider[]; settings: { defaultTheme?: string; defaultAppearance?: string }; environment?: { capabilities?: { threadStop?: boolean } } } }
  | { type: 'providerStatuses'; payload: { providers: Provider[] } }
  | { type: 'settingsUpdated'; payload: { settings: { defaultTheme?: string; defaultAppearance?: string } } }
  | { type: 'environmentThemesUpdated'; payload: { themes: EnvironmentTheme[] } }
  | { type: string; payload?: unknown };

export type ShellItem =
  | { kind: 'snapshot'; snapshot: { threads: ThreadShell[]; projects: Project[] }; resolvedRepositoryIdentityRoots?: string[] }
  | { kind: 'project.updated'; project: Project }
  | { kind: 'project.removed'; projectId: string }
  | { kind: 'thread.updated'; location: 'active' | 'archive'; thread: ThreadShell }
  | { kind: 'thread.removed'; threadId: string }
  | { kind: string };

type ThreadItem =
  | { kind: 'snapshot'; projection: T3Projection }
  | { kind: 'event'; event: { type: string; payload?: unknown; threadId?: string } }
  | { kind: string };

interface Watch {
  projection?: T3Projection;
  view?: ThreadView;
  stop?: () => void;
  listeners: Set<(view: ThreadView) => void>;
}

const EMPTY: T3State = { status: 'off', providers: [], projects: [], threads: [], defaultTheme: '', defaultAppearance: '', themes: [], threadStop: false };

const upsert = <T extends { id: string }>(list: readonly T[], value: T): T[] => {
  const index = list.findIndex((entry) => entry.id === value.id);
  if (index === -1) return [...list, value];
  const next = [...list];
  next[index] = value;
  return next;
};

export function applyThreadEvent(projection: T3Projection, event: { type: string; payload?: unknown }): T3Projection {
  const { type, payload } = event;
  if (type === 'run.created' || type === 'run.updated') {
    return { ...projection, runs: upsert(projection.runs, payload as T3Projection['runs'][number]) };
  }
  if (type === 'runtime-request.updated') {
    return { ...projection, runtimeRequests: upsert(projection.runtimeRequests, payload as T3Projection['runtimeRequests'][number]) };
  }
  if (type === 'turn-item.updated') {
    const item = payload as T3Projection['visibleTurnItems'][number]['item'];
    const index = projection.visibleTurnItems.findLastIndex((entry) => entry.item.id === item.id);
    const visibleTurnItems = [...projection.visibleTurnItems];
    if (index === -1) visibleTurnItems.push({ item });
    else visibleTurnItems[index] = { ...visibleTurnItems[index], item };
    return { ...projection, visibleTurnItems };
  }
  if (type.startsWith('thread.') && typeof payload === 'object' && payload !== null && 'title' in payload) {
    return { ...projection, thread: payload as T3Projection['thread'] };
  }
  return projection;
}

/**
 * One item of T3's shell stream. A snapshot carrying `resolvedRepositoryIdentityRoots` is a refresh of some projects
 * with an empty thread list, not a new full list, so it only updates those projects.
 */
export function applyShellItem(state: Pick<T3State, 'threads' | 'projects'>, item: ShellItem): Pick<T3State, 'threads' | 'projects'> {
  const { threads, projects } = state;
  const withProject = (project: Project): Project[] => {
    const without = projects.filter((entry) => entry.id !== project.id);
    return project.archivedAt == null ? [...without, project] : without;
  };
  if (item.kind === 'snapshot') {
    const { snapshot, resolvedRepositoryIdentityRoots } = item as Extract<ShellItem, { kind: 'snapshot' }>;
    if (resolvedRepositoryIdentityRoots !== undefined) {
      let next = projects;
      for (const project of snapshot.projects) {
        const known = next.findIndex((entry) => entry.id === project.id);
        if (known !== -1) next = next.map((entry, index) => (index === known ? project : entry));
      }
      return { threads, projects: next };
    }
    return { threads: [...snapshot.threads], projects: snapshot.projects.filter((project) => project.archivedAt == null) };
  }
  if (item.kind === 'project.updated') return { threads, projects: withProject((item as Extract<ShellItem, { kind: 'project.updated' }>).project) };
  if (item.kind === 'project.removed') {
    const { projectId } = item as Extract<ShellItem, { kind: 'project.removed' }>;
    return { threads, projects: projects.filter((entry) => entry.id !== projectId) };
  }
  if (item.kind === 'thread.updated') {
    const { thread, location } = item as Extract<ShellItem, { kind: 'thread.updated' }>;
    const without = threads.filter((entry) => entry.id !== thread.id);
    return { threads: location === 'active' ? [thread, ...without] : without, projects };
  }
  if (item.kind === 'thread.removed') {
    const { threadId } = item as Extract<ShellItem, { kind: 'thread.removed' }>;
    return { threads: threads.filter((entry) => entry.id !== threadId), projects };
  }
  return state;
}

export class T3Client {
  private current: T3State = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly watches = new Map<string, Watch>();
  private session: T3Session | undefined;
  private socket: RpcSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): T3State => this.current;

  private set(patch: Partial<T3State>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Connects with the session this panel already holds, if any. */
  async start(): Promise<void> {
    this.session = await storedSession();
    if (this.session !== undefined) await this.connect();
  }

  async pair(): Promise<void> {
    this.stopped = false;
    this.session = await pairWithT3();
    await this.connect();
  }

  /** Drops this panel's session. The helper revokes it in T3 too. */
  async disconnect(revoke: () => Promise<unknown>): Promise<void> {
    this.stopped = true;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.socket?.close();
    this.socket = undefined;
    this.session = undefined;
    await forgetSession();
    await revoke().catch(() => undefined);
    this.current = EMPTY;
    for (const listener of this.listeners) listener();
  }

  private async connect(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    this.stopped = false;
    this.set({ status: 'connecting', origin: session.origin });
    delete this.current.error;
    try {
      const opened = await socketUrl(session);
      this.session = opened.session;
      let opening: RpcSocket | undefined;
      const socket = await RpcSocket.open(opened.url, () => {
        if (opening !== undefined) this.onClosed(opening);
      });
      opening = socket;
      this.socket = socket;
      await this.subscribeAll(socket);
      this.attempts = 0;
    } catch (error) {
      if (error instanceof SessionRefused && error.status === 401) {
        await forgetSession();
        this.session = undefined;
        this.current = { ...EMPTY, error: 'T3 ended this session. Connect again.' };
        for (const listener of this.listeners) listener();
        return;
      }
      this.set({ status: 'lost', error: errorText(error) });
      this.scheduleRetry();
    }
  }

  private onClosed(socket: RpcSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const watch of this.watches.values()) delete watch.stop;
    if (this.stopped) return;
    this.set({ status: 'lost', error: 'The connection to T3 Code was lost.' });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retry !== undefined) clearTimeout(this.retry);
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts, 5));
    this.attempts += 1;
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private async subscribeAll(socket: RpcSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let config = false;
      let shell = false;
      const ready = (): void => {
        if (config && shell) resolve();
      };
      socket.stream(
        'subscribeServerConfig',
        { environmentThemes: true },
        (value) => {
          this.onConfig(value as ConfigEvent);
          if ((value as ConfigEvent).type === 'snapshot') {
            config = true;
            ready();
          }
        },
        (error) => {
          if (error !== undefined) reject(error);
        },
      );
      socket.stream(
        'orchestration.subscribeShell',
        {},
        (value) => {
          this.onShell(value as ShellItem);
          if ((value as ShellItem).kind === 'snapshot') {
            shell = true;
            ready();
          }
        },
        (error) => {
          if (error !== undefined) reject(error);
        },
      );
    });
    const patch: Partial<T3State> = { status: 'ready' };
    this.set(patch);
    const { error: _cleared, ...rest } = this.current;
    this.current = rest;
    for (const listener of this.listeners) listener();
    for (const [id, watch] of this.watches) this.openWatch(id, watch);
  }

  private onConfig(event: ConfigEvent): void {
    if (event.type === 'snapshot') {
      const { config } = event as Extract<ConfigEvent, { type: 'snapshot' }>;
      this.set({
        providers: config.providers,
        defaultTheme: config.settings.defaultTheme ?? '',
        defaultAppearance: config.settings.defaultAppearance ?? '',
        threadStop: config.environment?.capabilities?.threadStop === true,
      });
    } else if (event.type === 'providerStatuses') {
      this.set({ providers: (event as Extract<ConfigEvent, { type: 'providerStatuses' }>).payload.providers });
    } else if (event.type === 'settingsUpdated') {
      const { settings } = (event as Extract<ConfigEvent, { type: 'settingsUpdated' }>).payload;
      this.set({ defaultTheme: settings.defaultTheme ?? '', defaultAppearance: settings.defaultAppearance ?? '' });
    } else if (event.type === 'environmentThemesUpdated') {
      this.set({ themes: [...(event as Extract<ConfigEvent, { type: 'environmentThemesUpdated' }>).payload.themes] });
    }
  }

  private onShell(item: ShellItem): void {
    this.set(applyShellItem(this.current, item));
  }

  /** Follows one thread until the returned function is called. */
  watchThread(id: string, listener: (view: ThreadView) => void): () => void {
    let watch = this.watches.get(id);
    if (watch === undefined) {
      watch = { listeners: new Set() };
      this.watches.set(id, watch);
    }
    watch.listeners.add(listener);
    if (watch.view !== undefined) listener(watch.view);
    if (watch.stop === undefined) this.openWatch(id, watch);
    const held = watch;
    return () => {
      held.listeners.delete(listener);
      if (held.listeners.size > 0) return;
      held.stop?.();
      this.watches.delete(id);
    };
  }

  private openWatch(id: string, watch: Watch): void {
    const socket = this.socket;
    if (socket === undefined) return;
    watch.stop?.();
    watch.stop = socket.stream('orchestration.subscribeThread', { threadId: id }, (value) => {
      const item = value as ThreadItem;
      if (item.kind === 'snapshot') watch.projection = (item as Extract<ThreadItem, { kind: 'snapshot' }>).projection;
      else if (item.kind === 'event' && watch.projection !== undefined) {
        watch.projection = applyThreadEvent(watch.projection, (item as Extract<ThreadItem, { kind: 'event' }>).event);
      } else return;
      if (watch.projection === undefined) return;
      watch.view = t3ThreadView(watch.projection);
      for (const listener of watch.listeners) listener(watch.view);
    });
  }

  private rpc<T>(tag: string, payload: unknown): Promise<T> {
    if (this.socket === undefined) return Promise.reject(new Error('T3 Code is not connected.'));
    return this.socket.request<T>(tag, payload);
  }

  async launchThread(input: { projectId: string; model: ModelSelection; runtimeMode: string; text: string }): Promise<string> {
    const title = input.text.split('\n')[0]?.trim().slice(0, 60) || 'New thread';
    const result = await this.rpc<{ threadId: string }>('orchestration.launchThread', {
      commandId: crypto.randomUUID(),
      creationSource: 'web',
      projectId: input.projectId,
      title,
      generateTitle: true,
      modelSelection: input.model,
      runtimeMode: input.runtimeMode,
      interactionMode: 'default',
      workspaceStrategy: { type: 'root' },
      initialMessage: { messageId: crypto.randomUUID(), text: input.text, attachments: [] },
    });
    return result.threadId;
  }

  async sendMessage(threadId: string, text: string, running: boolean): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', {
      type: 'message.dispatch',
      commandId: crypto.randomUUID(),
      createdBy: 'user',
      creationSource: 'web',
      threadId,
      messageId: crypto.randomUUID(),
      text,
      attachments: [],
      dispatchMode: running ? { type: 'queue_after_active' } : { type: 'start_immediately' },
    });
  }

  async respond(threadId: string, requestId: string, answer: { decision?: string; answers?: Record<string, unknown> }): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', {
      type: 'runtime-request.respond',
      commandId: crypto.randomUUID(),
      threadId,
      requestId,
      ...answer,
    });
  }

  async stop(threadId: string, runId: string | undefined): Promise<void> {
    if (this.current.threadStop) {
      await this.rpc('orchestration.dispatchCommand', { type: 'thread.stop', commandId: crypto.randomUUID(), threadId });
    } else if (runId !== undefined) {
      await this.rpc('orchestration.dispatchCommand', { type: 'run.interrupt', commandId: crypto.randomUUID(), threadId, runId, holdQueue: true });
    }
  }

  async setRuntimeMode(threadId: string, runtimeMode: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'thread.runtime-mode.set', commandId: crypto.randomUUID(), threadId, runtimeMode });
  }

  async createProject(workspaceRoot: string): Promise<string> {
    const projectId = crypto.randomUUID();
    const title = workspaceRoot.replace(/\/+$/, '').split('/').at(-1) || workspaceRoot;
    await this.rpc('projects.mutate', {
      type: 'project.create',
      commandId: crypto.randomUUID(),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
    });
    return projectId;
  }
}

export const t3 = new T3Client();
