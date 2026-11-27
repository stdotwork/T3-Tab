/** The panel's live connection to T3 Code: providers, projects, the thread list and the threads being watched. */
import type { T3VoiceStatus } from '@t3-tab/protocol';

import { errorText } from './api';
import { t3Kind, type DraftAttachment } from './attachments';
import { DEFAULT_SNOOZE_PRESETS, snoozePresets, type SnoozePreset } from './snooze';
import { RpcSocket } from './t3-rpc';
import { forgetSession, pairWithT3, SessionRefused, socketUrl, storedSession, voiceSocketUrl, voiceStatus, type T3Session } from './t3-session';
import { omittedBrowserReplies, t3ThreadView, toolOutputText, type T3Projection, type ThreadView } from './thread-model';
import { fetchTurnReplies, TurnReplies } from './turn-replies';

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

/**
 * One thread of T3's shell stream (`OrchestrationV2ThreadShell`). The stream sends every field; these are the ones the
 * panel reads. Fields newer T3 servers added are optional, as in T3's own schema.
 */
export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  status?: string;
  runtimeMode?: string;
  interactionMode?: string;
  modelSelection?: ModelSelection;
  providerInstanceId?: string;
  creationSource?: string;
  createdAt?: string;
  updatedAt?: string;
  latestUserMessageAt?: string | null;
  latestUserAuthoredMessageAt?: string | null;
  pendingRuntimeRequest?: { id: string; kind: string; createdAt?: string; blocking?: boolean; userOnly?: boolean } | null;
  pendingGuestMessageCount?: number;
  pendingBackgroundTasks?: Array<{ taskId?: string; kind: string; awaited?: boolean }>;
  hasActionableProposedPlan?: boolean;
  latestRunId?: string | null;
  latestRunRequestedAt?: string | null;
  latestRunStartedAt?: string | null;
  latestRunCompletedAt?: string | null;
  activeRunId?: string | null;
  activityRunStatus?: string | null;
  blockedOnThreadWait?: boolean;
  lastErrorClass?: string | null;
  lineage?: { relationshipToParent?: string | null; parentThreadId?: string | null; sideChat?: boolean; workflowStep?: boolean };
  delegatedFrom?: { environmentId?: string; threadId: string };
  archivedAt?: string | null;
  deletedAt?: string | null;
  /** `settled` when the owner or T3's auto-settle settled it; `active` when the owner took it back out. */
  settledOverride?: 'settled' | 'active' | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
  lastVisitedAt?: string | null;
}

export type T3Status = 'off' | 'connecting' | 'ready' | 'lost';

/** One attachment of a message, as T3's `ChatAttachment` takes it after the file was uploaded. */
export interface ChatAttachment {
  type: 'image' | 'file';
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** The owner's speech settings in T3, which go with every recording as T3's own composer sends them. */
export interface SpeechOptions {
  speechLanguage: string;
  speechTranslateToEnglish: boolean;
  speechCustomWords: Array<{ term: string; aliases: string[] }>;
  speechRemoveFillerWords: boolean;
  speechSilenceFiltering: boolean;
}

type ServerSettings = { snoozePresets?: unknown } & Partial<SpeechOptions>;

export const DEFAULT_SPEECH: SpeechOptions = {
  speechLanguage: 'auto',
  speechTranslateToEnglish: false,
  speechCustomWords: [],
  speechRemoveFillerWords: true,
  speechSilenceFiltering: true,
};

/** T3's speech settings from its server settings, each falling back to T3's own default. */
export function speechOptions(settings: Partial<SpeechOptions>): SpeechOptions {
  return {
    speechLanguage: typeof settings.speechLanguage === 'string' && settings.speechLanguage.length >= 2 ? settings.speechLanguage : DEFAULT_SPEECH.speechLanguage,
    speechTranslateToEnglish: settings.speechTranslateToEnglish === true,
    speechCustomWords: Array.isArray(settings.speechCustomWords) ? settings.speechCustomWords : [],
    speechRemoveFillerWords: settings.speechRemoveFillerWords !== false,
    speechSilenceFiltering: settings.speechSilenceFiltering !== false,
  };
}

const UPLOAD_PATH = /^\/api\/attachments\/upload\/[A-Za-z0-9_.-]+$/;

export interface T3State {
  status: T3Status;
  error?: string;
  origin?: string;
  providers: Provider[];
  projects: Project[];
  threads: ThreadShell[];
  threadStop: boolean;
  /** The folder of T3's Scratch project, which is what "no project" runs in. Unset when this T3 offers none. */
  scratchRoot?: string;
  /** T3 can transcribe speech on this machine (its `voiceTranscription` capability). */
  voice: boolean;
  speech: SpeechOptions;
  /** The snooze menu's presets: the owner's own from T3's settings, else T3's defaults. */
  snoozePresets: readonly SnoozePreset[];
}

type ConfigEvent =
  | { type: 'snapshot'; config: { providers: Provider[]; scratchWorkspaceRoot?: string; settings: ServerSettings; environment?: { capabilities?: { threadStop?: boolean; voiceTranscription?: boolean } } } }
  | { type: 'providerStatuses'; payload: { providers: Provider[] } }
  | { type: 'settingsUpdated'; payload: { settings: ServerSettings } }
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
  /** Browser replies T3 left out of the stream, shared with the client's `TurnReplies`; null when there was none to have. */
  replies?: Map<string, string | null>;
  fetching?: boolean;
  view?: ThreadView;
  stop?: () => void;
  listeners: Set<(view: ThreadView) => void>;
}

