/**
 * Where a control's visible ink is, as opposed to its box: the drawn strokes and fills of its icons, its text from the
 * font's own glyph metrics, and its box only when the box itself is painted (`data-ink="box"`, like the send button).
 * Rows use it so that what people see lines up, not the padding around it.
 */
export interface Ink {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface InkAlign {
  /** The first and last controls' ink sit `--ink-inset` from the frame's edges. */
  edges?: boolean;
  /** Every control's ink bottom sits on one line, the row's bottom. */
  bottoms?: boolean;
}

const SHAPES = 'path, circle, ellipse, rect, line, polyline, polygon';
let measure: CanvasRenderingContext2D | null | undefined;

const union = (box: Ink | undefined, next: Ink): Ink =>
  box === undefined ? next : { left: Math.min(box.left, next.left), right: Math.max(box.right, next.right), top: Math.min(box.top, next.top), bottom: Math.max(box.bottom, next.bottom) };

const skipped = (element: Element, root: Element): boolean => {
  for (let node: Element | null = element; node !== null && node !== root.parentElement; node = node.parentElement) {
    if (node.matches('.popover, [data-ink-skip]')) return true;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
};

function textInk(node: Text): Ink | undefined {
  const parent = node.parentElement;
  const text = node.textContent?.trim() ?? '';
  if (parent === null || text === '') return undefined;
  measure ??= document.createElement('canvas').getContext('2d');
  if (measure === null) return undefined;
  const style = getComputedStyle(parent);
  measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const metrics = measure.measureText(text);
  const range = document.createRange();
  range.selectNodeContents(node);
  let box: Ink | undefined;
  for (const rect of range.getClientRects()) {
    if (rect.width < 0.5) continue;
    const baseline = rect.bottom - metrics.fontBoundingBoxDescent;
    // Text stands on its baseline; descenders hang below it, as in type, so "Opus" and "Haiku" stand on one line.
    box = union(box, {
      left: rect.left - metrics.actualBoundingBoxLeft,
      right: Math.min(rect.right, rect.left + metrics.actualBoundingBoxRight),
      top: baseline - metrics.actualBoundingBoxAscent,
      bottom: baseline,
    });
  }
  return box;
}

type Drawn = HTMLElement | SVGElement;

export function inkOf(element: Drawn): Ink | undefined {
  if (element.dataset.ink === 'box') return element.getBoundingClientRect();
  let box: Ink | undefined;
  for (const shape of element.querySelectorAll<SVGGraphicsElement>(SHAPES)) {
    if (skipped(shape, element)) continue;
    const style = getComputedStyle(shape);
    const stroked = style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0;
    if (!stroked && style.fill === 'none') continue;
    const rect = shape.getBoundingClientRect();
    const half = stroked ? (Number.parseFloat(style.strokeWidth) * (shape.getScreenCTM()?.a ?? 1)) / 2 : 0;
    box = union(box, { left: rect.left - half, right: rect.right + half, top: rect.top - half, bottom: rect.bottom + half });
  }
  for (const filled of element.querySelectorAll<HTMLElement>('img, [data-ink="box"]')) if (!skipped(filled, element)) box = union(box, filled.getBoundingClientRect());
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || parent.closest('svg') !== null || skipped(parent, element)) continue;
    const ink = textInk(node as Text);
    if (ink !== undefined) box = union(box, ink);
  }
  return box;
}

/** Sets margins on a row's controls so that their ink, not their boxes, meets the row's lines. */
export function alignInk(row: HTMLElement, { edges = false, bottoms = false }: InkAlign): void {
  const controls = [...row.children].filter(
    (child): child is Drawn => (child instanceof HTMLElement || child instanceof SVGElement) && child.getClientRects().length > 0 && !child.hasAttribute('data-ink-skip'),
  );
  for (const control of controls) {
    control.style.removeProperty('margin-left');
    control.style.removeProperty('margin-right');
    control.style.removeProperty('margin-bottom');
  }
  const measured = controls.map((control) => ({ control, box: control.getBoundingClientRect(), ink: inkOf(control) })).filter((entry) => entry.ink !== undefined) as Array<{ control: Drawn; box: DOMRect; ink: Ink }>;
  if (measured.length === 0) return;
  if (edges) {
    const frame = (row.closest('[data-ink-frame]') ?? row).getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(row).getPropertyValue('--ink-inset')) || 0;
    const first = measured[0];
    const last = measured.at(-1);
    if (first !== undefined) first.control.style.marginLeft = `${Number.parseFloat(getComputedStyle(first.control).marginLeft) + inset - (first.ink.left - frame.left)}px`;
    if (last !== undefined) last.control.style.marginRight = `${Number.parseFloat(getComputedStyle(last.control).marginRight) + inset - (frame.right - last.ink.right)}px`;
  }
  if (bottoms) {
    for (const { control, box, ink } of measured) control.style.marginBottom = `${Number.parseFloat(getComputedStyle(control).marginBottom) - (box.bottom - ink.bottom)}px`;
  }
}

/**
 * Centres each line of a centred block on its first line's ink rather than on the boxes: text centred by its advance
 * widths can sit a pixel off, because glyphs such as `W` and `?` carry their own side bearings.
 */
export function centreInk(block: HTMLElement): void {
  const lines = [...block.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.getClientRects().length > 0);
  for (const line of lines) line.style.removeProperty('translate');
  const anchor = lines[0] === undefined ? undefined : inkOf(lines[0]);
  if (anchor === undefined) return;
  const centre = (anchor.left + anchor.right) / 2;
  for (const line of lines.slice(1)) {
    const ink = inkOf(line);
    if (ink !== undefined) line.style.translate = `${centre - (ink.left + ink.right) / 2}px 0`;
  }
}
