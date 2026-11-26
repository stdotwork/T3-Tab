import { describe, expect, it } from 'vitest';

import { slimAxNodes } from '../src/ax';
import { redactPasswordValues, type FieldAnswer, type InspectFields } from '../src/password';

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
  /** The name is built from the node's content. */
  contents?: boolean;
  /** The address of a link. */
  url?: string;
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
  if (spec.contents === true) sources.push({ type: 'contents', value: { type: 'computedString', value: spec.name ?? '' } });
  const result: Raw = {
    nodeId: spec.id,
    ignored: spec.ignored === true,
    role: { type: 'role', value: spec.role ?? 'generic' },
    name: { type: 'computedString', value: spec.name ?? '', sources },
    childIds: spec.children ?? [],
  };
  if (spec.value !== undefined) result.value = { type: 'string', value: spec.value };
  if (spec.url !== undefined) result.properties = [{ name: 'url', value: { type: 'string', value: spec.url } }];
  if (spec.backend !== null) result.backendDOMNodeId = spec.backend ?? (nextBackend += 1);
  return result;
}

const secret = (value?: string): FieldAnswer => ({ secret: true, value });
const plain: FieldAnswer = { secret: false };
/** An inspector that gives the answer set for a DOM id, and `plain` for any other. */
const answering = (answers: Record<number, FieldAnswer | undefined>): InspectFields => async (ids) =>
  ids.map((id) => (id in answers ? answers[id] : plain));
