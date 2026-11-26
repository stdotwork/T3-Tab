// The tasks an agent is given. Each is a goal in plain words that any browser tool can reach, and a check the
// harness runs on the site and the browser after the agent has finished: what the page and the server show, not
// what the agent says. The questions whose point is the answer (a number, a code) are checked against that
// answer as well, since the answer is the only place the result exists.
import {
  FEED_TARGET,
  LOGIN_BALANCE,
  LOGIN_OLD_PASSWORD,
  LOGIN_PASSWORD,
  LOGIN_USER,
  PROJECT_TO_DELETE,
  WIZARD_EXPECTED,
  feedRef,
  salesAnswer,
} from './pages/index.mjs';

/** The answer text with spaces, commas, dollar signs and case removed, so "$48,200" and "48200" match. */
const squash = (answer) => answer.toLowerCase().replace(/[\s,$]/g, '');

const DETAILS = 'Release notes';

export const TASKS = [
  {
    id: 'form',
    title: 'Fill and submit a form',
    from: 'pnpm bench',
    goal: (site) => `Open ${site}/form and sign up: put the name "Ada Lovelace" and the email "ada@example.com" in the form, choose the country Brazil, and submit it.`,
    check: async ({ pageStates }) => {
      const ok = (await pageStates()).some((state) => state.path === '/form' && state.result === 'Welcome Ada Lovelace (ada@example.com)' && state.country === 'Brazil');
      return { ok, why: ok ? undefined : 'the page does not show the welcome line for Ada with Brazil chosen' };
    },
  },
  {
    id: 'hidden',
    title: 'Open a hidden section',
    from: 'pnpm bench',
    goal: (site) => `Open ${site}/form and expand the collapsed Details section at the bottom of the page. Tell me the name of the link inside it.`,
    check: async ({ pageStates, answer }) => {
      const shown = (await pageStates()).some((state) => state.path === '/form' && state.detailsHidden === false);
      const named = squash(answer).includes(squash(DETAILS));
      return { ok: shown && named, why: !shown ? 'the Details section is still hidden' : !named ? `the answer does not name "${DETAILS}"` : undefined };
    },
  },
  {
    id: 'navigate',
    title: 'Follow a link',
    from: 'pnpm bench',
    goal: (site) => `Open ${site}/products and open the page of the product called "Day pack".`,
    check: async ({ pageStates }) => {
      const ok = (await pageStates()).some((state) => state.path === '/products/3');
      return { ok, why: ok ? undefined : 'no tab is on the Day pack page' };
    },
  },
  {
    id: 'search',
    title: 'Search a long page',
    from: 'pnpm bench',
    goal: (site) => `Open ${site}/docs. According to the guide, how many requests per minute does the rate limit allow for each token? Answer with the number.`,
    check: async ({ answer }) => {
      const ok = /\b(60|sixty)\b/i.test(answer);
      return { ok, why: ok ? undefined : 'the answer does not give 60' };
    },
  },
  {
    id: 'login',
    title: 'Sign in after a wrong password',
    goal: (site) =>
      `Sign in at ${site}/login as "${LOGIN_USER}". Try the password "${LOGIN_OLD_PASSWORD}" first; if the site rejects it, use "${LOGIN_PASSWORD}". Once you are in, tell me the account balance shown on the dashboard.`,
    check: async ({ site, answer }) => {
      const logins = site.events.filter((event) => event.type === 'login');
      const wrongFirst = logins[0]?.ok === false && logins[0].password === LOGIN_OLD_PASSWORD;
      const signedIn = logins.some((event) => event.ok);
      const balance = squash(answer).includes(squash(LOGIN_BALANCE));
      return {
        ok: wrongFirst && signedIn && balance,
        why: !wrongFirst ? 'the old password was not tried first' : !signedIn ? 'the site never saw a good sign-in' : !balance ? `the answer does not give ${LOGIN_BALANCE}` : undefined,
      };
    },
  },
  {
    id: 'wizard',
    title: 'Multi-step registration',
    goal: (site) =>
      `Use the registration wizard at ${site}/wizard to register Grace Hopper (grace@example.org) on the Team plan with 12 seats, billed annually, with Priority support, and accept the terms. Go through every step and confirm at the end, then tell me the confirmation code.`,
    check: async ({ site, answer }) => {
      const sent = site.events.filter((event) => event.type === 'wizard').at(-1)?.body;
      const expected = WIZARD_EXPECTED;
      const right =
        sent !== undefined &&
        sent.name === expected.name &&
        sent.email === expected.email &&
        sent.plan === expected.plan &&
        sent.seats === expected.seats &&
        sent.billing === expected.billing &&
        sent.support === expected.support &&
        sent.terms === expected.terms;
      const code = squash(answer).includes(squash(site.wizardCode));
      return { ok: right && code, why: !right ? `the registration the site received was ${JSON.stringify(sent)}` : !code ? `the answer does not give ${site.wizardCode}` : undefined };
    },
  },
  {
    id: 'loadmore',
    title: 'Find an entry behind "Load more"',
    goal: (site) => `On ${site}/feed, find entry #${FEED_TARGET} of the activity log and tell me its reference code (the text after "ref").`,
    check: async ({ answer }) => {
      const ok = squash(answer).includes(squash(feedRef(FEED_TARGET)));
      return { ok, why: ok ? undefined : `the answer does not give ${feedRef(FEED_TARGET)}` };
    },
  },
  {
    id: 'confirm',
    title: 'Delete behind a confirm dialog',
    goal: (site) => `On ${site}/projects, delete the project named "${PROJECT_TO_DELETE}" and nothing else. The site asks for confirmation first.`,
    check: async ({ site }) => {
      // Repeated requests for the same project do no harm: what counts is that only that project is gone.
      const ok = site.deleted.length >= 1 && site.deleted.every((name) => name === PROJECT_TO_DELETE);
      return { ok, why: ok ? undefined : `projects deleted on the site: ${JSON.stringify(site.deleted)}` };
    },
  },
  {
    id: 'table',
    title: 'Sum a dynamic table',
    goal: (site) => `On ${site}/sales, find the total revenue of the West region in Q3 (add up every matching row) and tell me the total in dollars.`,
    check: async ({ answer }) => {
      const total = salesAnswer();
      const ok = squash(answer).includes(String(total));
      return { ok, why: ok ? undefined : `the answer does not give ${total}` };
    },
  },
  {
    id: 'newtab',
    title: 'Read a page that opens in a new tab',
    goal: (site) => `On ${site}/library, open the "Annual report" document (its link opens in a new tab) and tell me the code word printed on the report.`,
    check: async ({ site, answer }) => {
      const opened = site.events.some((event) => event.type === 'report');
      const word = squash(answer).includes(squash(site.codeWord));
      return { ok: opened && word, why: !opened ? 'the report was never opened' : !word ? `the answer does not give ${site.codeWord}` : undefined };
    },
  },
];

export const TASK_IDS = TASKS.map((task) => task.id);
