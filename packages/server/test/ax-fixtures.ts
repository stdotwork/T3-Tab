import type { AxNode, PageReadResult } from '@t3-tab/protocol';

type Extra = Partial<Pick<AxNode, 'value' | 'props' | 'ignored' | 'backendId'>>;

/** Builds one accessibility node; the backend id is the numeric id unless given. */
export function ax(id: number, role: string, name = '', children: number[] = [], extra: Extra = {}): AxNode {
  const node: AxNode = {
    id: String(id),
    role,
    name,
    children: children.map(String),
    backendId: id,
    ...extra,
  };
  if (node.ignored === true) {
    node.role = '';
    node.name = '';
  }
  return node;
}

export function page(nodes: AxNode[], overrides: Partial<PageReadResult> = {}): PageReadResult {
  return { tab: 7, title: 'Test page', url: 'http://localhost/test', epoch: 1, nodes, ...overrides };
}

/** A sign-in page: heading, a named form with a label, a field and a button, and a paragraph. */
export function signInPage(): AxNode[] {
  return [
    ax(1, 'RootWebArea', 'Sign in page', [2, 3, 8]),
    ax(2, 'heading', 'Sign in', [], { props: { level: 1 } }),
    ax(3, 'form', 'Login', [4, 5, 6]),
    ax(4, 'LabelText', 'Email', [7]),
    ax(5, 'textbox', 'Email', [], { value: 'a@b.c', props: { required: true } }),
    ax(6, 'button', 'Submit', [9]),
    ax(7, 'StaticText', 'Email'),
    ax(8, 'paragraph', '', [10]),
    ax(9, 'StaticText', 'Submit'),
    ax(10, 'StaticText', 'Hello there'),
  ];
}

/** A page of `count` buttons named `${prefix} ${n}`, under one heading. */
export function buttonPage(count: number, prefix = 'Button'): AxNode[] {
  const ids = Array.from({ length: count }, (_, index) => 100 + index);
  return [
    ax(1, 'RootWebArea', 'Buttons', [2, ...ids]),
    ax(2, 'heading', 'Buttons', [], { props: { level: 1 } }),
    ...ids.map((id, index) => ax(id, 'button', `${prefix} ${index + 1}`)),
  ];
}