const allSecret: InspectFields = async (ids) => ids.map(() => secret());
const nonSecret: InspectFields = async (ids) => ids.map(() => plain);

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
  it('redacts masked fields whatever the page says, and still asks about them for what they hold', async () => {
    const nodes = Array.from({ length: 260 }, (_, index) => field(String(index + 1), index + 1, '••••••••'));
    let asked = 0;
    const result = await redactPasswordValues(nodes, async (ids) => {
      asked += ids.length;
      return ids.map(() => plain);
    });
    expect(asked).toBe(260);
    expect(result.every((item) => (item as Raw).value === undefined && (item as Raw).t3Password === true)).toBe(true);
  });

  it('inspects every field in batches and redacts a password after field 200', async () => {
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
        return ids.map((id) => (id === 240 ? secret() : plain));
      },
      { batchSize: 10 },
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

  it('lets an error the caller names stop the read instead of redacting', async () => {
    class Stop extends Error {}
    const nodes = [field('1', 1, 'text')];
    await expect(
      redactPasswordValues(
        nodes,
        async () => {
          throw new Stop('a dialog opened');
        },
        { rethrow: (error) => error instanceof Stop },
      ),
    ).rejects.toThrow('a dialog opened');
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
      const result = await redactPasswordValues(nodes, nonSecret);
      expect((result as Raw[]).map((item) => item.nodeId)).toEqual(['1', 'k']);
      expect(isRedacted(result, '1')).toBe(true);
      expect(byId(result, '1').childIds).toEqual([]);
    },
  );

  it.each(['link', 'checkbox', 'switch', 'button', 'menuitem'])(
    'inspects a %s that holds a value and redacts it when it is a secret field, whatever role the page gave it',
    async (role) => {
      const nodes = [
        node({ id: '1', role, name: 'Field', value: 'CARD-4242-4242', backend: 7 }),
        node({ id: '2', role, name: 'Other', value: 'visible', backend: 8 }),
      ];
      const asked: number[][] = [];
      await redactPasswordValues(nodes, async (ids) => {
        asked.push(ids);
        return ids.map((id) => (id === 7 ? secret('CARD-4242-4242') : plain));
      });
      expect(asked).toEqual([[7, 8]]);
      expect(isRedacted(nodes, '1')).toBe(true);
      expect(valueOf(nodes, '2')).toBe('visible');
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
        return ids.map((id) => (id === 7 ? secret() : plain));
      });
      expect(asked).toEqual([[7, 8]]);
      expect(isRedacted(nodes, '7')).toBe(true);
      expect(valueOf(nodes, '8')).toBe('visible');
      expect(byId(nodes, '8').t3Password).toBeUndefined();
    },
  );

  it('leaves a node that holds a value but is not a secret alone', async () => {
    const heading = [node({ id: '1', role: 'heading', name: 'Title', value: 'Title', backend: 1 })];
    await redactPasswordValues(heading, nonSecret);
    expect(valueOf(heading, '1')).toBe('Title');
    expect(byId(heading, '1').t3Password).toBeUndefined();
  });

  it('keeps an empty password field marked, so the agent can tell it apart from a text box', async () => {
    const empty = [node({ id: '1', role: 'textbox', name: 'Password', backend: 1 })];
    await redactPasswordValues(empty, allSecret);
    expect(byId(empty, '1').t3Password).toBe(true);
  });

  it('returns the tree as it was when no field holds a secret', async () => {
    const nodes = [field('1', 1, 'Ada'), node({ id: 'b', role: 'button', name: 'Hello Ada', labelledBy: [777] })];
    const result = await redactPasswordValues(nodes, nonSecret);
    expect(result).toBe(nodes);
    expect(nameOf(nodes, 'b')).toBe('Hello Ada');
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
      await redactPasswordValues(nodes, answering({ 5: secret('4242') }));
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
      expect(nameOf(nodes, 'cell')).toBe('Cell <redacted> and <redacted> again');
      expect(nameOf(nodes, 'root')).toBe('Shop');
      // Not tied to the field, but the secret is known: the net takes it out of every name.
      expect(nameOf(nodes, 'other')).toBe('Item <redacted> elsewhere');
    });

    it('replaces the bullets of a password input in the name of what it sits in', async () => {
      const nodes = [
        node({ id: 'tab', role: 'tab', name: 'Tab •••••••••', children: ['pw'] }),
        node({ id: 'pw', role: 'combobox', name: 'Field', value: '•••••••••', backend: 3 }),
      ];
      await redactPasswordValues(nodes, nonSecret);
      expect(nameOf(nodes, 'tab')).toBe('Tab <redacted>');
    });

    it('finds a name built from the field by the nodes the tree says it came from, scripts and labels included', async () => {
      const nodes = [
        field('pin', 5, '4242'),
        node({ id: 'viaAttribute', role: 'button', name: 'Card 4242', labelledBy: [5] }),
        node({ id: 'viaScript', role: 'button', name: '4242', labelledBy: [5] }),
        node({ id: 'viaLabelFor', role: 'textbox', name: 'Lbl 4242', labelFor: [5] }),
        node({ id: 'elsewhere', role: 'button', name: 'Visible', labelledBy: [999] }),
        node({ id: 'plain', role: 'button', name: 'Buy', labelledBy: [998] }),
        node({ id: 'label', role: 'generic', name: 'Label', backend: 998 }),
        node({ id: 'other', role: 'generic', name: 'Other', backend: 999 }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('4242') }));
      expect(nameOf(nodes, 'viaAttribute')).toBe('Card <redacted>');
      expect(nameOf(nodes, 'viaScript')).toBe('<redacted>');
      expect(nameOf(nodes, 'viaLabelFor')).toBe('Lbl <redacted>');
      expect(nameOf(nodes, 'elsewhere')).toBe('Visible');
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
      await redactPasswordValues(nodes, answering({ 5: secret('SHADOWPIN1') }));
      expect(nameOf(nodes, 'button')).toBe('PIN <redacted>');
      expect(nameOf(nodes, 'closed')).toBe('<redacted>');
    });

    it('replaces the whole name when the value is not found in it', async () => {
      const nodes = [field('pin', 5, '4242'), node({ id: 'button', role: 'button', name: 'Number forty-two', labelledBy: [5] })];
      await redactPasswordValues(nodes, answering({ 5: secret('4242') }));
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
    });

    it('replaces the whole name when a node it was built from is not in the tree', async () => {
      const nodes = [
        field('pin', 5, '4242'),
        node({ id: 'button', role: 'button', name: 'Hidden label text', labelledBy: [777] }),
        node({ id: 'link', role: 'link', name: 'Fine', labelledBy: [5000] }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('4242') }));
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
      // Every name built from something the tree does not hold is as unknown as that one.
      expect(nameOf(nodes, 'link')).toBe('<redacted>');
    });

    it('ignores a source the browser set aside', async () => {
      const nodes = [field('pin', 5, '4242'), node({ id: 'button', role: 'button', name: 'Pay', supersededBy: [5] })];
      await redactPasswordValues(nodes, answering({ 5: secret('4242') }));
      expect(nameOf(nodes, 'button')).toBe('Pay');
    });

    it('scrubs every element named from the field, with no limit on how many', async () => {
      const buttons = Array.from({ length: 205 }, () => node({ id: `b${nextBackend}`, role: 'button', name: 'Card 4242', labelledBy: [5] }));
      const nodes = [field('pin', 5, '4242'), ...buttons];
      await redactPasswordValues(nodes, answering({ 5: secret('4242') }));
      expect(buttons.every((button) => (button.name as { value: string }).value === 'Card <redacted>')).toBe(true);
    });

    it('takes a value longer than the reader keeps whole, so no tail is left in a name', async () => {
      const long = '0123456789'.repeat(26);
      const nodes = [
        node({ id: 'button', role: 'button', name: `Pay ${long} now`, children: ['pin'] }),
        field('pin', 5, long),
      ];
      const result = await redactPasswordValues(nodes, answering({ 5: secret(long) }));
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
      await redactPasswordValues(nodes, answering({ 5: secret('e') }));
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
      await redactPasswordValues(nodes, allSecret);
      expect(nameOf(nodes, 'group')).toBe('Pay <redacted> <redacted> <redacted> <redacted>');
    });

    it('replaces a value with special characters or spaces as the name shows it', async () => {
      const nodes = [
        node({ id: 'group', role: 'group', name: 'Codes 12  34.*+ and 1234', children: ['a', 'b'] }),
        field('a', 1, '12  34.*+'),
        field('b', 2, '1234'),
      ];
      await redactPasswordValues(nodes, allSecret);
      expect(nameOf(nodes, 'group')).toBe('Codes <redacted> and <redacted>');
    });

    it('replaces a short value only as a whole word in the names tied to its field, and nowhere else', async () => {
      const nodes = [
        node({ id: 'button', role: 'button', name: 'Pay e', children: ['pin'] }),
        node({ id: 'link', role: 'link', name: 'Item 142 and a cell', children: ['pin2'] }),
        field('pin', 5, 'e', { name: 'Code' }),
        field('pin2', 6, '42'),
        node({ id: 'page', role: 'heading', name: 'Page 42 of 142 and free energy' }),
      ];
      await redactPasswordValues(nodes, allSecret);
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
      expect(nameOf(nodes, 'pin')).toBe('Code');
      expect(nameOf(nodes, 'link')).toBe('Item 142 and a cell');
      expect(nameOf(nodes, 'page')).toBe('Page 42 of 142 and free energy');
    });

    it('looks for the value of a field it could not check as well, since the field is hidden anyway', async () => {
      const nodes = [
        node({ id: 'button', role: 'button', name: 'Pay SECRETN2', children: ['gone'] }),
        field('gone', 6, 'SECRETN2'),
      ];
      await redactPasswordValues(nodes, async (ids) => ids.map(() => undefined));
      expect(isRedacted(nodes, 'gone')).toBe(true);
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
    });

    it('does not scrub names of a page whose fields were not secret', async () => {
      const nodes = [
        node({ id: 'page', role: 'main', name: 'Checkout 1 of 3', children: ['qty'] }),
        field('qty', 5, '1'),
      ];
      await redactPasswordValues(nodes, nonSecret);
      expect(nameOf(nodes, 'page')).toBe('Checkout 1 of 3');
    });
  });

  describe('fields out of sight, and values that travel', () => {
    it.each(['hidden', 'aria-hidden', 'display:none', 'closed dialog'])(
      'finds a secret field inside content a name was built from that is %s, though the tree ignores it',
      async () => {
        const nodes = [
          node({ id: 'div', ignored: true, backend: 50, children: ['text', 'input'] }),
          node({ id: 'text', ignored: true, backend: 51 }),
          node({ id: 'input', ignored: true, backend: 52 }),
          node({ id: 'button', role: 'button', name: 'Password Tr0ub4dor&3', labelledBy: [50] }),
          node({ id: 'plain', role: 'button', name: 'Sign in' }),
        ];
        const asked: number[] = [];
        await redactPasswordValues(nodes, async (ids) => {
          asked.push(...ids);
          return ids.map((id) => (id === 52 ? secret('Tr0ub4dor&3') : plain));
        });
        expect([...asked].sort()).toEqual([50, 51, 52]);
        expect(nameOf(nodes, 'button')).toBe('Password <redacted>');
        expect(nameOf(nodes, 'plain')).toBe('Sign in');
      },
    );

    it('does not ask about content nobody built a name from', async () => {
      const nodes = [node({ id: 'div', ignored: true, backend: 50, children: ['input'] }), node({ id: 'input', ignored: true, backend: 52 })];
      let asked = 0;
      await redactPasswordValues(nodes, async (ids) => {
        asked += ids.length;
        return ids.map(() => plain);
      });
      expect(asked).toBe(0);
    });

    it('hides names built from hidden content it could not look into, once it knows the page holds a secret', async () => {
      const crowd = Array.from({ length: 5 }, (_, index) => node({ id: `i${index}`, ignored: true, backend: 100 + index }));
      const nodes = [
        node({ id: 'div', ignored: true, backend: 50, children: crowd.map((item) => String(item.nodeId)) }),
        ...crowd,
        node({ id: 'button', role: 'button', name: 'Hidden label text', labelledBy: [50] }),
        field('pin', 5, 'SECRETN3'),
      ];
      await redactPasswordValues(nodes, allSecret, { maxIgnored: 3 });
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
      // With no secret on the page there is nothing to hide.
      const quiet = [
        node({ id: 'div', ignored: true, backend: 50, children: crowd.map((item) => String(item.nodeId)) }),
        ...crowd,
        node({ id: 'button', role: 'button', name: 'Hidden label text', labelledBy: [50] }),
      ];
      await redactPasswordValues(quiet, nonSecret, { maxIgnored: 3 });
      expect(nameOf(quiet, 'button')).toBe('Hidden label text');
    });

    it('hides names built from hidden content when asking about it fails', async () => {
      const nodes = [
        node({ id: 'div', ignored: true, backend: 50, children: ['input'] }),
        node({ id: 'input', ignored: true, backend: 52 }),
        node({ id: 'button', role: 'button', name: 'Password hunter22', labelledBy: [50] }),
        node({ id: 'other', role: 'button', name: 'Plain' }),
      ];
      await redactPasswordValues(nodes, async () => {
        throw new Error('page unavailable');
      });
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
      expect(nameOf(nodes, 'other')).toBe('Plain');
    });

    it('follows a hidden value through every name that took it in, not one step', async () => {
      const nodes = [
        field('pw', 5, 'SECRETN1'),
        // A span named from the field, inside a label for a text box, and inside a button.
        node({ id: 'label', role: 'LabelText', backend: 60, name: '', children: ['span1'] }),
        node({ id: 'span1', role: 'generic', name: 'SECRETN1', labelledBy: [5] }),
        node({ id: 't2', role: 'textbox', name: 'PIN SECRETN1', labelFor: [60] }),
        node({ id: 'button', role: 'button', name: 'Pay SECRETN1', children: ['span2'] }),
        node({ id: 'span2', role: 'generic', name: 'SECRETN1', labelledBy: [5] }),
        // A third step: a button named from the text box.
        node({ id: 'again', role: 'button', name: 'Confirm PIN SECRETN1', labelledBy: [61] }),
        node({ id: 't2host', role: 'generic', name: '', backend: 61, children: ['t2'] }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('SECRETN1') }));
      expect(nameOf(nodes, 'span1')).toBe('<redacted>');
      expect(nameOf(nodes, 't2')).toBe('PIN <redacted>');
      expect(nameOf(nodes, 'button')).toBe('Pay <redacted>');
      expect(nameOf(nodes, 'again')).toBe('Confirm PIN <redacted>');
    });

    it('hides the names above a name it had to hide whole, when they are built from content', async () => {
      const nodes = [
        field('pw', 5, 'SECRETN1'),
        node({ id: 'button', role: 'button', name: 'Pay forty-two', contents: true, children: ['span'] }),
        node({ id: 'span', role: 'generic', name: 'forty-two', labelledBy: [5] }),
        node({ id: 'region', role: 'region', name: 'Shop forty-two', children: ['button'] }),
        node({ id: 'plain', role: 'group', name: 'Shop', children: ['span'] }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('SECRETN1') }));
      expect(nameOf(nodes, 'span')).toBe('<redacted>');
      expect(nameOf(nodes, 'button')).toBe('<redacted>');
      // Its name does not come from its content, so it holds nothing of it.
      expect(nameOf(nodes, 'region')).toBe('Shop forty-two');
      expect(nameOf(nodes, 'plain')).toBe('Shop');
    });

    it('takes a value of four characters or more out of every name, value and address on the page', async () => {
      const nodes = [
        node({ id: 'pw', role: 'textbox', name: 'Password', value: '••••••••', backend: 5 }),
        node({ id: 'echo', role: 'StaticText', name: 'You typed hunter2x just now' }),
        node({ id: 'user', role: 'textbox', name: 'Username', value: 'hunter2x', backend: 6 }),
        node({ id: 'link', role: 'link', name: 'Reset', url: 'https://a.test/reset?pw=hunter2x' }),
        node({ id: 'short', role: 'StaticText', name: 'Item 42 here' }),
        node({ id: 'ok', role: 'StaticText', name: 'Nothing here' }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('hunter2x'), 6: plain }));
      expect(nameOf(nodes, 'echo')).toBe('You typed <redacted> just now');
      expect(valueOf(nodes, 'user')).toBe('<redacted>');
      const address = ((byId(nodes, 'link').properties as Raw[])[0] as { value: { value: string } }).value.value;
      expect(address).toBe('https://a.test/reset?pw=<redacted>');
      expect(nameOf(nodes, 'ok')).toBe('Nothing here');
    });

    it('does not take a short value out of the page, only out of the names tied to its field', async () => {
      const nodes = [field('pw', 5, '42'), node({ id: 'a', role: 'StaticText', name: 'Item 42 here' })];
      await redactPasswordValues(nodes, answering({ 5: secret('42') }));
      expect(nameOf(nodes, 'a')).toBe('Item 42 here');
    });

    it('never matches inside its own marker', async () => {
      const nodes = [
        node({ id: 'group', role: 'group', name: 'Pay reda now', children: ['pw'] }),
        field('pw', 5, 'reda'),
        node({ id: 'other', role: 'StaticText', name: 'a <redacted> and reda' }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('reda') }));
      expect(nameOf(nodes, 'group')).toBe('Pay <redacted> now');
      expect(nameOf(nodes, 'other')).toBe('a <redacted> and <redacted>');
    });

    it('takes out the longer of two values that start alike, wherever they stand', async () => {
      const nodes = [
        field('a', 5, 'hunter2x'),
        field('b', 6, 'hunter2xyz'),
        node({ id: 'echo', role: 'StaticText', name: 'a hunter2xyz b hunter2x c hunter2' }),
      ];
      await redactPasswordValues(nodes, allSecret);
      expect(nameOf(nodes, 'echo')).toBe('a <redacted> b <redacted> c hunter2');
    });

    it('uses the value the field really holds, not only the bullets the tree shows', async () => {
      const nodes = [
        node({ id: 'pw', role: 'textbox', name: 'Password', value: '••••••••', backend: 5 }),
        node({ id: 'echo', role: 'StaticText', name: 'Tr0ub4dor&3' }),
      ];
      await redactPasswordValues(nodes, answering({ 5: secret('Tr0ub4dor&3') }));
      expect(nameOf(nodes, 'echo')).toBe('<redacted>');
    });
  });
});

