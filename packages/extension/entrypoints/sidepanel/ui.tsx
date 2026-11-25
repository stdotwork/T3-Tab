import { Bot, Check, Cloud, Copy, Laptop, Loader2, Monitor, Server } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type RefObject } from 'react';

import { alignInk, centreInk, type InkAlign } from './lib/ink';
import { PROVIDER_LOGOS } from './lib/provider-logos';

/**
 * The panel's icon sizes, and the only ones it uses: `md` in bars, on icon buttons and in the composer's row; `sm` beside
 * 14 px text in rows and menus; `xs` beside 12 px text in chips and labels; `lg` for the marks in the setup list.
 */
/** The composer row's glyph weight: Lucide draws on a 24 px grid, so 2.25 there is a 1.5 px stroke at 16 px, the send arrow's. */
export const GLYPH_STROKE = 2.25;

export const ICON = { xs: 12, sm: 14, md: 16, lg: 20 } as const;

/**
 * Puts the visible ink of a row's controls where the row's tokens say, whatever the glyph inside each box: the first
 * control's ink `--ink-inset` from the frame's left edge and the last one's the same from its right edge (`edges`), and
 * every control's ink centre on the row's middle line (`centres`). The frame is the nearest `[data-ink-frame]`, else the row.
 */
export function useInkAlign<T extends HTMLElement>(options: InkAlign): RefObject<T | null> {
  return useInkLayout<T>((row) => alignInk(row, options));
}

/** Centres a centred block's lines on its first line's ink (`centreInk`). */
export function useInkCentre<T extends HTMLElement>(): RefObject<T | null> {
  return useInkLayout<T>(centreInk);
}

/** Runs an ink layout before every paint of its element, once the fonts are in, and when the element resizes. */
function useInkLayout<T extends HTMLElement>(layout: (element: T) => void): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (ref.current !== null) layout(ref.current);
  });
  useEffect(() => {
    const row = ref.current;
    if (row === null) return;
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) layout(row);
    });
    const observer = new ResizeObserver(() => layout(row));
    observer.observe(row);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);
  return ref;
}

const initials = (name: string): string =>
  name
    .split(/[\s_-]+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

const themed = (fill: { light: string; dark: string }): CSSProperties => ({ '--logo-light': fill.light, '--logo-dark': fill.dark }) as CSSProperties;

/** T3's logo for a provider. A provider T3 has none for shows its initials, as T3 does. */
export function ProviderIcon({ driver, name, size = ICON.md }: { driver?: string | undefined; name?: string | undefined; size?: number }): ReactNode {
  const gradientId = useId();
  const logo = PROVIDER_LOGOS[driver === 'claude' ? 'claudeAgent' : (driver ?? '')];
  if (logo === undefined) {
    if (name === undefined || name === '') return <Bot size={size} aria-hidden="true" />;
    return (
      <span className="provider-initials" style={{ width: size, height: size, fontSize: Math.max(8, size * 0.5) }} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  if (logo.image !== undefined) return <img src={logo.image} width={size} height={size} alt="" aria-hidden="true" style={{ flex: 'none' }} />;
  return (
    <svg className="provider-logo" width={size} height={size} viewBox={logo.viewBox} aria-hidden="true" style={{ flex: 'none', ...themed(logo.fill) }}>
      {logo.paths.some((path) => path.gradient !== undefined) ? (
        <defs>
          {logo.paths.map((path, index) =>
            path.gradient === undefined ? null : (
              <linearGradient key={path.d} id={`${gradientId}-${index}`} x1={path.gradient.x1} y1={path.gradient.y1} x2={path.gradient.x2} y2={path.gradient.y2} gradientUnits="userSpaceOnUse">
                {path.gradient.stops.map((stop) => (
                  <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                ))}
              </linearGradient>
            ),
          )}
        </defs>
      ) : null}
      {logo.paths.map((path, index) => (
        <path
          key={path.d}
          d={path.d}
          fillRule={path.fillRule}
          {...(path.gradient === undefined ? {} : { fill: `url(#${gradientId}-${index})` })}
          {...(path.fill === undefined ? {} : { className: 'provider-logo-detail', style: themed(path.fill) })}
        />
      ))}
    </svg>
  );
}

const MONOGRAM_HUES = ['gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'] as const;

/** A project's two letters, as T3 Code's `ProjectMonogram` takes them: the first letter, then a digit of that word, else the last word's first letter, else the word's last letter. */
export function projectInitials(name: string): string {
  const words = name.normalize('NFKC').trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return 'PR';
  const first = [...(words[0] ?? '')];
  const digit = first.slice(1).find((char) => /\p{N}/u.test(char));
  const second = digit ?? (words.length >= 2 ? [...(words.at(-1) ?? '')][0] : first.at(-1));
  return `${first[0] ?? ''}${second ?? ''}`.toUpperCase().slice(0, 2);
}

/** The project's colour, from T3's hash of its lower-cased name over the same eighteen hues. */
export function projectHue(name: string): (typeof MONOGRAM_HUES)[number] {
  let hash = 0;
  for (const char of name.toLocaleLowerCase('en-US') || 'project') hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % MONOGRAM_HUES.length;
  return MONOGRAM_HUES[hash] ?? 'gray';
}

/** T3 Code's project avatar: a rounded square in the project's colour with its two letters. */
export function ProjectAvatar({ name }: { name: string }): ReactNode {
  const initials = projectInitials(name);
  return (
    <span className="project-avatar" data-hue={projectHue(name)} aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <text x="8" y="10.8" textAnchor="middle" fill="currentColor" fontSize="8.25" fontWeight="700" textLength={[...initials].length === 1 ? 6 : 12} lengthAdjust="spacingAndGlyphs" textRendering="geometricPrecision">
          {initials}
        </text>
      </svg>
    </span>
  );
}

const MACHINE_ICONS = { desktop: Monitor, laptop: Laptop, server: Server, cloud: Cloud } as const;

/** T3's icon for the kind of machine an environment runs on; the kinds it draws itself fall back to a monitor. */
export function MachineIcon({ kind, size = ICON.sm }: { kind?: string | undefined; size?: number }): ReactNode {
  const Icon = MACHINE_ICONS[kind as keyof typeof MACHINE_ICONS] ?? Monitor;
  return <Icon size={size} aria-hidden="true" />;
}

/** T3 Code's mark (MIT, from T3 Code's `assets/prod/logo.svg`, recoloured with the theme). Names T3 Code, never T3-Tab. */
export function T3Mark({ size = ICON.lg }: { size?: number }): ReactNode {
  return (
    <svg className="t3-mark" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx="24" />
      <path d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z" />
    </svg>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

export function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Spinner({ size = ICON.sm }: { size?: number }): ReactNode {
  return <Loader2 size={size} className="spin" aria-hidden="true" />;
}

/** Closes on an outside click or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) latest.current();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        latest.current();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, ref]);
}

export function timeAgo(at: number | undefined): string {
  if (at === undefined || Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
