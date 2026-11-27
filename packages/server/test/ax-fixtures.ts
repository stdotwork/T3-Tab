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

/** A form of `count` text fields: an outline keeps every field, so it stays as long as the page. */
export function fieldPage(count: number): AxNode[] {
  const ids = Array.from({ length: count }, (_, index) => 100 + index);
  return [
    ax(1, 'RootWebArea', 'Fields', [2, ...ids]),
    ax(2, 'heading', 'Fields', [], { props: { level: 1 } }),
    ...ids.map((id, index) => ax(id, 'textbox', `Field ${index + 1}`)),
  ];
}

/**
 * A long page: a navigation of 20 links (`Nav N`), then a main with a heading, 12 paragraphs of 300 characters
 * (`Paragraph N …`), a search form, a list of 100 links (`Item N`), a link past them holding a heading, and an alert; then a
 * footer of 10 links and a dialog with a button.
 */
export function longPage(): AxNode[] {
  const nav = Array.from({ length: 20 }, (_, index) => 100 + index);
  const paragraphs = Array.from({ length: 12 }, (_, index) => 300 + index * 2);
  const items = Array.from({ length: 100 }, (_, index) => 500 + index);
  const footer = Array.from({ length: 10 }, (_, index) => 700 + index);
  const paragraph = (index: number): string => `Paragraph ${index + 1} ${'of the report, which goes on. '.repeat(10)}`.slice(0, 300);
  return [
    ax(1, 'RootWebArea', 'Report', [2, 3, 50, 60]),
    ax(2, 'navigation', 'Site', nav),
    ...nav.map((id, index) => ax(id, 'link', `Nav ${index + 1}`)),
    ax(3, 'main', '', [4, ...paragraphs, 30, 33, 35, 40]),
    ax(4, 'heading', 'Report', [], { props: { level: 1 } }),
    ...paragraphs.flatMap((id, index) => [ax(id, 'paragraph', '', [id + 1]), ax(id + 1, 'StaticText', paragraph(index))]),
    ax(30, 'form', 'Search', [31, 32]),
    ax(31, 'textbox', 'Query'),
    ax(32, 'button', 'Go'),
    ax(33, 'list', 'Items', items),
    ...items.map((id, index) => ax(id, 'link', `Item ${index + 1}`)),
    ax(35, 'link', 'Story', [36]),
    ax(36, 'heading', 'Story heading', [], { props: { level: 2 } }),
    ax(40, 'alert', '', [41]),
    ax(41, 'StaticText', 'Report saved.'),
    ax(50, 'contentinfo', 'Footer', footer),
    ...footer.map((id, index) => ax(id, 'link', `Foot ${index + 1}`)),
    ax(60, 'dialog', 'Cookies', [61, 62]),
    ax(61, 'StaticText', 'We use cookies.'),
    ax(62, 'button', 'Accept'),
  ];
}

/**
 * A page with a link, an article region of `sentences` paragraphs, a button, a footer with text and an alert: e1 the
 * link, e2 the button, e3 the article.
 */
export function longArticle(sentences: number): AxNode[] {
  const ids = Array.from({ length: sentences }, (_, index) => 1_000 + index * 2);
  return [
    ax(1, 'RootWebArea', 'Article', [2, 3, 4, 5, 6, 8]),
    ax(2, 'link', 'Home'),
    ax(3, 'button', 'Subscribe'),
    ax(4, 'contentinfo', '', [10]),
    ax(5, 'alert', '', [12]),
    ax(6, 'main', '', [7]),
    ax(7, 'article', 'Story', ids),
    ax(8, 'paragraph', '', [11]),
    ax(10, 'StaticText', 'Footer text, after the article in the tree order only.'),
    ax(11, 'StaticText', 'Closing words outside the article.'),
    ax(12, 'StaticText', 'Saved.'),
    ...ids.flatMap((id, index) => [
      ax(id, 'paragraph', '', [id + 1]),
      ax(id + 1, 'StaticText', `Sentence ${index + 1} of the article, long enough to be a real line of prose.`),
    ]),
  ];
}

/** An activity feed: a named list of `count` text entries and a button. */
export function feed(count: number): AxNode[] {
  const ids = Array.from({ length: count }, (_, index) => 1_000 + index * 2);
  return [
    ax(1, 'RootWebArea', 'Feed', [2, 3]),
    ax(2, 'list', 'Entries', ids),
    ax(3, 'button', 'Load more'),
    ...ids.flatMap((id, index) => [ax(id, 'listitem', '', [id + 1]), ax(id + 1, 'StaticText', `#${index + 1} · Entry`)]),
  ];
}

/**
 * A documentation page: a sidebar navigation of `links` links (e1 the sidebar), then a main article of `paragraphs`
 * paragraphs, each with a link in its text, and a button.
 */
export function docsPage(links: number, paragraphs: number): AxNode[] {
  const nav = Array.from({ length: links }, (_, index) => ax(10_000 + index, 'link', `Guide to topic ${index}`));
  const body = Array.from({ length: paragraphs }, (_, index) => {
    const id = 20_000 + index * 4;
    return [
      ax(id, 'paragraph', '', [id + 1, id + 2, id + 3]),
      ax(id + 1, 'StaticText', `Paragraph ${index} explains one part of the subject, in words, and then points to `),
      ax(id + 2, 'link', `related page ${index}`),
      ax(id + 3, 'StaticText', ' for the details that this page leaves out.'),
    ];
  }).flat();
  return [
    ax(1, 'RootWebArea', 'Docs', [2, 3]),
    ax(2, 'navigation', 'Sidebar', nav.map((node) => Number(node.id))),
    ax(3, 'main', '', [4, ...body.filter((node) => node.role === 'paragraph').map((node) => Number(node.id)), 5]),
    ax(4, 'heading', 'Getting started', [], { props: { level: 1 } }),
    ax(5, 'button', 'Edit this page'),
    ...nav,
    ...body,
  ];
}
