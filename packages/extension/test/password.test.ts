import { describe, expect, it } from 'vitest';

import { slimAxNodes } from '../src/ax';
import { redactPasswordValues } from '../src/password';

type Raw = Record<string, unknown>;

interface Spec {
  id: string;
  role?: string;
  name?: string;
  value?: string | number;
  /** The DOM node id; every node gets one unless `backend` is `null`. */
  backend?: number | null;
  children?: string[];
  ignored?: boolean;
  /** Nodes the name was built from through aria-labelledby (or a script's `ariaLabelledByElements`). */
  labelledBy?: number[];
  /** Nodes the name was built from through `<label for>`. */
  labelFor?: number[];
  /** Related nodes of a source the browser set aside. */
  supersededBy?: number[];
}

let nextBackend = 1000;

function node(spec: Spec): Raw {
  const sources: Raw[] = [];
  if (spec.labelledBy !== undefined) {
    sources.push({
      type: 'relatedElement',
      attribute: 'aria-labelledby',
      attributeValue: { type: 'idrefList', relatedNodes: spec.labelledBy.map((id) => ({ backendDOMNodeId: id })) },
    });
  }
  if (spec.labelFor !== undefined) {
    sources.push({
      type: 'relatedElement',
      nativeSource: 'labelfor',
      nativeSourceValue: { type: 'nodeList', relatedNodes: spec.labelFor.map((id) => ({ backendDOMNodeId: id })) },
    });
  }
  if (spec.supersededBy !== undefined) {
    sources.push({
      type: 'relatedElement',
      attribute: 'aria-labelledby',
      superseded: true,
      attributeValue: { type: 'idrefList', relatedNodes: spec.supersededBy.map((id) => ({ backendDOMNodeId: id })) },
    });
  }
  const result: Raw = {
    nodeId: spec.id,
    ignored: spec.ignored === true,
    role: { type: 'role', value: spec.role ?? 'generic' },
    name: { type: 'computedString', value: spec.name ?? '', sources },
    childIds: spec.children ?? [],
  };
  if (spec.value !== undefined) result.value = { type: 'string', value: spec.value };
  if (spec.backend !== null) result.backendDOMNodeId = spec.backend ?? (nextBackend += 1);
  return result;
}

const flagAll = async (ids: number[]): Promise<boolean[]> => ids.map(() => true);
const flagNone = async (ids: number[]): Promise<boolean[]> => ids.map(() => false);
const flagOnly = (...backends: number[]) => async (ids: number[]): Promise<boolean[]> => ids.map((id) => backends.includes(id));

const field = (id: string, backend: number, value: string, extra: Partial<Spec> = {}): Raw =>
  node({ id, role: 'textbox', name: `Field ${id}`, value, backend, ...extra });

