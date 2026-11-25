import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeArgs, codexArgs } from '../src/agents/commands.js';
import { claudeUserLine, MAX_DIRECT_IMAGE_BYTES, parseImages, sniffImageType, writeImageFiles } from '../src/agents/images.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a....');
const image = (bytes: Buffer, mimeType: string, name = 'shot.png'): { name: string; mimeType: string; data: string } => ({ name, mimeType, data: bytes.toString('base64') });
const server = { command: 'node', args: ['/x/cli.js', 'mcp'] };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-images-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('images for a direct run', () => {
  it('knows PNG, JPEG, GIF and WebP by their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeUndefined();
  });

  it('takes none when absent, and the images it was sent otherwise', () => {
    expect(parseImages(undefined)).toEqual([]);
    const [parsed] = parseImages([image(PNG, 'image/png', 'a\nb.png')]);
    expect(parsed?.name).toBe('ab.png');
    expect(parsed?.mimeType).toBe('image/png');
    expect(parsed?.bytes.equals(PNG)).toBe(true);
  });

  it('refuses a type it cannot pass on, bytes that are not that type, bad base64, and sizes over the limits', () => {
    expect(() => parseImages('x')).toThrow('Invalid images');
    expect(() => parseImages([{ name: 'a' }])).toThrow('Invalid image');
    expect(() => parseImages([image(Buffer.from('%PDF'), 'application/pdf', 'a.pdf')])).toThrow('only PNG, JPEG, GIF and WebP');
    expect(() => parseImages([image(JPEG, 'image/png')])).toThrow('not the image/png image it says it is');
    expect(() => parseImages([{ name: 'a', mimeType: 'image/png', data: 'not base64!' }])).toThrow('not base64');
    expect(() => parseImages([image(Buffer.alloc(0), 'image/png')])).toThrow('empty');
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_DIRECT_IMAGE_BYTES)]);
    expect(() => parseImages([image(big, 'image/png')])).toThrow('at most 5 MB');
    const four = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    expect(() => parseImages([image(four, 'image/png'), image(four, 'image/png')])).toThrow('at most 6 MB together');
    expect(() => parseImages(Array.from({ length: 21 }, () => image(PNG, 'image/png')))).toThrow('At most 20 images');
  });

  it("gives Claude Code one stream-json user message with the text and each image as a base64 block", () => {
    const line = claudeUserLine('What is this?', parseImages([image(PNG, 'image/png')]));
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
        ],
      },
      parent_tool_use_id: null,
    });
  });

  it("writes Codex's images to private files and removes them with their folder", async () => {
    const files = await writeImageFiles(root, parseImages([image(PNG, 'image/png'), image(JPEG, 'image/jpeg', 'b.jpg')]));
    expect(files.paths.map((path) => path.split('/').at(-1))).toEqual(['image-1.png', 'image-2.jpg']);
    for (const path of files.paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'images'))).mode & 0o777).toBe(0o700);
    expect((await readFile(files.paths[1] as string)).equals(JPEG)).toBe(true);
    await files.remove();
    for (const path of files.paths) expect(existsSync(path)).toBe(false);
  });

  it('switches Claude Code to stream-json input only when images go with the message', () => {
    expect(claudeArgs({ server, env: {} })).not.toContain('--input-format');
    const args = claudeArgs({ server, env: {}, imageInput: true });
    expect(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2)).toEqual(['--input-format', 'stream-json']);
  });

  it('joins each Codex image to its flag, so the session id and the stdin marker stay positional', () => {
    const args = codexArgs({ server, env: {}, resume: 'sess-1', imageFiles: ['/s/a.png', '/s/b.jpg'] });
    expect(args.filter((value) => value.startsWith('--image'))).toEqual(['--image=/s/a.png', '--image=/s/b.jpg']);
    expect(args.slice(-2)).toEqual(['sess-1', '-']);
    expect(codexArgs({ server, env: {} }).some((value) => value.startsWith('--image'))).toBe(false);
  });
});