describe('password redaction: what a hostile page can make it cost', () => {
  const needleOf = (index: number): string => `PINVAL${index}x`;
  const named = (needles: string[]): string => `Checkout ${needles.join(' ')}`;
  /** Answers each DOM id of a masked field with its own value. */
  const byBackend = (base: number): InspectFields => async (ids) => ids.map((id) => (id >= base ? secret(needleOf(id - base)) : plain));
  const leaks = (nodes: unknown[]): number =>
    (nodes as Raw[]).filter((item) => {
      const name = (item.name as { value?: string } | undefined)?.value ?? '';
      const value = (item.value as { value?: unknown } | undefined)?.value;
      return name.includes('PINVAL') || (typeof value === 'string' && value.includes('PINVAL'));
    }).length;

  it('hides the values of 3,000 masked fields from 200 buttons named by their form, in bounded time', async () => {
    const fields = Array.from({ length: 3_000 }, (_, index) => field(`f${index}`, 100_000 + index, '••••••••'));
    const formName = named(fields.map((_, index) => needleOf(index)));
    const nodes = [
      node({ id: 'root', role: 'RootWebArea', children: ['form', ...Array.from({ length: 200 }, (_, index) => `b${index}`)] }),
      node({ id: 'form', role: 'form', name: formName, backend: 1, contents: true, children: fields.map((item) => String(item.nodeId)) }),
      ...fields,
      ...Array.from({ length: 200 }, (_, index) => node({ id: `b${index}`, role: 'button', name: formName, labelledBy: [1] })),
    ];
    const started = performance.now();
    const result = await redactPasswordValues(nodes, byBackend(100_000));
    const elapsed = performance.now() - started;
    expect(leaks(result)).toBe(0);
    expect(nameOf(result, 'b0')).toContain('<redacted>');
    expect(elapsed).toBeLessThan(3_000);
  });

  const nested = (depth: number, width: number): Raw[] => {
    const nodes: Raw[] = [node({ id: 'root', role: 'RootWebArea', children: ['level0'] })];
    for (let level = 0; level < depth; level += 1) {
      const ids = Array.from({ length: width }, (_, index) => `f${level}-${index}`);
      nodes.push(
        node({
          id: `level${level}`,
          role: 'group',
          name: named(ids.map((_, index) => needleOf(level * width + index))),
          backend: 10 + level,
          contents: true,
          children: [...ids, ...(level + 1 < depth ? [`level${level + 1}`] : [])],
        }),
        node({ id: `b${level}`, role: 'button', name: named(ids.map((_, index) => needleOf(level * width + index))), labelledBy: [10 + level] }),
      );
      ids.forEach((id, index) => nodes.push(field(id, 100_000 + level * width + index, '••••••••')));
    }
    return nodes;
  };

  it('copes with groups nested 500 deep holding 20 masked fields each', async () => {
    const nodes = nested(500, 20);
    const started = performance.now();
    const result = await redactPasswordValues(nodes, byBackend(100_000));
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(leaks(result)).toBe(0);
  });

  it('copes with groups nested 30 deep holding 300 masked fields each', async () => {
    const nodes = nested(30, 300);
    const started = performance.now();
    const result = await redactPasswordValues(nodes, byBackend(100_000));
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(leaks(result)).toBe(0);
  });

  it('past its time budget hides every name, value, address and line of text that holds a value, and no other', async () => {
    const nodes = [
      node({ id: 'root', role: 'RootWebArea', children: ['pw', 'name', 'echo', 'link', 'plain'] }),
      node({ id: 'pw', role: 'textbox', name: 'Password', value: '••••••••', backend: 5 }),
      node({ id: 'name', role: 'button', name: 'Pay hunter2x now' }),
      node({ id: 'echo', role: 'StaticText', name: 'You typed hunter2x just now' }),
      node({ id: 'link', role: 'link', name: 'Reset', url: 'https://a.test/?pw=hunter2x' }),
      node({ id: 'plain', role: 'button', name: 'Nothing here' }),
      node({ id: 'bullets', role: 'button', name: 'Pay ••••••' }),
    ];
    await redactPasswordValues(nodes, answering({ 5: secret('hunter2x') }), { budgetMs: 0 });
    expect(nameOf(nodes, 'bullets')).toBe('<redacted>');
    expect(nameOf(nodes, 'name')).toBe('<redacted>');
    expect(nameOf(nodes, 'echo')).toBe('<redacted>');
    const address = ((byId(nodes, 'link').properties as Raw[])[0] as { value: { value: string } }).value.value;
    expect(address).toBe('<redacted>');
    expect(nameOf(nodes, 'plain')).toBe('Nothing here');
  });
});

