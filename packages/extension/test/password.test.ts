import type { AxNode } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { redactPasswordValues } from '../src/password';

function textbox(id: number, value: string): AxNode {
  return { id: String(id), role: 'textbox', name: `Field ${id}`, value, backendId: id, children: [] };
}

describe('password redaction', () => {
  it('redacts masked fields beyond the first 200 without describing them', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => textbox(index + 1, '••••••••'));
    let describes = 0;
    await redactPasswordValues(nodes, async () => {
      describes += 1;
      return false;
    });
    expect(describes).toBe(0);
    expect(nodes.every((node) => node.value === undefined && node.props?.password === true)).toBe(true);
  });

  it('describes every unmasked textbox in batches and redacts a password after field 200', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => textbox(index + 1, `text-${index + 1}`));
    let active = 0;
    let maximumActive = 0;
    const described: number[] = [];
    await redactPasswordValues(
      nodes,
      async (backendId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        described.push(backendId);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return backendId === 240;
      },
      10,
    );
    expect(described).toHaveLength(260);
    expect(maximumActive).toBeLessThanOrEqual(10);
    expect(nodes[239]).toMatchObject({ props: { password: true } });
    expect(nodes[239]?.value).toBeUndefined();
    expect(nodes[240]?.value).toBe('text-241');
  });

  it('fails closed when a field cannot be inspected', async () => {
    const node = textbox(1, 'possibly secret');
    await redactPasswordValues([node], async () => {
      throw new Error('DOM unavailable');
    });
    expect(node.value).toBeUndefined();
    expect(node.props?.password).toBe(true);
  });
});
