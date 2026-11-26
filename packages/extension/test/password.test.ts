import type { AxNode } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { redactPasswordValues } from '../src/password';

function field(id: number, value: string, role = 'textbox'): AxNode {
  return { id: String(id), role, name: `Field ${id}`, value, backendId: id, children: [] };
}

const textbox = (id: number, value: string): AxNode => field(id, value);

describe('password redaction', () => {
  it('redacts masked fields beyond the first 200 without inspecting them', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => textbox(index + 1, '••••••••'));
    let inspections = 0;
    const result = await redactPasswordValues(nodes, async (ids) => {
      inspections += 1;
      return ids.map(() => false);
    });
    expect(inspections).toBe(0);
    expect(result.every((node) => node.value === undefined && node.props?.password === true)).toBe(true);
  });

  it('inspects every unmasked field in batches and redacts a password after field 200', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => textbox(index + 1, `text-${index + 1}`));
    let active = 0;
    let maximumActive = 0;
    const inspected: number[] = [];
    await redactPasswordValues(
      nodes,
      async (ids) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        inspected.push(...ids);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return ids.map((id) => id === 240);
      },
      { batchSize: 10 },
    );
    expect(inspected).toHaveLength(260);
    expect(maximumActive).toBe(1);
    expect(nodes[239]).toMatchObject({ props: { password: true } });
    expect(nodes[239]?.value).toBeUndefined();
    expect(nodes[240]?.value).toBe('text-241');
  });

  it('fails closed when a batch cannot be inspected', async () => {
    const node = textbox(1, 'possibly secret');
    await redactPasswordValues([node], async () => {
      throw new Error('DOM unavailable');
    });
    expect(node.value).toBeUndefined();
    expect(node.props?.password).toBe(true);
  });

  it('fails closed for a field the inspector gives no answer for', async () => {
    const node = textbox(1, 'possibly secret');
    await redactPasswordValues([node], async () => []);
    expect(node.value).toBeUndefined();
    expect(node.props?.password).toBe(true);
  });

  it('redacts a field with no DOM node to inspect', async () => {
    const node: AxNode = { id: '1', role: 'textbox', name: 'Orphan', value: 'secret', children: [] };
    await redactPasswordValues([node], async () => []);
    expect(node.value).toBeUndefined();
    expect(node.props?.password).toBe(true);
  });

  it.each(['combobox', 'searchbox', 'spinbutton', 'slider', 'button', 'generic', 'img', 'menuitem'])(
    'redacts the bullets of a password input the page gave the role %s, and the bullet text under it',
    async (role) => {
      const bullets: AxNode = { id: 'b', role: 'StaticText', name: '•••••••••', children: [] };
      const node = { ...field(1, '•••••••••', role), children: ['b'] };
      const kept: AxNode = { id: 'k', role: 'StaticText', name: 'Label', children: [] };
      const result = await redactPasswordValues([node, bullets, kept], async (ids) => ids.map(() => false));
      expect(result.map((item) => item.id)).toEqual(['1', 'k']);
      expect(node.value).toBeUndefined();
      expect(node.children).toEqual([]);
      expect(node.props?.password).toBe(true);
    },
  );

  it.each(['combobox', 'searchbox', 'spinbutton', 'slider'])(
    'asks about a %s the browser gives a plain value, and redacts it when it is a password input',
    async (role) => {
      const node = field(7, '0', role);
      const text = field(8, 'visible', role);
      const asked: number[][] = [];
      await redactPasswordValues([node, text], async (ids) => {
        asked.push(ids);
        return ids.map((id) => id === 7);
      });
      expect(asked).toEqual([[7, 8]]);
      expect(node.value).toBeUndefined();
      expect(node.props?.password).toBe(true);
      expect(text.value).toBe('visible');
      expect(text.props).toBeUndefined();
    },
  );

  it('redacts a text field that a style masks, wherever its text sits', async () => {
    const pin = textbox(1, '4242');
    const typed = textbox(2, 'Ada');
    await redactPasswordValues([pin, typed], async (ids) => ids.map((id) => id === 1));
    expect(pin.value).toBeUndefined();
    expect(pin.props?.password).toBe(true);
    expect(typed.value).toBe('Ada');
  });

  it('leaves an element without a field role or bullet value alone', async () => {
    const heading: AxNode = { id: '1', role: 'heading', name: 'Title', value: 'Title', children: [] };
    let inspections = 0;
    await redactPasswordValues([heading], async (ids) => {
      inspections += 1;
      return ids.map(() => true);
    });
    expect(inspections).toBe(0);
    expect(heading.value).toBe('Title');
    expect(heading.props).toBeUndefined();
  });

  it('keeps an empty password field marked, so the agent can tell it apart from a text box', async () => {
    const empty: AxNode = { id: '1', role: 'textbox', name: 'Password', backendId: 1, children: [] };
    await redactPasswordValues([empty], async (ids) => ids.map(() => true));
    expect(empty.props?.password).toBe(true);
  });

  describe('names the browser builds from a hidden value', () => {
    const named = (id: string, role: string, name: string, children: string[] = [], backendId?: number): AxNode => ({
      id,
      role,
      name,
      children,
      ...(backendId === undefined ? {} : { backendId }),
    });
    const inspectNothing = async (ids: number[]): Promise<boolean[]> => ids.map(() => false);

    it('replaces the value in the name of each element the field sits in', async () => {
      const pin = { ...textbox(5, '4242'), id: 'pin' };
      const button = named('button', 'button', 'Pay 4242', ['pin']);
      const cell = named('cell', 'cell', 'Cell 4242 and 4242 again', ['button']);
      const unrelated = named('other', 'link', 'Item 4242 elsewhere');
      const root = named('root', 'RootWebArea', 'Shop', ['cell', 'other']);
      const result = await redactPasswordValues([root, cell, button, pin, unrelated], async (ids) => ids.map((id) => id === 5), {
        namedFrom: async () => [],
      });
      expect(result.find((node) => node.id === 'button')?.name).toBe('Pay <redacted>');
      expect(result.find((node) => node.id === 'cell')?.name).toBe('Cell <redacted> and <redacted> again');
      // Only the field's own ancestors are searched; an element elsewhere keeps its name unless it is named from the field.
      expect(unrelated.name).toBe('Item 4242 elsewhere');
      expect(root.name).toBe('Shop');
    });

    it('replaces the bullets of a password input in the name of what it sits in', async () => {
      const password = { ...field(1, '•••••••••', 'combobox'), id: 'pw' };
      const tab = named('tab', 'tab', 'Tab •••••••••', ['pw']);
      const result = await redactPasswordValues([tab, password], inspectNothing);
      expect(result.find((node) => node.id === 'tab')?.name).toBe('Tab <redacted>');
    });

    it('replaces the value in the name of an element named from the field, and the whole name when it is not found', async () => {
      const pin = textbox(5, '4242');
      const labelled = named('l1', 'button', 'Card 4242', [], 10);
      const changed = named('l2', 'group', 'something else entirely', [], 11);
      const stranger = named('l3', 'button', 'Visible 4242', [], 12);
      const asked: number[][] = [];
      await redactPasswordValues([pin, labelled, changed, stranger], async (ids) => ids.map(() => true), {
        namedFrom: async (ids) => {
          asked.push(ids);
          return [10, 11];
        },
      });
      expect(asked).toEqual([[5]]);
      expect(labelled.name).toBe('Card <redacted>');
      expect(changed.name).toBe('<redacted>');
      expect(stranger.name).toBe('Visible 4242');
    });

    it('does not ask the page about names when nothing was redacted or the field is empty', async () => {
      let asked = 0;
      const namedFrom = async (): Promise<number[]> => {
        asked += 1;
        return [];
      };
      await redactPasswordValues([textbox(1, 'visible')], inspectNothing, { namedFrom });
      const empty: AxNode = { id: '2', role: 'textbox', name: 'Password', backendId: 2, children: [] };
      await redactPasswordValues([empty], async (ids) => ids.map(() => true), { namedFrom });
      expect(asked).toBe(0);
    });

    it('treats every name as possibly holding the value when the page cannot say which are named from the field', async () => {
      const pin = textbox(5, '424242');
      const far = named('far', 'button', 'Number 424242', [], 20);
      const safe = named('safe', 'button', 'Pay now', [], 21);
      await redactPasswordValues([pin, far, safe], async (ids) => ids.map(() => true), {
        namedFrom: async () => {
          throw new Error('page unavailable');
        },
      });
      expect(far.name).toBe('Number <redacted>');
      expect(safe.name).toBe('Pay now');
    });

    it('replaces a value that has special characters or spaces as the name shows it, and the longer value first', async () => {
      const first = { ...textbox(1, '12  34.*'), id: 'a' };
      const second = { ...textbox(2, '1234'), id: 'b' };
      const group = named('g', 'group', 'Codes 12 34.* and 1234', ['a', 'b']);
      await redactPasswordValues([group, first, second], async (ids) => ids.map(() => true));
      expect(group.name).toBe('Codes <redacted> and <redacted>');
    });

    it("hides a field's own name when it is named by itself", async () => {
      const self: AxNode = { id: '1', role: 'textbox', name: '•••', value: '•••', backendId: 1, children: [] };
      await redactPasswordValues([self], inspectNothing);
      expect(self.name).toBe('<redacted>');
    });
  });
});
