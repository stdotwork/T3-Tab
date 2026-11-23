import { ArrowUp, Check, ChevronDown, Globe, Search, ShieldCheck, ShieldOff, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { choiceLabel, isModelName, reasoningOption, RUNTIME_MODES, type Choice, type PickerProvider } from './lib/catalog';
import { compactModelName } from './lib/model-short-name';
import { ProviderIcon, useDismiss } from './ui';

export function ModelPicker({
  providers,
  choice,
  onChoice,
}: {
  providers: PickerProvider[];
  choice: Choice | undefined;
  onChoice: (choice: Choice) => void;
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
      <button type="button" className="model-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} disabled={providers.length === 0}>
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
        </div>
      ) : null}
    </div>
  );
}

export function RuntimeMenu({ value, modes, onChange }: { value: string; modes?: string[] | undefined; onChange: (mode: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const options = RUNTIME_MODES.filter((mode) => modes === undefined || modes.includes(mode.id));
  const current = RUNTIME_MODES.find((mode) => mode.id === value);
  const ModeIcon = value === 'full-access' ? ShieldOff : ShieldCheck;
  return (
    <div className="picker runtime" ref={box}>
      <button type="button" className="runtime-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ModeIcon size={13} aria-hidden="true" />
        {current?.label ?? value}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="popover runtime-popover" role="menu">
          {options.map((mode) => (
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
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.hint}</small>
              </span>
              {mode.id === value ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
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
}): ReactNode {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);
  const canSend = value.trim() !== '' && busy !== true;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };
  return (
    <form
      className="composer"
      data-chat-composer-form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {chip === undefined || chip === null ? null : <div className="composer-chips">{chip}</div>}
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
      />
      <div className="composer-row">
        {picker}
        <span className="composer-spacer" />
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
  );
}
