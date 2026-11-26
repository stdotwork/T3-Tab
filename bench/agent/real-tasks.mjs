// The held-out set: tasks on public websites that are built for, or tolerate, light automated use. It is run apart from the
// local tasks (`pnpm bench:agent --sites real`) and is meant to stay as it is while a tool is being tuned on the local
// ones, so a gain that only fits the local pages shows up here as no gain. FROZEN 2026-11-27: change a task only because a site
// changed (and then redo every tool's runs on it), never to suit a tool.
//
// Each task names the origins it may touch (`origins`: T3-Tab's per-site setting is `allow` for them, as for the local
// site, so no prompt waits; the other tools have no such layer) and a check the harness runs when the agent has finished: the
// page state read over the browser's debugging port (`probe`, an expression run in every page of those origins), or the
// answer against a value that does not change. No task logs in to anything.
//
// Every request is a plain page load a person would make, a few per run; runs are shuffled so no site gets a burst.
// A site that is down or rate-limiting fails the runs that touch it. A task found to do that carries `flaky: '<what was seen>'`,
// and the report marks it; it stays in the set.

/** The text after the last `DONE:` of a final message, or all of it when there is none. */
export const doneLine = (answer) => {
  const at = answer.lastIndexOf('DONE:');
  return (at < 0 ? answer : answer.slice(at + 5)).trim();
};

const squash = (text) => text.toLowerCase().replace(/[\s,$]/g, '');

const INTERNET = ['https://the-internet.herokuapp.com'];
const GRAHAM = ['https://paulgraham.com', 'http://paulgraham.com', 'https://www.paulgraham.com'];

export const REAL_TASKS = [
  {
    id: 'books',
    title: 'Paginate a catalogue and read the last item (books.toscrape.com)',
    origins: ['https://books.toscrape.com'],
    goal: () =>
      'On https://books.toscrape.com open the "Mystery" category. It lists its books over two pages. Tell me the title and the price of the last book listed on the second page.',
    // The category is a fixed demo catalogue: 32 books, 20 on the first page. The last of the second is 1st to Die at £53.98.
    check: async ({ answer }) => {
      const line = squash(doneLine(answer));
      const ok = line.includes('1sttodie') && line.includes('53.98');
      return { ok, why: ok ? undefined : 'the answer is not "1st to Die (Women\'s Murder Club #1)" at £53.98' };
    },
  },
  {
    id: 'quotes',
    title: 'Paginate and count (quotes.toscrape.com)',
    origins: ['https://quotes.toscrape.com'],
    goal: () => 'On https://quotes.toscrape.com, count how many of the quotes on the first three pages (pages 1, 2 and 3) are by Albert Einstein. Answer with the number.',
    // A fixed demo site: Einstein has 3, 1 and 2 quotes on its first three pages.
    check: async ({ answer }) => {
      const ok = /\b(6|six)\b/i.test(doneLine(answer));
      return { ok, why: ok ? undefined : 'the answer does not give 6' };
    },
  },
  {
    id: 'dynamic',
    title: 'Wait for content that loads late (the-internet)',
    origins: INTERNET,
    goal: () => 'Open https://the-internet.herokuapp.com/dynamic_loading/2, start the loading, and tell me the text that appears once it has loaded.',
    probe: `(() => ({ finish: document.querySelector('#finish')?.innerText?.trim() ?? null }))()`,
    check: async ({ answer, probe }) => {
      const shown = (await probe()).some((page) => page.finish === 'Hello World!');
      const named = squash(doneLine(answer)).includes('helloworld');
      return { ok: shown && named, why: !shown ? 'the page does not show the loaded text' : !named ? 'the answer does not give "Hello World!"' : undefined };
    },
  },
  {
    id: 'prompt',
    title: 'Answer a JavaScript prompt (the-internet)',
    origins: INTERNET,
    goal: () => 'Open https://the-internet.herokuapp.com/javascript_alerts, press the "Click for JS Prompt" button, type bench-42 into the prompt it opens and accept it, and tell me the result line the page shows.',
    probe: `(() => ({ result: document.querySelector('#result')?.innerText?.trim() ?? null }))()`,
    check: async ({ probe }) => {
      const ok = (await probe()).some((page) => page.result === 'You entered: bench-42');
      return { ok, why: ok ? undefined : 'the page does not show "You entered: bench-42"' };
    },
  },
  {
    id: 'combobox',
    title: 'Use a combobox widget (WAI-ARIA Authoring Practices)',
    origins: ['https://www.w3.org'],
    goal: () =>
      'Open https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/ and use the "State" combobox on it (the one with list autocomplete) to choose Wyoming.',
    probe: `(() => ({ value: document.getElementById('cb1-input')?.value ?? null }))()`,
    check: async ({ probe }) => {
      const ok = (await probe()).some((page) => page.value === 'Wyoming');
      return { ok, why: ok ? undefined : 'the combobox does not hold "Wyoming"' };
    },
  },
  {
    id: 'todomvc',
    title: 'Add and complete items (TodoMVC)',
    origins: ['https://todomvc.com'],
    goal: () => 'Open https://todomvc.com/examples/react/dist/ , add three todos in this order: "buy milk", "walk dog", "write report". Then mark "walk dog" as completed and leave the other two active.',
    probe: `(() => ({ items: [...document.querySelectorAll('.todo-list li')].map((li) => ({ text: li.innerText.trim(), done: li.classList.contains('completed') })) }))()`,
    check: async ({ probe }) => {
      const ok = (await probe()).some((page) => JSON.stringify(page.items) === JSON.stringify([{ text: 'buy milk', done: false }, { text: 'walk dog', done: true }, { text: 'write report', done: false }]));
      return { ok, why: ok ? undefined : 'the list is not [buy milk, walk dog (done), write report]' };
    },
  },
  {
    id: 'wikipedia',
    title: 'Find a fact in a long article (Wikipedia)',
    origins: ['https://en.wikipedia.org'],
    goal: () =>
      'On the English Wikipedia article "Great Fire of London" (https://en.wikipedia.org/wiki/Great_Fire_of_London), find how many houses the material destruction has been computed at, and give the figure as the article states it.',
    // The article puts the destruction at 13,200 to 13,500 houses.
    check: async ({ answer }) => {
      const ok = squash(doneLine(answer)).includes('13200');
      return { ok, why: ok ? undefined : 'the answer does not give 13,200' };
    },
  },
  {
    id: 'hn',
    title: 'Follow a link off Hacker News and read the page',
    origins: ['https://news.ycombinator.com', ...GRAHAM],
    goal: () =>
      'Open the Hacker News item https://news.ycombinator.com/item?id=6041765 and follow the link of the story to the essay it points to. According to that essay, the founders of which company invented what Y Combinator calls the "Collison installation"? Answer with the company name.',
    // A frozen 2013 item that points at a static essay. The page of the essay has to be open at the end, so the answer was read, not recalled.
    probe: `(() => ({ path: location.pathname }))()`,
    check: async ({ answer, probe }) => {
      const opened = (await probe()).some((page) => page.path === '/ds.html');
      const named = /stripe/i.test(doneLine(answer));
      return { ok: opened && named, why: opened && named ? undefined : !opened ? 'no tab is on the essay (/ds.html)' : 'the answer does not name Stripe' };
    },
  },
];

export const REAL_TASK_IDS = REAL_TASKS.map((task) => task.id);
