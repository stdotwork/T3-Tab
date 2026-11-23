import { ArrowUp, Check, ChevronDown, Globe, Search, ShieldCheck, ShieldOff, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { choiceLabel, reasoningOption, RUNTIME_MODES, type Choice, type PickerProvider } from './lib/catalog';
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
  const reasoningValue = reasoning === undefined ? undefined : (choice?.options[reasoning.id] ?? reasoning.options?.find((option) => option.isDefault === true)?.id);

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
                  <ProviderIcon driver={entry.driver} size={18} />
                </button>
              ))}
            </div>
            <div className="model-main">
              <label className="model-search">
                <Search size={14} aria-hidden="true" />
                <input autoFocus placeholder="Search models…" value={query} onChange={(event) => setQuery(event.target.value)} />
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
                      onClick={() => {
                        if (provider === undefined) return;
                        onChoice({ provider: provider.id, model: model.slug, options: active ? (choice?.options ?? {}) : {} });
                        if (reasoningOption(model) === undefined) setOpen(false);
                      }}
                    >
                      <ProviderIcon driver={provider?.driver} size={15} />
                      <span>{model.name}</span>
                      {active ? <Check size={14} className="row-check" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
                {models.length === 0 ? <p className="model-note">No models match.</p> : null}
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

export function TabChip({ title, shared, onToggle }: { title: string; shared: boolean; onToggle: () => void }): ReactNode {
  if (!shared) {
    return (
      <button type="button" className="tab-chip off" onClick={onToggle} title="Share this tab when you send">
        <Globe size={12} aria-hidden="true" />
        <span>Share this tab</span>
      </button>
    );
  }
  return (
    <span className="tab-chip" title={`"${title}" is shared when you send`}>
      <Globe size={12} aria-hidden="true" />
      <span className="tab-chip-title">{title || 'Current tab'}</span>
      <button type="button" aria-label="Don't share this tab" onClick={onToggle}>
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
        {running && value.trim() === '' && onStop !== undefined ? (
          <button type="button" className="send-btn stop" aria-label="Stop" onClick={onStop}>
            <Square size={12} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="send-btn" aria-label="Send" disabled={!canSend}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}
