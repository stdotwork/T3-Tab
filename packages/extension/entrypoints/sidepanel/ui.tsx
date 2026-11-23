import { Bot, Check, Copy, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type RefObject } from 'react';

import { PROVIDER_LOGOS } from './lib/provider-logos';


const initials = (name: string): string =>
  name
    .split(/[\s_-]+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

const themed = (fill: { light: string; dark: string }): CSSProperties => ({ '--logo-light': fill.light, '--logo-dark': fill.dark }) as CSSProperties;

/** T3's logo for a provider. A provider T3 has none for shows its initials, as T3 does. */
export function ProviderIcon({ driver, name, size = 16 }: { driver?: string | undefined; name?: string | undefined; size?: number }): ReactNode {
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

/** T3 Code's mark (MIT, from T3 Code's `assets/prod/logo.svg`, recoloured with the theme). Names T3 Code, never T3-Tab. */
export function T3Mark({ size = 18 }: { size?: number }): ReactNode {
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

export function Spinner({ size = 14 }: { size?: number }): ReactNode {
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