const byId = (nodes: unknown[], id: string): Raw => {
  const found = (nodes as Raw[]).find((item) => item.nodeId === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};
const nameOf = (nodes: unknown[], id: string): string => (byId(nodes, id).name as { value: string }).value;
const valueOf = (nodes: unknown[], id: string): unknown => (byId(nodes, id).value as { value: unknown } | undefined)?.value;
const isRedacted = (nodes: unknown[], id: string): boolean => byId(nodes, id).t3Password === true && byId(nodes, id).value === undefined;

describe('password redaction', () => {
  it('redacts masked fields beyond the first 200 without inspecting them', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => field(String(index + 1), index + 1, '••••••••'));
    let inspections = 0;
    const result = await redactPasswordValues(nodes, async (ids) => {
      inspections += 1;
      return ids.map(() => false);
    });
    expect(inspections).toBe(0);
    expect(result.every((item) => (item as Raw).value === undefined && (item as Raw).t3Password === true)).toBe(true);
  });

  it('inspects every unmasked field in batches and redacts a password after field 200', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => field(String(index + 1), index + 1, `text-${index + 1}`));
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
        expect(ids.length).toBeLessThanOrEqual(10);
        return ids.map((id) => id === 240);
      },
      10,
    );
    expect(inspected).toHaveLength(260);
    expect(maximumActive).toBe(1);
    expect(isRedacted(nodes, '240')).toBe(true);
    expect(valueOf(nodes, '241')).toBe('text-241');
  });

  it('fails closed when a batch cannot be inspected, or the inspector has no answer for a field', async () => {
    const thrown = [field('1', 1, 'possibly secret')];
    await redactPasswordValues(thrown, async () => {
      throw new Error('DOM unavailable');
    });
    expect(isRedacted(thrown, '1')).toBe(true);
    const silent = [field('2', 2, 'possibly secret')];
    await redactPasswordValues(silent, async () => []);
    expect(isRedacted(silent, '2')).toBe(true);
    const unanswered = [field('3', 3, 'possibly secret')];
    await redactPasswordValues(unanswered, async (ids) => ids.map(() => undefined));
    expect(isRedacted(unanswered, '3')).toBe(true);
  });

  it('redacts a field with no DOM node to inspect', async () => {
    const orphan = [field('1', 0, 'secret', { backend: null })];
    await redactPasswordValues(orphan, async () => []);
    expect(isRedacted(orphan, '1')).toBe(true);
  });

  it.each(['combobox', 'searchbox', 'spinbutton', 'slider', 'button', 'generic', 'img', 'menuitem'])(
    'redacts the bullets of a password input the page gave the role %s, and the bullet text under it',
    async (role) => {
      const nodes = [
        node({ id: '1', role, name: 'Field', value: '•••••••••', children: ['b'] }),
        node({ id: 'b', role: 'StaticText', name: '•••••••••' }),
        node({ id: 'k', role: 'StaticText', name: 'Label' }),
      ];
      const result = await redactPasswordValues(nodes, flagNone);
      expect((result as Raw[]).map((item) => item.nodeId)).toEqual(['1', 'k']);
      expect(isRedacted(result, '1')).toBe(true);
      expect(byId(result, '1').childIds).toEqual([]);
    },
  );

  it.each(['combobox', 'searchbox', 'spinbutton', 'slider'])(
    'asks about a %s the browser gives a plain value, and redacts it when it is a password input',
    async (role) => {
      const nodes = [
        node({ id: '7', role, value: 0, backend: 7 }),
        node({ id: '8', role, value: 'visible', backend: 8 }),
      ];
      const asked: number[][] = [];
      await redactPasswordValues(nodes, async (ids) => {
        asked.push(ids);
        return ids.map((id) => id === 7);
      });
      expect(asked).toEqual([[7, 8]]);
      expect(isRedacted(nodes, '7')).toBe(true);
      expect(valueOf(nodes, '8')).toBe('visible');
      expect(byId(nodes, '8').t3Password).toBeUndefined();
    },
  );

  it('leaves a node that is not a field and has no bullet value alone', async () => {
    const heading = [node({ id: '1', role: 'heading', name: 'Title', value: 'Title' })];
    let inspections = 0;
    await redactPasswordValues(heading, async (ids) => {
      inspections += 1;
      return ids.map(() => true);
    });
    expect(inspections).toBe(0);
    expect(valueOf(heading, '1')).toBe('Title');
  });

  it('keeps an empty password field marked, so the agent can tell it apart from a text box', async () => {
    const empty = [node({ id: '1', role: 'textbox', name: 'Password', backend: 1 })];
    await redactPasswordValues(empty, flagAll);
    expect(byId(empty, '1').t3Password).toBe(true);
  });

  describe('what the trimmed tree sends', () => {
    it('marks a redacted field and drops the values of roles the reader never prints', () => {
      const redactedField = field('1', 1, 'secret');
      redactedField.t3Password = true;
      delete redactedField.value;
      const trimmed = slimAxNodes([
        redactedField,
        node({ id: '2', role: 'button', name: 'Pay', value: '4242' }),
        node({ id: '3', role: 'checkbox', name: 'Agree', value: 'on' }),
        node({ id: '4', role: 'textbox', name: 'Name', value: 'Ada' }),
      ]);
      expect(trimmed.map((item) => [item.id, item.value, item.props?.password])).toEqual([
        ['1', undefined, true],
        ['2', undefined, undefined],
        ['3', undefined, undefined],
        ['4', 'Ada', undefined],
      ]);
    });
  });

  describe('names the browser builds from a hidden value', () => {
    it('replaces the value in the name of each element the field sits in, and leaves other names alone', async () => {
      const nodes = [
        node({ id: 'root', role: 'RootWebArea', name: 'Shop', children: ['cell', 'other'] }),
        node({ id: 'cell', role: 'cell', name: 'Cell 4242 and 4242 again', children: ['button'] }),
        node({ id: 'button', role: 'button', name: 'Pay 4242', children: ['pin'] }),
        field('pin', 5, '4242'),
        node({ id: 'other', role: 'link', name: 'Item 4242 elsewhere' }),
      ];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
      expect(nameOf(nodes, 'cell')).toBe('Cell <redacted> and <redacted> again');
      expect(nameOf(nodes, 'other')).toBe('Item 4242 elsewhere');
      expect(nameOf(nodes, 'root')).toBe('Shop');
    });

    it('replaces the bullets of a password input in the name of what it sits in', async () => {
      const nodes = [
        node({ id: 'tab', role: 'tab', name: 'Tab •••••••••', children: ['pw'] }),
        node({ id: 'pw', role: 'combobox', name: 'Field', value: '•••••••••' }),
      ];
      await redactPasswordValues(nodes, flagNone);
      expect(nameOf(nodes, 'tab')).toBe('Tab <redacted>');
    });

    it('finds a name built from the field by the nodes the tree says it came from, scripts and labels included', async () => {
      const nodes = [
        field('pin', 5, '4242'),
        node({ id: 'viaAttribute', role: 'button', name: 'Card 4242', labelledBy: [5] }),
        node({ id: 'viaScript', role: 'button', name: '4242', labelledBy: [5] }),
        node({ id: 'viaLabelFor', role: 'textbox', name: 'Lbl 4242', labelFor: [5] }),
        node({ id: 'elsewhere', role: 'button', name: 'Visible 4242', labelledBy: [999] }),
        node({ id: 'plain', role: 'button', name: 'Buy', labelledBy: [998] }),
        node({ id: 'label', role: 'generic', name: 'Label', backend: 998 }),
        node({ id: 'other', role: 'generic', name: 'Other', backend: 999 }),
      ];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'viaAttribute')).toBe('Card <redacted>');
      expect(nameOf(nodes, 'viaScript')).toBe('<redacted>');
      expect(nameOf(nodes, 'viaLabelFor')).toBe('Lbl <redacted>');
      expect(nameOf(nodes, 'elsewhere')).toBe('Visible 4242');
      expect(nameOf(nodes, 'plain')).toBe('Buy');
    });

    it('treats a name built from an element around the field as built from the field, even when that element is ignored', async () => {
      const nodes = [
        node({ id: 'host', role: 'generic', ignored: true, backend: 50, children: ['inner'] }),
        node({ id: 'inner', role: 'generic', ignored: true, backend: 51, children: ['pin'] }),
        field('pin', 5, 'SHADOWPIN1'),
        node({ id: 'button', role: 'button', name: 'PIN SHADOWPIN1', labelledBy: [50] }),
        node({ id: 'closed', role: 'button', name: 'SHADOWPIN1', labelledBy: [51] }),
      ];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'button')).toBe('PIN <redacted>');
      expect(nameOf(nodes, 'closed')).toBe('<redacted>');
    });

    it('replaces the whole name when the value is not found in it', async () => {
      const nodes = [field('pin', 5, '4242'), node({ id: 'button', role: 'button', name: 'Number forty-two', labelledBy: [5] })];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
    });

    it('replaces the whole name when a node it was built from is not in the tree', async () => {
      const nodes = [
        field('pin', 5, '4242'),
        node({ id: 'button', role: 'button', name: 'Hidden label text', labelledBy: [777] }),
        node({ id: 'link', role: 'link', name: 'Fine', labelledBy: [5000] }),
      ];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
      // Every name built from something the tree does not hold is as unknown as that one.
      expect(nameOf(nodes, 'link')).toBe('<redacted>');
    });

    it('leaves names alone when no field was redacted', async () => {
      const nodes = [field('name', 5, 'Ada'), node({ id: 'button', role: 'button', name: 'Hello Ada', labelledBy: [777] })];
      await redactPasswordValues(nodes, flagNone);
      expect(nameOf(nodes, 'button')).toBe('Hello Ada');
    });

    it('ignores a source the browser set aside', async () => {
      const nodes = [field('pin', 5, '4242'), node({ id: 'button', role: 'button', name: 'Pay 4242', supersededBy: [5] })];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'button')).toBe('Pay 4242');
    });

    it('scrubs every element named from the field, with no limit on how many', async () => {
      const buttons = Array.from({ length: 205 }, (_, index) => node({ id: `b${index}`, role: 'button', name: 'Card 4242', labelledBy: [5] }));
      const nodes = [field('pin', 5, '4242'), ...buttons];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(buttons.every((button) => (button.name as { value: string }).value === 'Card <redacted>')).toBe(true);
    });

    it('takes a value longer than the reader keeps whole, so no tail is left in a name', async () => {
      const secret = `${'0123456789'.repeat(26)}`;
      const nodes = [
        node({ id: 'button', role: 'button', name: `Pay ${secret} now`, children: ['pin'] }),
        field('pin', 5, secret),
      ];
      const result = await redactPasswordValues(nodes, flagOnly(5));
      const trimmed = slimAxNodes(result);
      expect(trimmed.find((item) => item.id === 'button')?.name).toBe('Pay <redacted> now');
      expect(JSON.stringify(trimmed)).not.toContain('0123456789');
    });

    it('does not take its own label for the field: the label around a field leaves the field alone, a field naming itself does not', async () => {
      const nodes = [
        node({ id: 'label', role: 'LabelText', backend: 60, name: '', children: ['code'] }),
        node({ id: 'code', role: 'textbox', name: 'Code', value: 'e', backend: 5, labelFor: [60] }),
        node({ id: 'selfish', role: 'textbox', name: '•••', value: '•••', backend: 6, labelledBy: [6] }),
      ];
      await redactPasswordValues(nodes, flagOnly(5));
      expect(nameOf(nodes, 'code')).toBe('Code');
      expect(nameOf(nodes, 'selfish')).toBe('<redacted>');
    });

    it('replaces all values in one pass, longest first, and never inside its own marker', async () => {
      const nodes = [
        node({ id: 'group', role: 'group', name: 'Pay re 12 1234 d', children: ['a', 'b', 'c', 'd'] }),
        field('a', 1, 're'),
        field('b', 2, 'd'),
        field('c', 3, '12'),
        field('d', 4, '1234'),
      ];
      await redactPasswordValues(nodes, flagAll);
      expect(nameOf(nodes, 'group')).toBe('Pay <redacted> <redacted> <redacted> <redacted>');
    });

    it('replaces a value with special characters or spaces as the name shows it', async () => {
      const nodes = [
        node({ id: 'group', role: 'group', name: 'Codes 12  34.*+ and 1234', children: ['a', 'b'] }),
        field('a', 1, '12  34.*+'),
        field('b', 2, '1234'),
      ];
      await redactPasswordValues(nodes, flagAll);
      expect(nameOf(nodes, 'group')).toBe('Codes <redacted> and <redacted>');
    });

    it('replaces a short value only as a whole word, so other names and words keep their text', async () => {
      const nodes = [
        node({ id: 'button', role: 'button', name: 'Pay e', children: ['pin'] }),
        node({ id: 'link', role: 'link', name: 'Item 142 and a cell', children: ['pin2'] }),
        field('pin', 5, 'e', { name: 'Code' }),
        field('pin2', 6, '42'),
        node({ id: 'page', role: 'heading', name: 'Page 42 of 142' }),
      ];
      await redactPasswordValues(nodes, flagAll);
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
      expect(nameOf(nodes, 'pin')).toBe('Code');
      expect(nameOf(nodes, 'link')).toBe('Item 142 and a cell');
      expect(nameOf(nodes, 'page')).toBe('Page 42 of 142');
    });

    it('looks for values only of fields known to be secret, never of one it could not check', async () => {
      const nodes = [
        node({ id: 'button', role: 'button', name: 'Pay 4242', children: ['pin'] }),
        node({ id: 'other', role: 'button', name: 'Pay 5252', children: ['gone'] }),
        field('pin', 5, '4242'),
        field('gone', 6, '5252'),
      ];
      await redactPasswordValues(nodes, async (ids) => ids.map((id) => (id === 5 ? true : undefined)));
      expect(isRedacted(nodes, 'gone')).toBe(true);
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
      expect(nameOf(nodes, 'other')).toBe('Pay 5252');
    });

    it('does not scrub names of a page whose fields were not secret', async () => {
      const nodes = [
        node({ id: 'page', role: 'main', name: 'Checkout 1 of 3', children: ['qty'] }),
        field('qty', 5, '1'),
      ];
      await redactPasswordValues(nodes, flagNone);
      expect(nameOf(nodes, 'page')).toBe('Checkout 1 of 3');
    });
  });
});
