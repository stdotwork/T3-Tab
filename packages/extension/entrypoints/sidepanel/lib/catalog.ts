/** What the pickers offer: T3's providers and models when T3 is connected, otherwise the agents on this machine. */
import { compactModelName } from './model-short-name';
import type { ModelOption, ModelSelection, Provider, T3State } from './t3-client';

export interface PickerModel {
  slug: string;
  name: string;
  shortName?: string;
  options: ModelOption[];
  isDefault?: boolean;
}

export interface PickerProvider {
  id: string;
  name: string;
  driver: string;
  models: PickerModel[];
  runtimeModes?: string[];
  unavailable?: string;
  /** The CLI takes any model name, so the picker lets the owner type one. */
  customModels?: boolean;
}

export interface SetupAgent {
  id: 'claude' | 'codex';
  found: boolean;
  registered: boolean;
}

export interface Choice {
  provider: string;
  model: string;
  options: Record<string, string | boolean>;
}

export const RUNTIME_MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'approval-required', label: 'Supervised', hint: 'Ask before commands and edits' },
  { id: 'auto-accept-edits', label: 'Auto-accept edits', hint: 'Ask before commands' },
  { id: 'auto', label: 'Auto', hint: 'Let the provider decide when to ask' },
  { id: 'full-access', label: 'Full access', hint: 'Never ask, browser requests included' },
];

const providerName = (provider: Provider): string => {
  if (provider.displayName !== undefined && provider.displayName !== '') return provider.displayName;
  if (provider.driver === 'claudeAgent') return 'Claude';
  if (provider.driver === 'codex') return 'Codex';
  return provider.instanceId;
};

export function t3Providers(state: T3State): PickerProvider[] {
  return state.providers
    .filter((provider) => provider.enabled && provider.installed && provider.models.length > 0)
    .map((provider) => {
      const entry: PickerProvider = {
        id: provider.instanceId,
        name: providerName(provider),
        driver: provider.driver,
        models: provider.models
          .filter((model) => model.isLegacy !== true)
          .map((model) => ({
            slug: model.slug,
            name: model.name,
            ...(model.shortName === undefined ? {} : { shortName: model.shortName }),
            ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
            options: model.capabilities?.optionDescriptors ?? [],
          })),
      };
      if (provider.supportedRuntimeModes !== undefined) entry.runtimeModes = provider.supportedRuntimeModes;
      if (provider.status === 'error') entry.unavailable = provider.unavailableReason ?? 'Not signed in';
      return entry;
    });
}

const DIRECT_CLAUDE: PickerModel[] = [
  { slug: '', name: 'Default model', shortName: 'Default', options: [], isDefault: true },
  { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', shortName: 'Opus 5.5', options: [] },
  { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', shortName: 'Sonnet 5.5', options: [] },
  { slug: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', shortName: 'Haiku 5.5', options: [] },
];

export function directProviders(agents: readonly SetupAgent[]): PickerProvider[] {
  const providers: PickerProvider[] = [];
  if (agents.some((agent) => agent.id === 'claude' && agent.found)) {
    providers.push({ id: 'claude', name: 'Claude Code', driver: 'claudeAgent', models: DIRECT_CLAUDE, customModels: true });
  }
  if (agents.some((agent) => agent.id === 'codex' && agent.found)) {
    providers.push({ id: 'codex', name: 'Codex', driver: 'codex', models: [{ slug: '', name: 'Default model', shortName: 'Default', options: [], isDefault: true }], customModels: true });
  }
  return providers;
}

/** What the helper accepts as a model name: no spaces, and it cannot read as a command-line flag. */
export const isModelName = (text: string): boolean => /^[^\s-][^\s]{0,199}$/.test(text);

export function reasoningOption(model: PickerModel | undefined): ModelOption | undefined {
  return model?.options.find((option) => option.type === 'select' && (option.role === 'reasoning' || option.id === 'effort' || option.id === 'reasoningEffort'));
}

/** The saved choice if it still exists, else the first usable provider's default model. */
export function resolveChoice(providers: readonly PickerProvider[], saved: Choice | undefined): Choice | undefined {
  const saveable = saved === undefined ? undefined : providers.find((provider) => provider.id === saved.provider);
  if (saved !== undefined && (saveable?.customModels === true || saveable?.models.some((model) => model.slug === saved.model) === true)) return saved;
  const provider = providers.find((entry) => entry.unavailable === undefined) ?? providers[0];
  if (provider === undefined) return undefined;
  const model = provider.models.find((entry) => entry.isDefault === true) ?? provider.models[0];
  return model === undefined ? undefined : { provider: provider.id, model: model.slug, options: {} };
}

export function selectionFor(choice: Choice): ModelSelection {
  const options = Object.entries(choice.options).map(([id, value]) => ({ id, value }));
  return { instanceId: choice.provider, model: choice.model, ...(options.length === 0 ? {} : { options }) };
}

export function choiceLabel(providers: readonly PickerProvider[], choice: Choice | undefined): { name: string; effort?: string; driver?: string } {
  if (choice === undefined) return { name: 'No model' };
  const provider = providers.find((entry) => entry.id === choice.provider);
  const model = provider?.models.find((entry) => entry.slug === choice.model);
  // A direct run's "default model" is whatever the agent's own login picks, which T3-Tab never learns: the chip names the
  // agent instead of a word that names nothing. A model the catalog knows by name (T3's default is one) keeps its name.
  const unnamed = model === undefined ? choice.model === '' : model.slug === '';
  const name = unnamed
    ? (provider?.name ?? 'Default')
    : model === undefined
      ? provider?.customModels === true
        ? choice.model
        : choice.model.replace(/^claude-/, '').replaceAll('-', ' ')
      : compactModelName(model, provider?.driver);
  const reasoning = reasoningOption(model);
  const value = reasoning === undefined ? undefined : (choice.options[reasoning.id] ?? reasoning.currentValue ?? reasoning.options?.find((option) => option.isDefault === true)?.id);
  const effort = reasoning?.options?.find((option) => option.id === value)?.label;
  return { name, ...(effort === undefined ? {} : { effort }), ...(provider === undefined ? {} : { driver: provider.driver }) };
}
