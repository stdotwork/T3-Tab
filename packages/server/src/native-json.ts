import type { Readable, Writable } from 'node:stream';

const MAX_NATIVE_MESSAGE_BYTES = 1_024_000;

export async function readNativeMessage(stream: Readable): Promise<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffered.length < 4) continue;

    const length = buffered.readUInt32LE(0);
    if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
      throw new Error(`Invalid native message length: ${length}`);
    }
    if (buffered.length < 4 + length) continue;
    return JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'));
  }
  throw new Error('Native messaging input ended before a complete message arrived');
}

export async function writeNativeMessage(stream: Writable, message: unknown): Promise<void> {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native message is too large: ${payload.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  await new Promise<void>((resolve, reject) => {
    stream.write(Buffer.concat([header, payload]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
