import type { AgentImage } from '@t3-tab/protocol';
import { ArrowUp, Check, ChevronUp, FileText, Globe, Lock, Paperclip, PenLine, Search, ShieldCheck, ShieldOff, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import { MicButton, type Dictation } from './Dictation';
import { acceptFor, attachmentProblems, draftAttachment, fileBase64, transferFiles, type AttachmentTarget, type DraftAttachment } from './lib/attachments';
import { choiceLabel, isModelName, reasoningOption, RUNTIME_MODES, type Choice, type PickerProvider } from './lib/catalog';
import { compactModelName } from './lib/model-short-name';
import { t3, type ChatAttachment } from './lib/t3-client';
import { insertDictation } from './lib/voice';
import { ProviderIcon, useDismiss } from './ui';

export function ModelPicker({
  providers,
  choice,
  onChoice,
  access,
}: {
  providers: PickerProvider[];
  choice: Choice | undefined;
  onChoice: (choice: Choice) => void;
  /** T3 threads: the access level, in the footer. */
  access?: AccessControl | undefined;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState(choice?.provider);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  useEffect(() => {
    if (open) setRail(choice?.provider ?? providers[0]?.id);
  }, [open]);

  const label = choiceLabel(providers, choice);
  const provider = providers.find((entry) => entry.id === rail) ?? providers[0];
  const models = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (provider?.models ?? []).filter((model) => needle === '' || model.name.toLowerCase().includes(needle) || model.slug.toLowerCase().includes(needle));
  }, [provider, query]);
  const selected = provider?.models.find((model) => provider.id === choice?.provider && model.slug === choice.model);
  const reasoning = reasoningOption(selected);
  const reasoningValue = reasoning === undefined ? undefined : (choice?.options[reasoning.id] ?? reasoning.currentValue ?? reasoning.options?.find((option) => option.isDefault === true)?.id);
  const typed = query.trim();
  const canUseTyped = provider?.customModels === true && isModelName(typed) && !provider.models.some((model) => model.slug === typed);

  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        className="model-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={access === undefined ? undefined : `${label.name}${label.effort === undefined ? '' : ` · ${label.effort}`} · ${RUNTIME_MODES.find((mode) => mode.id === access.value)?.label ?? access.value}`}
        onClick={() => setOpen(!open)}
        disabled={providers.length === 0}
      >
        <ProviderIcon driver={label.driver} size={15} />
        <span className="model-chip-name">{label.name}</span>
        {label.effort === undefined ? null : <span className="model-chip-effort">{label.effort}</span>}
      </button>
      {open ? (
        <div className="popover model-popover" role="dialog" aria-label="Choose a model">
          <div className="model-body">
            {providers.length < 2 ? null : (
              <div className="model-rail" role="tablist" aria-label="Providers">
                {providers.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    role="tab"
                    aria-selected={entry.id === provider?.id}
                    aria-label={entry.name}
                    title={entry.unavailable === undefined ? entry.name : `${entry.name}: ${entry.unavailable}`}
                    className={entry.id === provider?.id ? 'rail-btn active' : 'rail-btn'}
                    onClick={() => setRail(entry.id)}
                  >
                    <ProviderIcon driver={entry.driver} name={entry.name} size={18} />
                  </button>
                ))}
              </div>
            )}
            <div className="model-main">
              <label className="model-search">
                <Search size={14} aria-hidden="true" />
                <input
                  autoFocus
                  placeholder={provider?.customModels === true ? 'Search or type a model…' : 'Search models…'}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || !canUseTyped || provider === undefined || models.length > 0) return;
                    event.preventDefault();
                    onChoice({ provider: provider.id, model: typed, options: {} });
                    setQuery('');
                    setOpen(false);
                  }}
                />
              </label>
              {provider?.unavailable === undefined ? null : <p className="model-note">{provider.unavailable}</p>}
              <div className="model-list">
                {models.map((model) => {
                  const active = provider?.id === choice?.provider && model.slug === choice?.model;
                  return (
                    <button
                      type="button"
                      key={model.slug || 'default'}
                      className={active ? 'model-row active' : 'model-row'}
                      title={model.name}
                      onClick={() => {
                        if (provider === undefined) return;
                        onChoice({ provider: provider.id, model: model.slug, options: active ? (choice?.options ?? {}) : {} });
                        if (reasoningOption(model) === undefined) setOpen(false);
                      }}
                    >
                      <ProviderIcon driver={provider?.driver} name={provider?.name} size={15} />
                      <span>{compactModelName(model, provider?.driver)}</span>
                      {active ? <Check size={14} className="row-check" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
                {canUseTyped ? (
                  <button
                    type="button"
                    className="model-row"
                    onClick={() => {
                      if (provider === undefined) return;
                      onChoice({ provider: provider.id, model: typed, options: {} });
                      setQuery('');
                      setOpen(false);
                    }}
                  >
                    <ProviderIcon driver={provider?.driver} name={provider?.name} size={15} />
                    <span className="project-name">Use “{typed}”</span>
                  </button>
                ) : null}
                {models.length === 0 && !canUseTyped ? <p className="model-note">No models match.</p> : null}
              </div>
            </div>
          </div>
          {reasoning?.options === undefined || choice === undefined ? null : (
            <div className="model-reasoning">
              <span className="model-reasoning-label">{reasoning.label || 'Reasoning'}</span>
              <div className="segmented" role="radiogroup" aria-label={reasoning.label || 'Reasoning'}>
                {reasoning.options.map((option) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={option.id === reasoningValue}
                    key={option.id}
                    className={option.id === reasoningValue ? 'active' : ''}
                    onClick={() => onChoice({ ...choice, options: { ...choice.options, [reasoning.id]: option.id } })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {access === undefined ? null : (
            <div className="model-footer">
              <AccessMenu {...access} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

const MODE_ICONS: Record<string, typeof ShieldCheck> = { 'approval-required': Lock, 'auto-accept-edits': PenLine, auto: ShieldCheck, 'full-access': ShieldOff };

export interface AccessControl {
  value: string;
  modes?: string[] | undefined;
  onChange: (mode: string) => void;
}

/** The access level, in the model picker's footer as T3 Code has it: a small menu that opens upward. */
function AccessMenu({ value, modes, onChange }: AccessControl): ReactNode {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const options = RUNTIME_MODES.filter((mode) => modes === undefined || modes.includes(mode.id));
  const current = RUNTIME_MODES.find((mode) => mode.id === value);
  const ModeIcon = MODE_ICONS[value] ?? ShieldCheck;
  return (
    <div className="access" ref={box}>
      <button type="button" className="access-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Access: ${current?.label ?? value}`} onClick={() => setOpen(!open)}>
        <ModeIcon size={13} aria-hidden="true" />
        {current?.label ?? value}
        <ChevronUp size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="popover access-popover" role="menu" aria-label="Access">
          {options.map((mode) => {
            const Icon = MODE_ICONS[mode.id] ?? ShieldCheck;
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={mode.id === value}
                key={mode.id}
                className="menu-row"
                onClick={() => {
                  onChange(mode.id);
                  setOpen(false);
                }}
              >
                <Icon size={14} className="menu-icon" aria-hidden="true" />
                <span>
                  <strong>{mode.label}</strong>
                  <small>{mode.hint}</small>
                </span>
                {mode.id === value ? <Check size={14} className="row-check" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** The chip of a running T3 thread: its model is fixed, and the popover holds the access level. */
export function ThreadModelPicker({ name, effort, driver, access }: { name: string; effort?: string | undefined; driver?: string | undefined; access?: AccessControl | undefined }): ReactNode {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const mode = RUNTIME_MODES.find((entry) => entry.id === access?.value)?.label;
  const chip = (
    <>
      <ProviderIcon driver={driver} size={15} />
      <span className="model-chip-name">{name}</span>
      {effort === undefined ? null : <span className="model-chip-effort">{effort}</span>}
    </>
  );
  if (access === undefined) return <span className="model-chip static">{chip}</span>;
  return (
    <div className="picker" ref={box}>
      <button type="button" className="model-chip" aria-haspopup="dialog" aria-expanded={open} title={`${name}${effort === undefined ? '' : ` · ${effort}`}${mode === undefined ? '' : ` · ${mode}`}`} onClick={() => setOpen(!open)}>
        {chip}
      </button>
      {open ? (
        <div className="popover model-popover" role="dialog" aria-label="This thread's model and access">
          <div className="model-fixed">
            <ProviderIcon driver={driver} size={15} />
            <span className="model-chip-name">{name}</span>
            {effort === undefined ? null : <span className="model-chip-effort">{effort}</span>}
            <small>This thread keeps its model</small>
          </div>
          <div className="model-footer">
            <AccessMenu {...access} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A tab the thread holds, or what the next message would share (a whole group when the owner made one). */
export function TabChip({
  title,
  state,
  onToggle,
  removeLabel,
  tabs,
  group,
  nextMessage,
}: {
  title: string;
  state: 'held' | 'pending' | 'off';
  onToggle: () => void;
  removeLabel?: string;
  /** Every tab that goes with it, when that is more than one. */
  tabs?: readonly { title: string }[] | undefined;
  group?: string | undefined;
  /** In a running conversation: say that it goes with the next message, unlike the tabs already shared. */
  nextMessage?: boolean;
}): ReactNode {
  const count = tabs?.length ?? 1;
  const noun = count > 1 ? `these ${count} tabs` : 'this tab';
  if (state === 'off') {
    return (
      <button type="button" className="tab-chip off" onClick={onToggle} title={`Share ${noun} when you send`}>
        <Globe size={12} aria-hidden="true" />
        <span>{count > 1 ? `Share ${count} tabs` : 'Share this tab'}</span>
      </button>
    );
  }
  const name = count > 1 ? `${group ?? 'Tab group'} · ${count} tabs` : title || 'Current tab';
  const hint = state === 'held' ? `"${title}" is shared with this thread` : count > 1 ? `Shared when you send:\n${(tabs ?? []).map((tab) => tab.title || 'Untitled').join('\n')}` : `"${title}" is shared when you send`;
  return (
    <span className={state === 'pending' && nextMessage === true ? 'tab-chip pending' : 'tab-chip'} title={hint}>
      <Globe size={12} aria-hidden="true" />
      <span className="tab-chip-title">{name}</span>
      {state === 'pending' && nextMessage === true ? <small>next message</small> : null}
      <button type="button" aria-label={removeLabel ?? (count > 1 ? "Don't share these tabs" : "Don't share this tab")} onClick={onToggle}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

/** An attached file: a thumbnail for an image, a file icon otherwise, and its name; marked when it cannot be sent. */
function AttachmentChip({ attachment, problem, onRemove }: { attachment: DraftAttachment; problem?: string | undefined; onRemove: () => void }): ReactNode {
  return (
    <span className={problem === undefined ? 'file-chip' : 'file-chip problem'} title={problem ?? attachment.name}>
      {attachment.preview === undefined ? <FileText size={13} aria-hidden="true" /> : <img src={attachment.preview} alt="" />}
      <span className="file-chip-name">{attachment.name}</span>
      <button type="button" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

export interface ComposerAttachments {
  items: readonly DraftAttachment[];
  /** Why an attachment cannot go with this message, by key. */
  problems: ReadonlyMap<string, string>;
  /** What the file chooser offers. */
  accept?: string | undefined;
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  canQueue,
  busy,
  placeholder,
  chip,
  picker,
  autoFocus,
  attachments,
  dictation,
  notice,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: (() => void) | undefined;
  running: boolean;
  /** While it runs, a message waits for the turn to end. Without this it cannot be sent until then. */
  canQueue?: boolean;
  busy?: boolean;
  placeholder: string;
  chip?: ReactNode;
  picker: ReactNode;
  autoFocus?: boolean;
  attachments?: ComposerAttachments | undefined;
  dictation?: Dictation | undefined;
  /** A line above the box: why an attachment cannot go, or what the mic needs. */
  notice?: string | undefined;
}): ReactNode {
  const input = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);
  const problems = attachments?.problems.size ?? 0;
  const canSend = value.trim() !== '' && busy !== true && problems === 0 && dictation?.phase !== 'finishing';
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (attachments === undefined) return;
    const files = transferFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachments.onAdd(files);
  };
  const hasFiles = (event: DragEvent): boolean => attachments !== undefined && [...event.dataTransfer.types].includes('Files');
  const chips = chip !== undefined && chip !== null;
  const firstProblem = attachments?.items.map((item) => attachments.problems.get(item.key)).find((problem) => problem !== undefined);
  const shownNotice = firstProblem === undefined ? notice : `${firstProblem} Remove it to send.`;
  return (
    <>
      {shownNotice === undefined ? null : (
        <p className={firstProblem === undefined ? 'composer-notice' : 'composer-notice problem'} role="status">
          {shownNotice}
        </p>
      )}
      <form
        className={dragging ? 'composer dragging' : 'composer'}
        data-chat-composer-form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSend();
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          attachments?.onAdd(transferFiles(event.dataTransfer));
        }}
      >
        {chips || (attachments?.items.length ?? 0) > 0 ? (
          <div className="composer-chips">
            {chip}
            {attachments?.items.map((item) => <AttachmentChip key={item.key} attachment={item} problem={attachments.problems.get(item.key)} onRemove={() => attachments.onRemove(item.key)} />)}
          </div>
        ) : null}
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label="Message"
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-row">
          {attachments === undefined ? null : (
            <>
              <button type="button" className="composer-icon" aria-label="Attach files" title="Attach files" onClick={() => chooser.current?.click()}>
                <Paperclip size={16} aria-hidden="true" />
              </button>
              <input
                ref={chooser}
                type="file"
                multiple
                hidden
                {...(attachments.accept === undefined ? {} : { accept: attachments.accept })}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length > 0) attachments.onAdd(files);
                }}
              />
            </>
          )}
          <span className="composer-spacer" />
          {picker}
          {dictation === undefined ? null : <MicButton dictation={dictation} />}
          {running && onStop !== undefined ? (
            <button type="button" className="send-btn stop" aria-label="Stop" title="Stop" onClick={onStop}>
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          ) : null}
          {!running || onStop === undefined || (canQueue === true && value.trim() !== '') ? (
            <button type="submit" className="send-btn" aria-label={running ? 'Queue message' : 'Send'} title={running ? 'Queue for when this turn ends' : undefined} disabled={!canSend}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </form>
    </>
  );
}

/** Puts dictated text into a draft at the textarea's caret. */
export function dictateInto(value: string, text: string): string {
  const element = document.querySelector<HTMLTextAreaElement>('.composer-input');
  const caret = element !== null && document.activeElement === element ? element.selectionStart : value.length;
  return insertDictation(value, text, caret).value;
}

/** The composer's attached files for one draft, checked against what the agent it goes to can take. */
export function useComposerAttachments(target: AttachmentTarget): ComposerAttachments & { clear: () => void; forT3: () => Promise<ChatAttachment[]>; forDirect: () => Promise<AgentImage[]> } {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const held = previews.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
    };
  }, []);
  const drop = (removed: readonly DraftAttachment[]): void => {
    for (const item of removed) {
      if (item.preview === undefined) continue;
      URL.revokeObjectURL(item.preview);
      previews.current.delete(item.preview);
    }
  };
  const problems = useMemo(() => attachmentProblems(items, target), [items, target.kind, target.kind === 'direct' ? target.agent : '']);
  return {
    items,
    problems,
    accept: acceptFor(target),
    onAdd: (files) => {
      const added = files.map((file) => {
        const item = draftAttachment(file, crypto.randomUUID());
        if (item.mimeType.startsWith('image/') && item.size <= 20 * 1024 * 1024) {
          item.preview = URL.createObjectURL(file);
          previews.current.add(item.preview);
        }
        return item;
      });
      setItems((current) => [...current, ...added]);
    },
    onRemove: (key) =>
      setItems((current) => {
        drop(current.filter((item) => item.key === key));
        return current.filter((item) => item.key !== key);
      }),
    clear: () =>
      setItems((current) => {
        drop(current);
        return [];
      }),
    /** Uploads each file to T3, as its own composer does before sending; a failure takes back what was uploaded. */
    forT3: async () => {
      const uploaded: ChatAttachment[] = [];
      try {
        for (const item of items) uploaded.push(await t3.uploadAttachment(item));
      } catch (error) {
        for (const done of uploaded) await t3.discardAttachment(done.id);
        throw error;
      }
      return uploaded;
    },
    forDirect: async () => await Promise.all(items.map(async (item) => ({ name: item.name, mimeType: item.mimeType, data: await fileBase64(item.file) }))),
  };
}