const EMPTY: T3State = { status: 'off', providers: [], projects: [], threads: [], threadStop: false, voice: false, speech: DEFAULT_SPEECH, snoozePresets: DEFAULT_SNOOZE_PRESETS };

const SUBSCRIBE_TIMEOUT_MS = 15_000;

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
  if (type === 'message.updated') {
    return { ...projection, messages: upsert(projection.messages ?? [], payload as NonNullable<T3Projection['messages']>[number]) };
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
  private readonly replies = new TurnReplies();
  private session: T3Session | undefined;
  private socket: RpcSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = false;
  /** Bumped when the session changes, so whatever an older connection attempt finishes with is ignored. */
  private generation = 0;
  private connecting: Promise<void> | undefined;

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
    const session = await pairWithT3();
    this.stopped = false;
    this.supersede();
    this.session = session;
    await this.connect();
  }

  /** Drops this panel's session. The helper revokes it in T3 too. */
  async disconnect(revoke: () => Promise<unknown>): Promise<void> {
    this.stopped = true;
    this.supersede();
    this.session = undefined;
    await forgetSession();
    await revoke().catch(() => undefined);
    this.current = EMPTY;
    for (const listener of this.listeners) listener();
  }

  /** Ends the current socket and any attempt in flight; neither can change the state after this. */
  private supersede(): void {
    this.generation += 1;
    this.connecting = undefined;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = undefined;
    for (const watch of this.watches.values()) delete watch.stop;
    socket?.close();
  }

  /** One attempt at a time: a caller during an attempt shares it. */
  private connect(): Promise<void> {
    if (this.connecting !== undefined) return this.connecting;
    const attempt: Promise<void> = this.openConnection(this.generation).finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    });
    this.connecting = attempt;
    return attempt;
  }

  private async openConnection(generation: number): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    const superseded = (): boolean => generation !== this.generation;
    const { error: _cleared, ...rest } = this.current;
    this.current = { ...rest, status: 'connecting', origin: session.origin };
    for (const listener of this.listeners) listener();
    let socket: RpcSocket | undefined;
    try {
      const opened = await socketUrl(session);
      if (superseded()) return;
      this.session = opened.session;
      socket = await RpcSocket.open(opened.url, () => {
        if (socket !== undefined) this.onClosed(socket);
      });
      if (superseded()) {
        socket.close();
        return;
      }
      this.socket = socket;
      await this.subscribeAll(socket);
      this.attempts = 0;
    } catch (error) {
      // A later attempt owns the state now, or this socket's close already scheduled the retry.
      if (superseded() || (socket !== undefined && this.socket !== socket)) {
        socket?.close();
        return;
      }
      if (socket !== undefined) {
        this.socket = undefined;
        socket.close();
      }
      if (error instanceof SessionRefused && error.status === 401) {
        this.generation += 1;
        await forgetSession();
        this.session = undefined;
        this.current = { ...EMPTY, error: error.message };
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
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect();
    }, delay);
  }

  private async subscribeAll(socket: RpcSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let config = false;
      let shell = false;
      const timer = setTimeout(() => reject(new Error('T3 Code did not answer.')), SUBSCRIBE_TIMEOUT_MS);
      const ready = (): void => {
        if (!config || !shell) return;
        clearTimeout(timer);
        resolve();
      };
      const ended = (error?: Error): void => {
        clearTimeout(timer);
        reject(error ?? new Error('T3 Code ended the connection.'));
      };
      socket.stream(
        'subscribeServerConfig',
        {},
        (value) => {
          if (this.socket !== socket) return;
          this.onConfig(value as ConfigEvent);
          if ((value as ConfigEvent).type === 'snapshot') {
            config = true;
            ready();
          }
        },
        ended,
      );
      socket.stream(
        'orchestration.subscribeShell',
        {},
        (value) => {
          if (this.socket !== socket) return;
          this.onShell(value as ShellItem);
          if ((value as ShellItem).kind === 'snapshot') {
            shell = true;
            ready();
          }
        },
        ended,
      );
    });
    if (this.socket !== socket) return;
    const { error: _cleared, ...rest } = this.current;
    this.current = { ...rest, status: 'ready' };
    for (const listener of this.listeners) listener();
    for (const [id, watch] of this.watches) this.openWatch(id, watch);
  }

  private onConfig(event: ConfigEvent): void {
    if (event.type === 'snapshot') {
      const { config } = event as Extract<ConfigEvent, { type: 'snapshot' }>;
      this.set({
        providers: config.providers,
        threadStop: config.environment?.capabilities?.threadStop === true,
        voice: config.environment?.capabilities?.voiceTranscription === true,
        speech: speechOptions(config.settings),
        snoozePresets: snoozePresets(config.settings.snoozePresets),
        ...(config.scratchWorkspaceRoot === undefined ? {} : { scratchRoot: config.scratchWorkspaceRoot }),
      });
    } else if (event.type === 'providerStatuses') {
      this.set({ providers: (event as Extract<ConfigEvent, { type: 'providerStatuses' }>).payload.providers });
    } else if (event.type === 'settingsUpdated') {
      const { settings } = (event as Extract<ConfigEvent, { type: 'settingsUpdated' }>).payload;
      this.set({ speech: speechOptions(settings), snoozePresets: snoozePresets(settings.snoozePresets) });
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
      if (this.socket !== socket) return;
      const item = value as ThreadItem;
      if (item.kind === 'snapshot') watch.projection = (item as Extract<ThreadItem, { kind: 'snapshot' }>).projection;
      else if (item.kind === 'event' && watch.projection !== undefined) {
        watch.projection = applyThreadEvent(watch.projection, (item as Extract<ThreadItem, { kind: 'event' }>).event);
      } else return;
      if (watch.projection === undefined) return;
      watch.replies = this.replies.for(id);
      watch.view = t3ThreadView(watch.projection, watch.replies);
      for (const listener of watch.listeners) listener(watch.view);
      void this.fetchReplies(id, watch, socket);
    });
  }

  /**
   * Fetches the replies of the thread's finished browser steps that T3 left out of the stream, as T3's own client fetches a
   * step's detail (`fetchTurnReplies`), and draws the thread again once they are in. Steps fetched before, in this panel,
   * are not fetched again.
   */
  private async fetchReplies(id: string, watch: Watch, socket: NonNullable<typeof this.socket>): Promise<void> {
    const replies = watch.replies;
    if (watch.projection === undefined || replies === undefined || watch.fetching === true) return;
    watch.fetching = true;
    try {
      for (;;) {
        const wanted = watch.projection === undefined ? [] : omittedBrowserReplies(watch.projection, replies);
        if (wanted.length === 0 || this.socket !== socket || this.watches.get(id) !== watch) return;
        // A step not given in time keeps the words it has.
        await fetchTurnReplies(
          wanted,
          async (itemId) => toolOutputText((await socket.request<{ item: { output?: unknown } | null }>('orchestration.getTurnItem', { threadId: id, itemId })).item?.output) ?? null,
          replies,
          { stillWanted: () => this.socket === socket && this.watches.get(id) === watch },
        );
        if (watch.projection === undefined || this.socket !== socket || this.watches.get(id) !== watch) return;
        watch.view = t3ThreadView(watch.projection, replies);
        for (const listener of watch.listeners) listener(watch.view);
      }
    } finally {
      watch.fetching = false;
    }
  }

  private rpc<T>(tag: string, payload: unknown): Promise<T> {
    if (this.socket === undefined) return Promise.reject(new Error('T3 Code is not connected.'));
    return this.socket.request<T>(tag, payload);
  }

  /**
   * Uploads one file the way T3's composer does: T3 signs a one-use upload address over the RPC socket, and the bytes go
   * to that address, which is the only credential the upload carries. The id it returns goes in a message's attachments.
   */
  async uploadAttachment(attachment: DraftAttachment): Promise<ChatAttachment> {
    const session = this.session;
    if (session === undefined) throw new Error('T3 Code is not connected.');
    const type = t3Kind(attachment);
    const { attachmentId, relativeUrl } = await this.rpc<{ attachmentId: string; relativeUrl: string }>('attachments.createUploadUrl', {
      type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.size,
    });
    if (typeof attachmentId !== 'string' || typeof relativeUrl !== 'string' || !UPLOAD_PATH.test(relativeUrl)) throw new Error('T3 sent no upload address.');
    const uploaded = await fetch(`${session.origin}${relativeUrl}`, {
      method: 'POST',
      headers: { 'content-type': attachment.mimeType },
      body: attachment.file,
      redirect: 'error',
      credentials: 'omit',
    }).catch(() => undefined);
    if (uploaded?.ok !== true) {
      await this.discardAttachment(attachmentId);
      throw new Error(`T3 Code did not take ${attachment.name}${uploaded === undefined ? '' : ` (HTTP ${uploaded.status})`}.`);
    }
    return { type, id: attachmentId, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.size };
  }

  /** Lets T3 delete an upload no message used. */
  async discardAttachment(attachmentId: string): Promise<void> {
    await this.rpc('attachments.delete', { attachmentId }).catch(() => undefined);
  }

  /** Whether T3 can transcribe speech now. */
  async voiceStatus(): Promise<T3VoiceStatus> {
    if (this.session === undefined) throw new Error('T3 Code is not connected.');
    const { voice, session } = await voiceStatus(this.session);
    this.session = session;
    return voice;
  }

  /** A one-use address for T3's voice socket. */
  async voiceSocket(): Promise<string> {
    if (this.session === undefined) throw new Error('T3 Code is not connected.');
    const { url, session } = await voiceSocketUrl(this.session);
    this.session = session;
    return url;
  }

  async launchThread(input: { projectId: string; model: ModelSelection; runtimeMode: string; text: string; attachments?: ChatAttachment[] }): Promise<string> {
    const title = input.text.split('\n')[0]?.trim().slice(0, 60) || 'New thread';
    const attachments = input.attachments ?? [];
    const result = await this.rpc<{ threadId: string }>('orchestration.launchThread', {
      commandId: crypto.randomUUID(),
      // T3 files uploaded attachments under the thread, so it needs the thread's id up front.
      ...(attachments.length === 0 ? {} : { threadId: crypto.randomUUID() }),
      creationSource: 'web',
      projectId: input.projectId,
      title,
      generateTitle: true,
      modelSelection: input.model,
      runtimeMode: input.runtimeMode,
      interactionMode: 'default',
      workspaceStrategy: { type: 'root' },
      initialMessage: { messageId: crypto.randomUUID(), text: input.text, attachments },
    });
    return result.threadId;
  }

  async sendMessage(threadId: string, text: string, running: boolean, attachments: ChatAttachment[] = []): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', {
      type: 'message.dispatch',
      commandId: crypto.randomUUID(),
      createdBy: 'user',
      creationSource: 'web',
      threadId,
      messageId: crypto.randomUUID(),
      text,
      attachments,
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

  /** Takes a queued follow-up back before it runs. */
  async cancelQueued(threadId: string, runId: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'queued-run.cancel', commandId: crypto.randomUUID(), threadId, runId });
  }

  /** Starts a follow-up T3 is holding, which it does after a Stop until someone says go. */
  async startQueued(threadId: string, runId: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'queued-run.start', commandId: crypto.randomUUID(), threadId, runId });
  }

  async setRuntimeMode(threadId: string, runtimeMode: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'thread.runtime-mode.set', commandId: crypto.randomUUID(), threadId, runtimeMode });
  }

  /** Settles a thread, as T3's sidebar Settle does: it leaves the list for the Settled shelf. */
  async settle(threadId: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'thread.settle', commandId: crypto.randomUUID(), threadId });
  }

  async unsettle(threadId: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'thread.unsettle', commandId: crypto.randomUUID(), threadId, reason: 'user' });
  }

  /** Snoozes a thread until a time from the snooze menu; it comes back to the list then. */
  async snooze(threadId: string, snoozedUntil: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'thread.snooze', commandId: crypto.randomUUID(), threadId, snoozedUntil });
  }

  /** Wakes a snoozed thread now. */
  async unsnooze(threadId: string): Promise<void> {
    await this.rpc('orchestration.dispatchCommand', { type: 'thread.unsnooze', commandId: crypto.randomUUID(), threadId, reason: 'user' });
  }

  /** Finds or creates T3's Scratch project, where a thread with no project runs. */
  async ensureScratchProject(): Promise<string> {
    return (await this.rpc<{ projectId: string }>('projects.ensureScratch', {})).projectId;
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