describe('password redaction: text the page split, changed or hid', () => {
  const text = (id: string, name: string): Raw => node({ id, role: 'StaticText', name });
  const lines = (nodes: unknown[]): string[] => (nodes as Raw[]).filter((item) => (item.role as { value: string }).value === 'StaticText').map((item) => (item.name as { value: string }).value);

  it('takes out a value the page wrote one element a character, and in a bold run and the text after it', async () => {
    const chars = [...'hunter2x'];
    const nodes = [
      node({ id: 'root', role: 'RootWebArea', children: ['pw', 'p', 'q'] }),
      node({ id: 'pw', role: 'textbox', name: 'Password', value: '••••••••', backend: 5 }),
      node({ id: 'p', role: 'paragraph', children: chars.map((_, index) => `c${index}`) }),
      ...chars.map((character, index) => text(`c${index}`, character)),
      node({ id: 'q', role: 'paragraph', children: ['b', 't'] }),
      node({ id: 'b', role: 'strong', children: ['b1'] }),
      text('b1', 'hun'),
      text('t', 'ter2x is it'),
    ];
    const result = await redactPasswordValues(nodes, answering({ 5: secret('hunter2x') }));
    const all = lines(result).join('');
    expect(all).not.toMatch(/h\s*u\s*n\s*t\s*e\s*r\s*2\s*x/);
    expect(all).not.toContain('hun');
    expect(all).not.toContain('ter2x');
    expect(all.match(/<redacted>/g)).toHaveLength(2);
    expect(all).toContain(' is it');
  });

  it('matches whatever the case, as a page that upper-cases its text shows it', async () => {
    const nodes = [
      node({ id: 'pw', role: 'textbox', name: 'Password', value: '••••••••', backend: 5 }),
      text('echo', 'ECHO2: LOWERSECRET21'),
      node({ id: 'link', role: 'link', name: 'x', url: 'https://a.test/?q=LowerSecret21' }),
    ];
    await redactPasswordValues(nodes, answering({ 5: secret('lowersecret21') }));
    expect(nameOf(nodes, 'echo')).toBe('ECHO2: <redacted>');
    const address = ((byId(nodes, 'link').properties as Raw[])[0] as { value: { value: string } }).value.value;
    expect(address).toBe('https://a.test/?q=<redacted>');
  });

  it('takes out the values the page lists as secret even when no node or name holds the field', async () => {
    const nodes = [text('echo', 'Echo: Tr0ub4dor&3 done'), text('other', 'Nothing')];
    const told: string[][] = [];
    await redactPasswordValues(nodes, nonSecret, { pageSecrets: ['Tr0ub4dor&3'], onSecrets: (needles) => told.push(needles) });
    expect(nameOf(nodes, 'echo')).toBe('Echo: <redacted> done');
    expect(nameOf(nodes, 'other')).toBe('Nothing');
    expect(told).toEqual([['Tr0ub4dor&3']]);
  });

  it('takes out values remembered from an earlier read of the tab', async () => {
    const nodes = [text('echo', 'Welcome back, hunter2x')];
    await redactPasswordValues(nodes, nonSecret, { remembered: ['hunter2x'] });
    expect(nameOf(nodes, 'echo')).toBe('Welcome back, <redacted>');
  });

  it('takes out the encoded forms of a value from a link address', async () => {
    const nodes = [
      node({ id: 'pw', role: 'textbox', name: 'Password', value: '••••••••', backend: 5 }),
      node({ id: 'a', role: 'link', name: 'a', url: 'https://a.test/?pw=p%40ss%20w%26rd' }),
      node({ id: 'b', role: 'link', name: 'b', url: 'https://a.test/?pw=p%40ss+w%26rd' }),
      node({ id: 'c', role: 'link', name: 'c', url: 'https://a.test/?pw=p@ss%20w&rd' }),
      node({ id: 'd', role: 'link', name: 'd', url: 'https://a.test/?pw=p@ss w&rd' }),
    ];
    await redactPasswordValues(nodes, answering({ 5: secret('p@ss w&rd') }));
    for (const id of ['a', 'b', 'c', 'd']) {
      const address = ((byId(nodes, id).properties as Raw[])[0] as { value: { value: string } }).value.value;
      expect(address, id).toBe('https://a.test/?pw=<redacted>');
    }
  });

  it('takes out the value of a hidden field no name was built from, which only the page\'s own list knows', async () => {
    const nodes = [node({ id: 'hidden', role: 'none', ignored: true, backend: 5, name: '' }), text('echo', 'Echo: hiddenvalue1')];
    await redactPasswordValues(nodes, nonSecret, { pageSecrets: ['hiddenvalue1'] });
    expect(nameOf(nodes, 'echo')).toBe('Echo: <redacted>');
  });
});

