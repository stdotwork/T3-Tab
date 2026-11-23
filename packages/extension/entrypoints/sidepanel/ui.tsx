import { Bot, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type RefObject } from 'react';

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

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
