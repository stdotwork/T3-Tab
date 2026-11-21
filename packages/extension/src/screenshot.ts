import type { ScreenshotResult } from '@t3-tab/protocol';

import { sendCommand } from './cdp';

const JPEG_QUALITY = 85;

interface LayoutMetrics {
  cssVisualViewport: { clientWidth: number; clientHeight: number };
}

/**
 * A JPEG of the tab's viewport whose long edge is at most `maxEdge` pixels. The browser captures at
 * full resolution and the image is scaled here: asking the browser to scale the capture resizes the
 * page's viewport while it runs, which the page can see and react to.
 */
export async function captureViewport(tabId: number, maxEdge: number): Promise<ScreenshotResult> {
  const metrics = await sendCommand<LayoutMetrics>(tabId, 'Page.getLayoutMetrics');
  const captured = await sendCommand<{ data?: unknown }>(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: JPEG_QUALITY,
  });
  if (typeof captured.data !== 'string' || captured.data === '') throw new Error('The browser returned no image');

  const bitmap = await createImageBitmap(base64ToBlob(captured.data, 'image/jpeg'));
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const base = {
      tab: tabId,
      viewportWidth: Math.round(metrics.cssVisualViewport.clientWidth),
      viewportHeight: Math.round(metrics.cssVisualViewport.clientHeight),
    };
    if (scale === 1) return { ...base, data: captured.data, width: bitmap.width, height: bitmap.height };

    const width = Math.min(maxEdge, Math.max(1, Math.round(bitmap.width * scale)));
    const height = Math.min(maxEdge, Math.max(1, Math.round(bitmap.height * scale)));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The browser could not scale the screenshot');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const scaled = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY / 100 });
    return { ...base, data: await blobToBase64(scaled), width, height };
  } finally {
    bitmap.close();
  }
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
