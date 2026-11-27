// The task site for the agent benchmark: one small HTTP server per run, so every run starts from the same state.
// The four pages of `pnpm bench` (bench/pages.mjs, unchanged) are served as they are; the pages below are new.
// State that matters (a login, a wizard's final request, a deleted project, a report that was opened) is kept
// here on the server and read by the harness after the run, so a task's success never rests on what the
// model says it did.
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';

import { benchPage } from '../../pages.mjs';

const shell = (title, body, script = '') =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>${title}</title></head><body>${body}${script === '' ? '' : `<script>${script}</script>`}</body></html>`;

const NAV =
  '<nav aria-label="Main"><a href="/">Home</a> <a href="/login">Sign in</a> <a href="/wizard">Register</a> <a href="/feed">Activity</a> <a href="/projects">Projects</a> <a href="/sales">Sales</a> <a href="/library">Library</a></nav>';

export const LOGIN_USER = 'maria';
export const LOGIN_OLD_PASSWORD = 'spring2025';
export const LOGIN_PASSWORD = 'harbor-lamp-42';
export const LOGIN_BALANCE = '$1,284.50';

export const FEED_TARGET = 58;
const FEED_TOTAL = 80;
const FEED_PAGE = 10;
const FEED_TITLES = ['Invoice paid', 'Deploy finished', 'User invited', 'Backup completed', 'Comment added', 'Plan changed', 'Export ready', 'Key rotated'];
/** The reference code of feed entry `n`: stable, and different for every entry. */
export const feedRef = (n) => `${'QXWMKTRZ'[n % 8]}${'BNLDVHSP'[(n * 3) % 8]}-${String(1000 + ((n * 7919) % 9000)).padStart(4, '0')}`;
const feedEntry = (n) => ({ n, title: FEED_TITLES[n % FEED_TITLES.length], ref: feedRef(n) });

export const PROJECTS = ['Apollo', 'Borealis', 'Cygnus', 'Draco'];
export const PROJECT_TO_DELETE = 'Apollo';

const REGIONS = ['North', 'South', 'East', 'West'];
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
const REPS = ['Avery', 'Blake', 'Casey', 'Devon', 'Eden', 'Finley', 'Gray', 'Harper', 'Indy', 'Jules', 'Kai', 'Lane'];
export const SALES = REGIONS.flatMap((region, regionIndex) =>
  QUARTERS.flatMap((quarter, quarterIndex) =>
    [0, 1, 2].map((slot) => ({
      region,
      rep: REPS[(regionIndex * 3 + slot + quarterIndex) % REPS.length],
      quarter,
      revenue: 8000 + ((regionIndex * 7 + quarterIndex * 5 + slot * 3 + 1) * 1337) % 9000 + slot * 100,
    })),
  ),
);
/** What the sales task's answer is: the sum of the West rows of Q3. */
export const salesAnswer = () => SALES.filter((row) => row.region === 'West' && row.quarter === 'Q3').reduce((total, row) => total + row.revenue, 0);

export const WIZARD_EXPECTED = { name: 'Grace Hopper', email: 'grace@example.org', plan: 'Team', seats: 12, billing: 'Annual', support: true, terms: true };

const LOGIN_PAGE = (message) =>
  shell(
    'Sign in',
    `<h1>Sign in</h1>${NAV}<main>${message === '' ? '' : `<p role="alert">${message}</p>`}
<form method="post" action="/login" aria-label="Sign in">
  <label>Username <input name="username" type="text" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form></main>`,
  );

const DASHBOARD = shell(
  'Dashboard',
  `<h1>Dashboard</h1>${NAV}<main><h2>Welcome back, Maria</h2><p>Account balance: <strong>${LOGIN_BALANCE}</strong></p><p>Last sign-in: today</p><a href="/logout">Sign out</a></main>`,
);

const WIZARD = shell(
  'Registration',
  `<h1>Registration</h1>${NAV}
