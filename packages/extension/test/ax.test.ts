import { describe, expect, it } from 'vitest';

import { restrictToOriginFrames, slimAxNodes, type FramePolicy } from '../src/ax.js';

describe('slimming the accessibility tree', () => {
  it('keeps role, name, value, backend id, children and the properties the reader uses', () => {
    const nodes = slimAxNodes([
      {
        nodeId: '5',
        ignored: false,
        role: { type: 'role', value: 'combobox' },
        name: { type: 'computedString', value: 'Agree' },
        value: { type: 'string', value: 'on' },
        properties: [
          { name: 'checked', value: { type: 'tristate', value: 'true' } },
          { name: 'focusable', value: { type: 'booleanOrUndefined', value: true } },
          { name: 'level', value: { type: 'integer', value: 2 } },
          { name: 'live', value: { type: 'token', value: 'polite' } },
        ],
        childIds: ['6', 7],
        backendDOMNodeId: 42,
        frameId: 'F1',
      },
    ]);
    expect(nodes).toEqual([
      {
        id: '5',
        role: 'combobox',
        name: 'Agree',
        value: 'on',
        props: { checked: 'true', level: 2, live: 'polite' },
        children: ['6'],
        backendId: 42,
      },
    ]);
  });

  it('keeps the value only of the roles the reader prints one for', () => {
    const node = (role: string) => ({ nodeId: role, role: { value: role }, name: { value: 'N' }, value: { value: '4242' }, childIds: [] });
    const kept = slimAxNodes(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'button', 'checkbox', 'RootWebArea'].map(node));
    expect(kept.map((item) => [item.role, item.value])).toEqual([
      ['textbox', '4242'],
      ['searchbox', '4242'],
      ['combobox', '4242'],
      ['spinbutton', '4242'],
      ['slider', '4242'],
      ['button', undefined],
      ['checkbox', undefined],
      ['RootWebArea', undefined],
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
    // A name this long is kept whole, so `find` can reach all of it.
    expect(node?.name).toHaveLength(1_000);
    expect(node?.value).toHaveLength(200);
    expect(node?.value?.endsWith('…')).toBe(true);
    expect(slimAxNodes('not a list')).toEqual([]);
  });

  it('marks a name it cuts, and stops keeping long names once a page has sent a lot of text', () => {
    const long = { value: 'n'.repeat(9_000) };
    const nodes = slimAxNodes(Array.from({ length: 260 }, (_, index) => ({ nodeId: String(index), role: { value: 'StaticText' }, name: long })));
    expect(nodes[0]?.name).toHaveLength(8_000);
    expect(nodes[0]?.name.endsWith('…')).toBe(true);
    expect(nodes.at(-1)?.name).toHaveLength(300);
    expect(nodes.at(-1)?.name.endsWith('…')).toBe(true);
  });

  it('keeps the address of a link only, and drops the line-wrap boxes the reader never prints', () => {
    const url = { name: 'url', value: { type: 'url', value: 'https://a.test/x' } };
    const nodes = slimAxNodes([
      { nodeId: '1', role: { value: 'link' }, name: { value: 'Go' }, properties: [url] },
      { nodeId: '2', role: { value: 'image' }, name: { value: 'Pic' }, properties: [url] },
      { nodeId: '3', role: { value: 'InlineTextBox' }, name: { value: 'Go' } },
    ]);
    expect(nodes.map((node) => node.id)).toEqual(['1', '2']);
    expect(nodes[0]?.props?.url).toBe('https://a.test/x');
    expect(nodes[1]?.props).toBeUndefined();
  });
});

const MAIN = 'F-main';
const ORIGIN = 'http://a.test';

function raw(nodeId: string, role: string, name: string, childIds: string[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { nodeId, ignored: false, role: { value: role }, name: { value: name }, childIds, ...extra };
}

function policy(frames: Record<string, string | undefined>, owners: Record<number, string | undefined> = {}): FramePolicy {
  return {
    origin: ORIGIN,
    mainFrameId: MAIN,
    frames: new Map(Object.entries(frames).map(([id, origin]) => [id, { origin }])),
    ownerOrigin: async (backendId) => owners[backendId],
  };
}

const names = (nodes: unknown[]): string[] => nodes.map((node) => (node as { name?: { value?: string } }).name?.value ?? '');

describe('keeping the accessibility tree to the page\'s own origin', () => {
  it('drops the tree of a cross-origin child frame and says which origin it left out', async () => {
    const nodes = await restrictToOriginFrames(
      [
        raw('1', 'RootWebArea', 'Main', ['2', '3'], { frameId: MAIN }),
        raw('2', 'button', 'Main button'),
        raw('3', 'Iframe', 'ad', ['4'], { backendDOMNodeId: 30 }),
        raw('4', 'RootWebArea', 'Other page', ['5'], { frameId: 'F-other' }),
        raw('5', 'StaticText', 'SECRET from the other origin'),
      ],
      policy({ [MAIN]: ORIGIN, 'F-other': 'http://b.test' }),
    );
    expect(names(nodes)).not.toContain('SECRET from the other origin');
    expect(names(nodes)).not.toContain('Other page');
    expect(names(nodes)).toContain('frame omitted: http://b.test');
    const slim = slimAxNodes(nodes);
    expect(slim.find((node) => node.name === 'frame omitted: http://b.test')).toMatchObject({ role: 'group', children: [] });
    expect(slim.find((node) => node.role === 'Iframe')?.children).toHaveLength(1);
  });

  it('keeps a same-origin child frame, but not one nested inside a cross-origin frame', async () => {
    const nodes = await restrictToOriginFrames(
      [
        raw('1', 'RootWebArea', 'Main', ['2', '3'], { frameId: MAIN }),
        raw('2', 'Iframe', 'same', ['4']),
        raw('4', 'RootWebArea', 'Same origin frame', ['6'], { frameId: 'F-same' }),
        raw('6', 'button', 'Inside same'),
        raw('3', 'Iframe', 'cross', ['5']),
        raw('5', 'RootWebArea', 'Cross', ['7'], { frameId: 'F-cross' }),
        raw('7', 'Iframe', 'nested', ['8']),
        raw('8', 'RootWebArea', 'Back to our origin, inside the cross frame', ['9'], { frameId: 'F-nested' }),
        raw('9', 'StaticText', 'nested secret'),
      ],
      policy({ [MAIN]: ORIGIN, 'F-same': ORIGIN, 'F-cross': 'http://b.test', 'F-nested': ORIGIN }),
    );
    expect(names(nodes)).toContain('Inside same');
    expect(names(nodes)).not.toContain('nested secret');
    expect(names(nodes).filter((name) => name.startsWith('frame omitted'))).toEqual(['frame omitted: http://b.test']);
  });

  it('names a frame the browser cannot place as an unknown origin', async () => {
    const nodes = await restrictToOriginFrames(
      [raw('1', 'RootWebArea', 'Main', ['2'], { frameId: MAIN }), raw('2', 'Iframe', 'x', ['3']), raw('3', 'RootWebArea', 'X', [], { frameId: 'F-lost' })],
      policy({ [MAIN]: ORIGIN }),
    );
    expect(names(nodes)).toContain('frame omitted: unknown origin');
  });

  it('marks an empty iframe by the origin of the frame it holds, and stays quiet for a same-origin one', async () => {
    const nodes = await restrictToOriginFrames(
      [
        raw('1', 'RootWebArea', 'Main', ['2', '3', '4'], { frameId: MAIN }),
        raw('2', 'Iframe', 'cross', [], { backendDOMNodeId: 20 }),
        raw('3', 'Iframe', 'same', [], { backendDOMNodeId: 30 }),
        raw('4', 'Iframe', 'opaque', [], { backendDOMNodeId: 40 }),
      ],
      policy({ [MAIN]: ORIGIN }, { 20: 'http://b.test', 30: ORIGIN, 40: '://' }),
    );
    expect(names(nodes).filter((name) => name.startsWith('frame omitted'))).toEqual([
      'frame omitted: http://b.test',
      'frame omitted: unknown origin',
    ]);
  });

  it('shortens a page full of frames to the first marks and a count', async () => {
    const iframes = Array.from({ length: 60 }, (_, index) => raw(`f${index}`, 'Iframe', `ad ${index}`, [], { backendDOMNodeId: 100 + index }));
    const owners = Object.fromEntries(iframes.map((_, index) => [100 + index, 'http://ads.test']));
    const nodes = await restrictToOriginFrames(
      [raw('1', 'RootWebArea', 'Main', iframes.map((frame) => frame.nodeId as string), { frameId: MAIN }), ...iframes],
      policy({ [MAIN]: ORIGIN }, owners),
    );
    const marks = names(nodes).filter((name) => name.includes('omitted'));
    expect(marks).toHaveLength(51);
    expect(marks.at(-1)).toBe('10 more frames omitted');
  });

  it('leaves a page without child frames as it was, and drops nodes the root does not reach', async () => {
    const nodes = await restrictToOriginFrames(
      [raw('1', 'RootWebArea', 'Main', ['2'], { frameId: MAIN }), raw('2', 'button', 'OK'), raw('9', 'StaticText', 'orphan')],
      policy({ [MAIN]: ORIGIN }),
    );
    expect(names(nodes)).toEqual(['Main', 'OK']);
    expect(await restrictToOriginFrames('nonsense', policy({}))).toEqual([]);
  });
});
