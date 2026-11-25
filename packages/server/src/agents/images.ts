import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentImage } from '@t3-tab/protocol';

/** The image types Claude and Codex both take. */
export const DIRECT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
/**
 * Per image and per message. Claude Code caps piped stdin at 10 MB, and the images go there base64-encoded; the
 * extension's link to the daemon carries at most 16 MiB a message.
 */
export const MAX_DIRECT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DIRECT_IMAGES_BYTES = 6 * 1024 * 1024;
export const MAX_DIRECT_IMAGES = 20;

export interface DirectImage {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What the first bytes say the image is, so a file cannot pass as a type it is not. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

/** Checks the images the extension sent with a direct turn. Absent means none. */
export function parseImages(value: unknown): DirectImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid images');
  if (value.length > MAX_DIRECT_IMAGES) throw new Error(`At most ${MAX_DIRECT_IMAGES} images go with one message`);
  let total = 0;
  return value.map((entry: unknown) => {
    const { name, mimeType, data } = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<Record<keyof AgentImage, unknown>>;
    if (typeof name !== 'string' || typeof mimeType !== 'string' || typeof data !== 'string') throw new Error('Invalid image');
    const shown = [...name].filter((character) => character >= ' ' && character !== '\x7f').join('').slice(0, 255) || 'image';
    if (DIRECT_IMAGE_TYPES[mimeType] === undefined) throw new Error(`${shown}: only PNG, JPEG, GIF and WebP images can go to this agent`);
    if (!BASE64.test(data) || data.length % 4 !== 0) throw new Error(`${shown}: the image data is not base64`);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) throw new Error(`${shown}: the image is empty`);
    if (bytes.length > MAX_DIRECT_IMAGE_BYTES) throw new Error(`${shown}: an image can be at most 5 MB`);
    total += bytes.length;
    if (total > MAX_DIRECT_IMAGES_BYTES) throw new Error('The images of one message can be at most 6 MB together');
    if (sniffImageType(bytes) !== mimeType) throw new Error(`${shown}: the file is not the ${mimeType} image it says it is`);
    return { name: shown, mimeType, bytes };
  });
}

/** The line `claude -p --input-format stream-json` reads: the message and its images, as one user message. */
export function claudeUserLine(text: string, images: readonly DirectImage[]): string {
  const content = [
    { type: 'text', text },
    ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.bytes.toString('base64') } })),
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })}\n`;
}

export interface ImageFiles {
  paths: string[];
  remove(): Promise<void>;
}

/** Writes a Codex turn's images where only the owner can read them; `codex exec --image` takes paths. */
export async function writeImageFiles(stateDir: string, images: readonly DirectImage[]): Promise<ImageFiles> {
  const parent = join(stateDir, 'images');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(parent, 'run-'));
  try {
    const paths: string[] = [];
    for (const [index, image] of images.entries()) {
      const path = join(folder, `image-${index + 1}.${DIRECT_IMAGE_TYPES[image.mimeType] ?? 'img'}`);
      await writeFile(path, image.bytes, { mode: 0o600, flag: 'wx' });
      paths.push(path);
    }
    return { paths, remove: async () => await rm(folder, { recursive: true, force: true }) };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
