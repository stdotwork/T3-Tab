// Adapted from T3 Code (https://github.com/pingdotgg/t3code, revision fb23f12f1f), MIT License,
// Copyright (c) 2026 T3 Tools Inc. Source: packages/provider-core/src/modelShortName.ts and the `modelFamilies` of
// packages/client-runtime/src/providerClients.ts and packages/provider-{cursor,grok,muse}/src/client.ts.
// Changed: the families are looked up here by driver, and `compactModelName` puts the two steps together.

const FAMILY_PREFIXES = ['Claude ', 'GPT-', 'GPT ', 'Gemini ', 'Muse ', 'Grok '] as const;

const NATIVE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  codex: ['GPT-', 'GPT '],
  claudeAgent: ['Claude '],
  antigravity: ['Gemini '],
  cursor: ['Grok '],
  grok: ['Grok '],
  muse: ['Muse '],
};

// Words that describe a variant within a family rather than name a model. Off the family's native provider there is
// no icon saying which family "4 Pro" belongs to.
const VARIANT_WORDS = new Set([
  'pro',
  'flash',
  'mini',
  'max',
  'lite',
  'nano',
  'ultra',
  'plus',
  'fast',
  'turbo',
  'preview',
  'latest',
  'thinking',
  'reasoning',
  'build',
  'code',
  'image',
  'vision',
  'audio',
  'live',
  'custom',
  'tools',
  'exp',
  'experimental',
  'chat',
  'tts',
  'stt',
  'non',
  'transcribe',
]);

const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;
const VENDOR_PREFIX = /^[A-Z][\w.&\- ]{0,24}: (?=\S)/;

const nonVersionWords = (text: string): string[] =>
  text
    .replace(/\(.*?\)/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word.length > 0 && !VERSION.test(word));

const namesModel = (text: string): boolean => nonVersionWords(text).some((word) => !VARIANT_WORDS.has(word.toLowerCase()));

function withoutFamily(name: string, nativeFamilies: readonly string[]): string | undefined {
  const prefix = FAMILY_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (prefix === undefined) return undefined;
  const rest = name.slice(prefix.length).trim();
  const keep = nativeFamilies.includes(prefix) ? nonVersionWords(rest).length > 0 : namesModel(rest);
  if (!keep) return undefined;
  return /\s/.test(rest) ? rest : rest.replaceAll('-', ' ');
}

export function modelShortName(name: string, nativeFamilies: readonly string[]): string | undefined {
  const unprefixed = name.replace(VENDOR_PREFIX, '');
  const short = withoutFamily(unprefixed, nativeFamilies) ?? (namesModel(unprefixed) ? unprefixed : name);
  return short === name ? undefined : short;
}

/** What the pickers show for a model: T3's own short name if it has one, otherwise the name without what the logo says. */
export function compactModelName(model: { name: string; shortName?: string | undefined }, driver: string | undefined): string {
  if (model.shortName !== undefined && model.shortName !== '') return model.shortName;
  return modelShortName(model.name, NATIVE_FAMILIES[driver ?? ''] ?? []) ?? model.name;
}
