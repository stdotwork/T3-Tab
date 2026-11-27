/**
 * What a person sees of an element, in client pixels: the union of its SVG shapes (strokes included), its text (each
 * glyph run's ink from the font's own metrics, not the line box, standing on its baseline with descenders left out),
 * its images and its filled or bordered boxes. Padding, empty button boxes and line height count for nothing. `installInk` defines `window.__ink(element)` in a page.
 */
export function installInkSource() {
  return `(${pageInk.toString()})();`;
}

function pageInk() {
  const canvas = document.createElement('canvas').getContext('2d');
  const visible = (style) => style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
  const painted = (color) => {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (match === null) return color !== 'transparent';
    const parts = match[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length < 4 || Number(parts[3]) > 0.01;
  };
  const textInk = (text, style, originX, baseline) => {
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = canvas.measureText(text);
    return {
      left: originX - metrics.actualBoundingBoxLeft,
      right: originX + metrics.actualBoundingBoxRight,
      top: baseline - metrics.actualBoundingBoxAscent,
      bottom: baseline + metrics.actualBoundingBoxDescent,
      descent: metrics.fontBoundingBoxDescent,
      ascent: metrics.fontBoundingBoxAscent,
    };
  };
  const add = (box, rect) => {
    if (rect === null || rect.right - rect.left <= 0.01 || rect.bottom - rect.top <= 0.01) return box;
    if (box === null) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    return { left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top), right: Math.max(box.right, rect.right), bottom: Math.max(box.bottom, rect.bottom) };
  };
  const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
  const walk = (node, box) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text.trim() === '') return box;
      const parent = node.parentElement;
      const style = getComputedStyle(parent);
      if (!visible(style)) return box;
      if (parent.closest('svg') !== null) {
        return add(box, parent.getBoundingClientRect());
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5) continue;
        // One line of the run: its ink from the font, placed on the baseline the line box implies.
        const probe = textInk('x', style, 0, 0);
        const baseline = rect.bottom - probe.descent;
        const clipped = parent.scrollWidth > parent.clientWidth + 0.5 && style.textOverflow === 'ellipsis';
        const shown = clipped ? text : text.trim();
        const ink = textInk(shown, style, rect.left, baseline);
        // Text stands on its baseline: descenders hang below the line it sits on, as in type.
        box = add(box, { left: ink.left, right: clipped ? Math.min(ink.right, parent.getBoundingClientRect().right) : Math.min(ink.right, rect.right + 1), top: ink.top, bottom: baseline });
      }
      return box;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return box;
    const style = getComputedStyle(node);
    if (!visible(style)) return box;
    const tag = node.tagName.toLowerCase();
    if (node instanceof SVGElement) {
      if (SHAPES.has(tag)) {
        const rect = node.getBoundingClientRect();
        const stroked = style.stroke !== 'none' && painted(style.stroke) && Number.parseFloat(style.strokeWidth) > 0;
        const filled = style.fill !== 'none' && painted(style.fill);
        if (!stroked && !filled) return box;
        const scale = node.getScreenCTM()?.a ?? 1;
        const half = stroked ? (Number.parseFloat(style.strokeWidth) * scale) / 2 : 0;
        return add(box, { left: rect.left - half, right: rect.right + half, top: rect.top - half, bottom: rect.bottom + half });
      }
      if (tag === 'text') return add(box, node.getBoundingClientRect());
    } else {
      const rect = node.getBoundingClientRect();
      if (tag === 'img' || tag === 'canvas') return add(box, rect);
      const borders = ['Top', 'Right', 'Bottom', 'Left'].some((side) => Number.parseFloat(style[`border${side}Width`]) > 0 && painted(style[`border${side}Color`]) && style[`border${side}Style`] !== 'none');
      if (painted(style.backgroundColor) || style.backgroundImage !== 'none' || borders) box = add(box, rect);
      if ((tag === 'input' || tag === 'textarea') && (node.value === '' ? node.placeholder : node.value) !== '') {
        const shownText = node.value === '' ? node.placeholder : node.value.split('\n')[0];
        const textStyle = node.value === '' ? getComputedStyle(node, '::placeholder') : style;
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
        const probe = textInk('x', textStyle, 0, 0);
        const contentTop = rect.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
        const contentHeight = tag === 'input' ? rect.height - Number.parseFloat(style.borderTopWidth) - Number.parseFloat(style.borderBottomWidth) - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom) : lineHeight;
        const baseline = contentTop + (contentHeight - (probe.ascent + probe.descent)) / 2 + probe.ascent;
        const originX = rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
        const ink = textInk(shownText, textStyle, originX, baseline);
        box = add(box, { left: ink.left, top: ink.top, bottom: baseline, right: Math.min(ink.right, rect.right) });
      }
    }
    // What overflows a clipping box is not seen.
    const clips = !(node instanceof SVGElement) && (style.overflowX !== 'visible' || style.overflowY !== 'visible');
    let inner = clips ? null : box;
    for (const child of node.childNodes) inner = walk(child, inner);
    if (!clips) return inner;
    if (inner === null) return box;
    const rect = node.getBoundingClientRect();
    const cut = { left: Math.max(inner.left, rect.left), top: Math.max(inner.top, rect.top), right: Math.min(inner.right, rect.right), bottom: Math.min(inner.bottom, rect.bottom) };
    return cut.right > cut.left && cut.bottom > cut.top ? add(box, cut) : box;
  };
  window.__ink = (element) => (element === null || element === undefined ? null : walk(element, null));
  /** The rendered size of every icon glyph's own box (its SVG element), not its ink. */
  window.__glyph = (element) => {
    const svg = element?.matches('svg') ? element : element?.querySelector('svg');
    if (svg === null || svg === undefined) return null;
    const rect = svg.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };
}