<main>
  <p id="progress" aria-live="polite">Step 1 of 4: Your details</p>
  <p id="error" role="alert" hidden></p>
  <section id="step1" data-step="1">
    <h2>Your details</h2>
    <label>Full name <input id="name" name="name" type="text"></label>
    <label>Work email <input id="email" name="email" type="email"></label>
    <button type="button" data-next>Next</button>
  </section>
  <section id="step2" data-step="2" hidden>
    <h2>Choose a plan</h2>
    <fieldset><legend>Plan</legend>
      <label><input type="radio" name="plan" value="Starter"> Starter</label>
      <label><input type="radio" name="plan" value="Team"> Team</label>
      <label><input type="radio" name="plan" value="Enterprise"> Enterprise</label>
    </fieldset>
    <label>Seats <input id="seats" name="seats" type="number" min="1" value="1"></label>
    <label>Billing <select id="billing" name="billing"><option>Monthly</option><option>Annual</option></select></label>
    <button type="button" data-back>Back</button> <button type="button" data-next>Next</button>
  </section>
  <section id="step3" data-step="3" hidden>
    <h2>Add-ons and terms</h2>
    <label><input type="checkbox" id="support"> Priority support</label>
    <label><input type="checkbox" id="audit"> Audit log</label>
    <label><input type="checkbox" id="terms"> I accept the terms of service</label>
    <button type="button" data-back>Back</button> <button type="button" data-next>Review</button>
  </section>
  <section id="step4" data-step="4" hidden>
    <h2>Review</h2>
    <ul id="summary"></ul>
    <button type="button" data-back>Back</button> <button type="button" id="confirm">Confirm registration</button>
  </section>
  <section id="done" hidden><h2>Registration complete</h2><p id="code"></p></section>
