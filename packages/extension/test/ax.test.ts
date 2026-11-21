import { describe, expect, it } from 'vitest';

import { slimAxNodes } from '../src/ax.js';

describe('slimming the accessibility tree', () => {
  it('keeps role, name, value, backend id, children and the flags the reader prints', () => {
    const nodes = slimAxNodes([
      {
        nodeId: '5',
        ignored: false,
        role: { type: 'role', value: 'checkbox' },
        name: { type: 'computedString', value: 'Agree' },
        value: { type: 'string', value: 'on' },
        properties: [
          { name: 'checked', value: { type: 'tristate', value: 'true' } },
          { name: 'focusable', value: { type: 'booleanOrUndefined', value: true } },
          { name: 'level', value: { type: 'integer', value: 2 } },
        ],
        childIds: ['6', 7],
        backendDOMNodeId: 42,
        frameId: 'F1',
      },
    ]);
    expect(nodes).toEqual([
      {
        id: '5',
        role: 'checkbox',
        name: 'Agree',
        value: 'on',
        props: { checked: 'true', level: 2 },
        children: ['6'],
        backendId: 42,
      },
    ]);
  });

  it('keeps only the children of an ignored node', () => {
    expect(
      slimAxNodes([{ nodeId: '2', ignored: true, role: { value: 'none' }, ignoredReasons: [], childIds: ['3'] }]),
    ).toEqual([{ id: '2', role: '', name: '', ignored: true, children: ['3'] }]);
  });

  it('cuts long names and values and skips malformed entries', () => {
    const [node] = slimAxNodes([
      null,
      { role: { value: 'button' } },
      { nodeId: '1', role: { value: 'textbox' }, name: { value: 'n'.repeat(1_000) }, value: { value: 'v'.repeat(1_000) } },
    ]);
    expect(node?.name).toHaveLength(300);
    expect(node?.value).toHaveLength(200);
    expect(slimAxNodes('not a list')).toEqual([]);
  });
});
