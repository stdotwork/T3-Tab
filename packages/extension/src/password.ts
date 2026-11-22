import type { AxNode } from '@t3-tab/protocol';

const DESCRIBE_BATCH_SIZE = 25;

function looksMaskedValue(value: string | undefined): boolean {
  return value !== undefined && value !== '' && /^•+$/.test(value);
}

/**
 * Removes password values before the AX tree crosses the extension boundary. Masked values are
 * handled without a DOM round trip; the remaining text boxes are described in bounded batches.
 * A text box that cannot be inspected is redacted rather than risking a password leak.
 */
export async function redactPasswordValues(
  nodes: AxNode[],
  describe: (backendId: number) => Promise<boolean>,
  batchSize = DESCRIBE_BATCH_SIZE,
): Promise<void> {
  const fields = nodes.filter((node) => node.role.toLowerCase() === 'textbox');
  const needDescription: AxNode[] = [];
  for (const node of fields) {
    if (looksMaskedValue(node.value)) redact(node);
    else if (node.backendId === undefined) redact(node);
    else needDescription.push(node);
  }
  for (let start = 0; start < needDescription.length; start += batchSize) {
    const batch = needDescription.slice(start, start + batchSize);
    await Promise.all(
      batch.map(async (node) => {
        let isPassword = true;
        try {
          isPassword = await describe(node.backendId ?? -1);
        } catch {
          // Fail closed: a field we cannot classify never carries its value into the reader.
        }
        if (isPassword) redact(node);
      }),
    );
  }
}

function redact(node: AxNode): void {
  delete node.value;
  node.props = { ...node.props, password: true };
}