</main>`,
  `
  const titles = ['Your details', 'Choose a plan', 'Add-ons and terms', 'Review'];
  let step = 1;
  const $ = (id) => document.getElementById(id);
  const error = (text) => { $('error').hidden = text === ''; $('error').textContent = text; };
  const show = (next) => {
    step = next;
    document.querySelectorAll('[data-step]').forEach((el) => { el.hidden = Number(el.dataset.step) !== step; });
    $('progress').textContent = 'Step ' + step + ' of 4: ' + titles[step - 1];
    error('');
    if (step === 4) {
      const plan = document.querySelector('input[name=plan]:checked').value;
      const addons = [$('support').checked ? 'Priority support' : null, $('audit').checked ? 'Audit log' : null].filter(Boolean);
      $('summary').innerHTML = '';
      for (const line of ['Name: ' + $('name').value, 'Email: ' + $('email').value, 'Plan: ' + plan, 'Seats: ' + $('seats').value, 'Billing: ' + $('billing').value, 'Add-ons: ' + (addons.join(', ') || 'none')]) {
        const li = document.createElement('li'); li.textContent = line; $('summary').append(li);
      }
    }
  };
  const valid = () => {
    if (step === 1) {
      if ($('name').value.trim() === '') return 'Enter your full name.';
      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test($('email').value)) return 'Enter a valid email address.';
    }
    if (step === 2) {
      if (!document.querySelector('input[name=plan]:checked')) return 'Choose a plan.';
      if (!(Number($('seats').value) >= 1)) return 'Seats must be at least 1.';
    }
    if (step === 3 && !$('terms').checked) return 'You must accept the terms.';
    return '';
  };
  document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', () => { const problem = valid(); if (problem) error(problem); else show(step + 1); }));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show(step - 1)));
  $('confirm').addEventListener('click', async () => {
    const body = { name: $('name').value, email: $('email').value, plan: document.querySelector('input[name=plan]:checked').value, seats: Number($('seats').value), billing: $('billing').value, support: $('support').checked, audit: $('audit').checked, terms: $('terms').checked };
    const reply = await fetch('/api/wizard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    document.querySelectorAll('[data-step]').forEach((el) => { el.hidden = true; });
    $('progress').textContent = 'Done';
    $('done').hidden = false;
    $('code').textContent = 'Confirmation code: ' + reply.code;
  });`,
);

const FEED = shell(
  'Activity log',
  `<h1>Activity log</h1>${NAV}<main><ol id="entries" aria-label="Entries"></ol><p id="end" hidden>End of the log.</p><button id="more" type="button">Load more</button></main>`,
  `
  let page = 0;
  const list = document.getElementById('entries');
  async function more() {
    page += 1;
    const data = await fetch('/api/feed?page=' + page).then((r) => r.json());
    for (const entry of data.items) {
      const li = document.createElement('li');
      li.value = entry.n;
      li.textContent = '#' + entry.n + ' · ' + entry.title + ' · ref ' + entry.ref;
      list.append(li);
    }
    if (!data.more) { document.getElementById('more').hidden = true; document.getElementById('end').hidden = false; }
  }
  document.getElementById('more').addEventListener('click', more);
  more();`,
);

const projectsPage = (names) => shell(
  'Projects',
  `<h1>Projects</h1>${NAV}<main><p id="status" role="status"></p><ul id="projects">${names.map((name) => `<li data-name="${name}"><span>${name}</span> <button type="button">Delete ${name}</button></li>`).join('')}</ul></main>`,
  `
  document.querySelectorAll('#projects li').forEach((li) => {
    li.querySelector('button').addEventListener('click', async () => {
      const name = li.dataset.name;
      const ok = confirm('Delete project ' + name + '? This cannot be undone.');
      await fetch('/api/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ok }) });
      if (!ok) { document.getElementById('status').textContent = 'Nothing was deleted.'; return; }
      await fetch('/api/projects/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      li.remove();
      document.getElementById('status').textContent = 'Deleted ' + name + '.';
    });
  });`,
);

const SALES_PAGE = shell(
  'Sales',
  `<h1>Sales by region</h1>${NAV}<main>
  <label>Region <select id="region"><option value="">All regions</option>${REGIONS.map((r) => `<option>${r}</option>`).join('')}</select></label>
  <label>Quarter <select id="quarter"><option value="">All quarters</option>${QUARTERS.map((q) => `<option>${q}</option>`).join('')}</select></label>
  <p id="count" role="status">Loading…</p>
  <table id="table" aria-label="Sales"><thead><tr><th scope="col">Region</th><th scope="col">Rep</th><th scope="col">Quarter</th><th scope="col">Revenue</th></tr></thead><tbody></tbody></table>
</main>`,
  `
  let rows = [];
  const body = document.querySelector('#table tbody');
  const money = (n) => '$' + n.toLocaleString('en-US');
  function draw() {
    const region = document.getElementById('region').value;
    const quarter = document.getElementById('quarter').value;
    const shown = rows.filter((r) => (region === '' || r.region === region) && (quarter === '' || r.quarter === quarter));
    body.innerHTML = '';
    for (const r of shown) {
      const tr = document.createElement('tr');
      for (const text of [r.region, r.rep, r.quarter, money(r.revenue)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      body.append(tr);
    }
    document.getElementById('count').textContent = shown.length + ' rows';
  }
  document.getElementById('region').addEventListener('change', draw);
  document.getElementById('quarter').addEventListener('change', draw);
  setTimeout(async () => { rows = await fetch('/api/sales').then((r) => r.json()); draw(); }, 400);`,
);

const libraryPage = (token) =>
  shell(
    'Library',
    `<h1>Library</h1>${NAV}<main><h2>Documents</h2><ul>
<li><a href="/doc/newsletter">Quarterly newsletter</a> <span>Opens here.</span></li>
<li><a href="/report/${token}" target="_blank">Annual report</a> <span>Opens in a new tab.</span></li>
<li><a href="/doc/handbook">Staff handbook</a> <span>Opens here.</span></li>
</ul></main>`,
  );

/** One task site: `url`, what happened on it (`events`), and the values a run's answers are checked against. */
export async function startTaskSite() {
  const events = [];
  const deleted = [];
  const sessions = new Set();
  const reportToken = randomBytes(4).toString('hex');
  const codeWord = `${['ember', 'harbor', 'quartz', 'willow', 'saffron', 'cobalt'][randomInt(6)]}-${randomInt(100, 1000)}`;
  const wizardCode = `WZ-${randomInt(1000, 10000)}`;
  const log = (event) => events.push({ at: Date.now(), ...event });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      response.writeHead(status, { 'content-type': type, ...headers });
      response.end(body);
    };
    const json = (value) => send(200, JSON.stringify(value), 'application/json');
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    };
    const signedIn = () => /(?:^|; )sid=(\w+)/.exec(request.headers.cookie ?? '')?.[1] !== undefined && sessions.has(/(?:^|; )sid=(\w+)/.exec(request.headers.cookie ?? '')[1]);

    if (path === '/') return send(200, shell('Test site', `<h1>Test site</h1>${NAV}<main><p>Pages for browser tasks.</p></main>`));
    if (path === '/login' && request.method === 'GET') return send(200, LOGIN_PAGE(''));
    if (path === '/login' && request.method === 'POST') {
      const form = new URLSearchParams(await readBody());
      const ok = form.get('username') === LOGIN_USER && form.get('password') === LOGIN_PASSWORD;
      log({ type: 'login', ok, username: form.get('username'), password: form.get('password') });
      if (!ok) return send(401, LOGIN_PAGE('Incorrect username or password.'));
      const sid = randomBytes(8).toString('hex');
      sessions.add(sid);
      return send(302, '', 'text/plain', { location: '/dashboard', 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
    }
    if (path === '/dashboard') return signedIn() ? send(200, DASHBOARD) : send(302, '', 'text/plain', { location: '/login' });
    if (path === '/logout') return send(302, '', 'text/plain', { location: '/login', 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    if (path === '/wizard') return send(200, WIZARD);
    if (path === '/api/wizard' && request.method === 'POST') {
      const body = JSON.parse(await readBody());
      log({ type: 'wizard', body });
      return json({ code: wizardCode });
    }
    if (path === '/feed') return send(200, FEED);
    if (path === '/api/feed') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const start = (page - 1) * FEED_PAGE + 1;
      const items = Array.from({ length: Math.max(0, Math.min(FEED_PAGE, FEED_TOTAL - start + 1)) }, (_, offset) => feedEntry(start + offset));
      log({ type: 'feed-page', page });
      return json({ items, more: start + FEED_PAGE <= FEED_TOTAL });
    }
    if (path === '/projects') return send(200, projectsPage(PROJECTS.filter((name) => !deleted.includes(name))));
    if (path === '/api/confirm' && request.method === 'POST') {
      log({ type: 'confirm', ...JSON.parse(await readBody()) });
      return json({ ok: true });
    }
    if (path === '/api/projects/delete' && request.method === 'POST') {
      const { name } = JSON.parse(await readBody());
      deleted.push(name);
      log({ type: 'delete', name });
      return json({ ok: true });
    }
    if (path === '/sales') return send(200, SALES_PAGE);
    if (path === '/api/sales') return json(SALES);
    if (path === '/library') return send(200, libraryPage(reportToken));
    if (path === `/report/${reportToken}`) {
      log({ type: 'report' });
      return send(200, shell('Annual report', `<h1>Annual report</h1>${NAV}<main><p>Code word: <strong>${codeWord}</strong></p><p>This report covers the last financial year.</p></main>`));
    }
    if (path.startsWith('/doc/')) return send(200, shell('Document', `<h1>Document</h1>${NAV}<main><p>Nothing to see here.</p></main>`));
    const { status, body } = benchPage(path);
    return send(status, body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    deleted,
    codeWord,
    wizardCode,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
