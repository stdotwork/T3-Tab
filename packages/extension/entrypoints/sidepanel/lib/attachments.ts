/**
 * Files attached in the composer, and what each agent can take. A T3 thread takes what T3 Code's own composer takes
 * (`attachments.createUploadUrl` in T3's contracts): PNG, JPEG, GIF and WebP up to 10 MB as images, anything else up
 * to 50 MB as a file. A direct run takes images only, which its CLI reads itself (`images.ts` in the server).
 */

export interface DraftAttachment {
  /** The panel's own id for it, not T3's. */
  key: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  /** An object URL for an image's thumbnail; revoked when it is removed. */
  preview?: string;
}

/** What a message's attachment is sent as. */
export type AttachmentTarget = { kind: 't3' } | { kind: 'direct'; agent: string };

const MB = 1024 * 1024;
export const T3_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const T3_MAX_IMAGE_BYTES = 10 * MB;
export const T3_MAX_FILE_BYTES = 50 * MB;
export const T3_MAX_ATTACHMENTS = 100;
export const DIRECT_IMAGE_TYPES = T3_IMAGE_TYPES;
// Kept in step with `images.ts` in the server, which checks them again.
export const DIRECT_MAX_IMAGE_BYTES = 5 * MB;
export const DIRECT_MAX_TOTAL_BYTES = 6 * MB;
export const DIRECT_MAX_IMAGES = 20;
const MAX_NAME = 255;

/** What the file chooser offers; anything still goes in by paste or drop, and then says why it cannot be sent. */
export const acceptFor = (target: AttachmentTarget): string | undefined => (target.kind === 'direct' ? [...DIRECT_IMAGE_TYPES].join(',') : undefined);

const mb = (bytes: number): string => `${Math.round((bytes / MB) * 10) / 10} MB`;

export function draftAttachment(file: File, key: string): DraftAttachment {
  const name = ([...file.name].filter((character) => character >= ' ' && character !== '\x7f').join('').trim() || 'pasted-file').slice(0, MAX_NAME);
  const mimeType = file.type === '' || file.type.length > 100 ? 'application/octet-stream' : file.type;
  return { key, file, name, mimeType, size: file.size };
}

/** T3's kind for one attachment, as its `attachments.createUploadUrl` and `ChatAttachment` take it. */
export const t3Kind = (attachment: Pick<DraftAttachment, 'mimeType'>): 'image' | 'file' => (T3_IMAGE_TYPES.has(attachment.mimeType) ? 'image' : 'file');

/**
 * Why each attachment cannot go with this message, by key. Empty means all of them can. Nothing is dropped quietly:
 * the composer shows the reason and holds the message until the owner removes the file.
 */
export function attachmentProblems(attachments: readonly DraftAttachment[], target: AttachmentTarget): Map<string, string> {
  const problems = new Map<string, string>();
  if (target.kind === 't3') {
    attachments.forEach((attachment, index) => {
      if (attachment.size === 0) problems.set(attachment.key, `${attachment.name} is empty.`);
      else if (index >= T3_MAX_ATTACHMENTS) problems.set(attachment.key, `T3 Code takes at most ${T3_MAX_ATTACHMENTS} files a message.`);
      else if (t3Kind(attachment) === 'image' && attachment.size > T3_MAX_IMAGE_BYTES) problems.set(attachment.key, `${attachment.name} is ${mb(attachment.size)}; T3 Code takes images up to 10 MB.`);
      else if (attachment.size > T3_MAX_FILE_BYTES) problems.set(attachment.key, `${attachment.name} is ${mb(attachment.size)}; T3 Code takes files up to 50 MB.`);
    });
    return problems;
  }
  let total = 0;
  let images = 0;
  for (const attachment of attachments) {
    if (!DIRECT_IMAGE_TYPES.has(attachment.mimeType)) {
      problems.set(attachment.key, `${attachment.name} can't go to ${target.agent}: it takes PNG, JPEG, GIF and WebP images only.`);
      continue;
    }
    if (attachment.size === 0) {
      problems.set(attachment.key, `${attachment.name} is empty.`);
      continue;
    }
    if (attachment.size > DIRECT_MAX_IMAGE_BYTES) {
      problems.set(attachment.key, `${attachment.name} is ${mb(attachment.size)}; ${target.agent} gets images up to 5 MB here.`);
      continue;
    }
    images += 1;
    total += attachment.size;
    if (images > DIRECT_MAX_IMAGES) problems.set(attachment.key, `${target.agent} gets at most ${DIRECT_MAX_IMAGES} images a message here.`);
    else if (total > DIRECT_MAX_TOTAL_BYTES) problems.set(attachment.key, `The images of one message to ${target.agent} can be at most 6 MB together.`);
  }
  return problems;
}

/** The files a paste or drop carries. Text is left to the textarea. */
export function transferFiles(transfer: DataTransfer | null): File[] {
  if (transfer === null) return [];
  const files = [...transfer.files];
  if (files.length > 0) return files;
  return [...transfer.items].flatMap((item) => {
    if (item.kind !== 'file') return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

/** Base64 of a file's bytes, for a direct run's image. */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
