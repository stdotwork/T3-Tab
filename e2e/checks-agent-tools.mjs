// What an agent meets when it opens, reads and moves around pages, in a browser only the extension debugs: a tab
// opened in the background really is hidden here, and nothing answers prompts or dialogs for the extension.
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';

import {
  assert,
  closeServer,
  connectMcp,
  createHome,
  installNativeHost,
  launchUndrivenBrowser,
  listen,
  refFor,
  requireBuild,
  sleep,
  stopDaemon,
  text,
  waitForBrowser,
} from './harness.mjs';

const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const LONG_TEXT = `${'Plain words fill this long paragraph so the answer sits well past any display cut. '.repeat(14)}The limit answers with needle-429 here. ${'More words follow it. '.repeat(10)}`;

const PAGES = {
  '/start': page('Start', '<p>start page</p>'),
  '/private': page('Private', "<p>private page</p><script>fetch('/js-ran')</script>"),
  '/landing': page('Landing', '<p>landed</p>'),
  '/red': '<!doctype html><html><head><title>Red</title><style>html,body{margin:0;height:100%;background:#f00}</style></head><body><button onclick="this.textContent=\'pressed\'">Press</button></body></html>',
  '/painted': page('Painted', '<p id="r">not yet</p><script>requestAnimationFrame(() => requestAnimationFrame(() => { r.textContent = "painted by script"; }))</script>'),
  '/long': page('Long', `<p>${LONG_TEXT}</p>`),
  '/links': page(
    'Links',
    '<ul><li>One <a href="/items/1/edit">Edit</a></li><li>Two <a href="/items/2/edit?tab=a">Edit</a></li></ul><a href="/about">About us</a><a href="/picture"><img alt="" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></a>',
  ),
  '/keys': page('Keys', '<p id="k"></p><script>addEventListener("keydown",(e)=>{e.preventDefault();k.textContent+=e.key+","})</script>'),
  '/dialog': page('Dialog', '<button onclick="r.textContent=confirm(\'sure?\')?\'yes\':\'no\'">Ask</button><p id="r">none</p>'),
  '/nest': page('Nest', '<nav aria-label="Outer"><ul aria-label="Inner"><li><a href="/deep">Deep link</a></li></ul></nav><button>Shallow</button>'),
  '/form-post': page('Post form', '<form method="post" action="/posted"><button>Send</button></form>'),
  '/posted': page('Posted', '<p>sent</p>'),
  '/one': page('One', '<p>first</p>'),
  '/tall': page('Tall', '<div style="height:6000px">tall page</div>'),
  '/trap': page('Trap', '<div style="height:6000px">wheel trap</div><script>addEventListener("wheel", (event) => event.preventDefault(), { passive: false })</script>'),
  '/clip': '<!doctype html><html style="overflow:clip"><head><title>Clip</title></head><body><div style="height:6000px">clipped page</div></body></html>',
  '/contained': '<!doctype html><html><head><title>Contained</title></head><body><div style="height:6000px">tall page</div><div id="box" style="position:fixed;inset:0;overflow:auto;overscroll-behavior:contain"><p>short content</p></div></body></html>',
  '/inner': '<!doctype html><html><head><title>Inner</title><style>html,body{margin:0;overflow:hidden}</style></head><body><div id="box" style="position:fixed;inset:0;overflow:auto"><div style="height:6000px">inner scroller</div></div></body></html>',
  '/two': page('Two', '<p>second</p>'),
};

export async function checkAgentTools() {
  const home = await createHome();
  const hits = { allowed: [], ask: [], other: [] };
  let urls;
  const serve = (name) =>
    createServer((request, response) => {
      const { pathname } = new URL(request.url ?? '/', 'http://x');
      hits[name].push(request.method === 'POST' ? `POST ${pathname}` : pathname);
      request.resume();
      if (pathname === '/to-other') {
        response.writeHead(302, { location: `${urls.other}/landing` });
        response.end();
        return;
      }
      if (pathname === '/same-site') {
        response.writeHead(302, { location: '/landing' });
        response.end();
        return;
      }
      const body = PAGES[pathname];
      response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body ?? 'not found');
    });
  const servers = { allowed: serve('allowed'), ask: serve('ask'), other: serve('other') };
  let browser;
  let mcp;
  let idle;
  const failures = [];
  try {
    await requireBuild(home);
    await Promise.all(Object.values(servers).map(listen));
    urls = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, `http://127.0.0.1:${server.address().port}`]));
    await installNativeHost(home);
    browser = await launchUndrivenBrowser(home, `${urls.allowed}/start`);
    mcp = await connectMcp(home, 'agent-tools');
    await waitForBrowser(mcp.client);
    await browser.panel({ type: 'panel.setSite', origin: urls.allowed, setting: 'allow' });

    const call = async (name, args, client = mcp.client) => {
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
        return { error: result.isError === true, text: text(result), content: result.content };
      } catch (error) {
        return { error: true, text: `no reply: ${error.message}`, content: [] };
      }
    };
    const pending = async () => (await browser.panel({ type: 'panel.state' })).pending ?? [];
    const waitPrompt = async (match) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const prompt = (await pending()).find(match);
        if (prompt !== undefined) return prompt;
        await sleep(50);
      }
      throw new Error('no prompt appeared');
    };
    const decide = (prompt, decision) => browser.panel({ type: 'panel.decide', promptId: prompt.id, decision });
    const tabCount = () => browser.worker('chrome.tabs.query({}).then((tabs) => tabs.length)');
    const frontTab = () => browser.worker('chrome.tabs.query({ active: true }).then((tabs) => tabs[0].id)');
    const tabInfo = (id) => browser.worker(`chrome.tabs.get(${id}).then((t) => ({ active: t.active, groupId: t.groupId, url: t.url }))`);
    const opened = (reply) => {
      const id = Number(/^Opened tab (\d+)/.exec(reply.text)?.[1]);
      assert(Number.isInteger(id), `tabs open: ${reply.text}`);
      return id;
    };
    const openAllowed = async (path) => opened(await call('tabs', { action: 'open', url: `${urls.allowed}${path}` }));
    const closeTab = (tab) => call('tabs', { action: 'close', tab });
    const check = async (name, run) => {
      try {
        await run();
        console.log(`Agent tools: ${name}`);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        for (const prompt of await pending().catch(() => [])) await decide(prompt, 'decline').catch(() => undefined);
      }
    };

    await check('tabs open asks first, with the address, and loads nothing until allowed', async () => {
      const before = await tabCount();
      const reply = call('tabs', { action: 'open', url: `${urls.ask}/private?x=1` });
      const prompt = await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask);
      assert(hits.ask.length === 0, `the page was fetched before the answer: ${hits.ask.join(' ')}`);
      assert((await tabCount()) === before, 'a tab was created before the answer');
      assert(prompt.tab === undefined, `the prompt names a tab that does not exist yet: ${JSON.stringify(prompt.tab)}`);
      assert(prompt.url === `${urls.ask}/private?x=1`, `the prompt does not show the address: ${prompt.url}`);
      await decide(prompt, 'decline');
      const declined = await reply;
      assert(declined.error && /declined/i.test(declined.text), `decline: ${declined.text}`);
      assert(hits.ask.length === 0, `a declined page was fetched: ${hits.ask.join(' ')}`);
      assert((await tabCount()) === before, 'a declined open left a tab');

      const again = call('tabs', { action: 'open', url: `${urls.ask}/private` });
      await decide(await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask), 'allow-once');
      const tab = opened(await again);
      for (let attempt = 0; attempt < 40 && !hits.ask.includes('/js-ran'); attempt += 1) await sleep(50);
      assert(hits.ask.includes('/private') && hits.ask.includes('/js-ran'), `the allowed page did not load: ${hits.ask.join(' ')}`);
      await closeTab(tab);
    });

    await check('a prompt keeps a credential-bearing address from naming another site', async () => {
      const reply = call('tabs', { action: 'open', url: `${urls.ask.replace('http://', 'http://trusted.example:pw@')}/private` });
      const prompt = await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask);
      assert(prompt.url === `${urls.ask}/private`, `the prompt shows ${prompt.url}`);
      await decide(prompt, 'decline');
      await reply;
    });

    await check('a tab opens in the background and every tool works on it', async () => {
      const front = await frontTab();
      const tab = await openAllowed('/red');
      assert((await frontTab()) === front, 'opening a tab took the owner away from their tab');
      const info = await tabInfo(tab);
      assert(info.active === false, 'the new tab is in front');
      assert(info.groupId !== -1, 'the new tab is not in the session group');

      const read = await call('read', {});
      assert(!read.error && read.text.startsWith(`tab ${tab}`), `read without a tab did not use the new tab: ${read.text}`);
      const ref = refFor(read.text, 'button "Press"');
      const acted = await call('act', { steps: [{ action: 'click', ref }] });
      assert(!acted.error && acted.text.includes('pressed'), `act without a tab: ${acted.text}`);
      const js = await call('run_js', { expression: 'document.title' });
      assert(js.text === '"Red"', `run_js without a tab: ${js.text}`);
      const shot = await call('screenshot', {});
      const image = shot.content.find((item) => item.type === 'image');
      assert(image !== undefined, `screenshot: ${shot.text}`);
      const pixel = await browser.worker(`(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(image.data)}), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return [...context.getImageData(bitmap.width - 5, bitmap.height - 5, 1, 1).data];
      })()`);
      assert(pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60, `the screenshot of a background tab is not the page: ${pixel}`);
      assert((await frontTab()) === front, 'a tool brought the background tab to the front');
      const list = await call('tabs', {});
      assert(new RegExp(`^${tab} \\[current\\]`, 'm').test(list.text), `the list does not mark the current tab: ${list.text}`);
      await closeTab(tab);

      const painted = await openAllowed('/painted');
      const content = await call('read', { tab: painted, all: true });
      assert(content.text.includes('painted by script'), `a page that renders in animation frames stayed blank in the background: ${content.text}`);
      let visibility;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        visibility = await call('run_js', { tab: painted, expression: 'document.visibilityState' });
        if (visibility.text === '"hidden"') break;
        await sleep(100);
      }
      assert(visibility.text === '"hidden"', `the tab did not go back to hidden: ${visibility.text}`);
      await closeTab(painted);
    });

    await check('a redirect to another origin keeps the tab, unapproved, and says where it went', async () => {
      const reply = call('tabs', { action: 'open', url: `${urls.ask}/to-other` });
      await decide(await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask), 'allow-once');
      const result = await reply;
      assert(!result.error, `the redirect failed the open: ${result.text}`);
      const tab = opened(result);
      assert(result.text.includes('[needs approval]') && result.text.includes(urls.other), `the reply does not say where it went: ${result.text}`);
      assert(!result.text.includes('Landing'), `the reply shows an unapproved page's title: ${result.text}`);
      assert((await tabInfo(tab)).groupId !== -1, 'the redirected tab left the session group');
      const list = await call('tabs', {});
      assert(list.text.includes(`${tab} [current] [needs approval] ${urls.other}`), `tabs list: ${list.text}`);
      const read = call('read', { tab });
      const prompt = await waitPrompt((item) => item.tool === 'read' && item.origin === urls.other);
      await decide(prompt, 'decline');
      assert((await read).error, 'an unapproved redirect target was read');
      await closeTab(tab);
    });

    await check('a redirect to an allowed origin, or within the site, just carries on', async () => {
      await browser.panel({ type: 'panel.setSite', origin: urls.other, setting: 'allow' });
      const reply = call('tabs', { action: 'open', url: `${urls.ask}/to-other` });
      await decide(await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask), 'allow-once');
      const result = await reply;
      const tab = opened(result);
      assert(!result.text.includes('[needs approval]') && result.text.includes('Landing'), `allowed target: ${result.text}`);
      const read = await call('read', { tab, all: true });
      assert(!read.error && read.text.includes('landed'), `read of an allowed target: ${read.text}`);
      await closeTab(tab);
      await browser.panel({ type: 'panel.setSite', origin: urls.other, setting: 'ask' });
      const same = await openAllowed('/same-site');
      const samePage = await call('read', { tab: same, all: true });
      assert(samePage.text.includes('landed'), `a same-site redirect: ${samePage.text}`);
      await closeTab(same);
    });

    await check('find reaches text past the display cut, and every cut is marked', async () => {
      const tab = await openAllowed('/long');
      const found = await call('read', { tab, find: 'needle-429' });
      assert(!found.error && found.text.includes('needle-429'), `find missed text in a long paragraph: ${found.text}`);
      assert(found.text.includes('…'), `the cut around the match is not marked: ${found.text}`);
      assert(found.text.length < 900, `a find reply carried the whole paragraph (${found.text.length} characters)`);
      const all = await call('read', { tab, all: true });
      assert(/…"$/m.test(all.text), `a cut paragraph has no mark: ${all.text.slice(0, 500)}`);
      await closeTab(tab);
    });

    await check('a scroll moves the page or says it did not, and a screenshot of a background tab gives up soon', async () => {
      const scrollY = async (tab, expression = 'window.scrollY') => Number((await call('run_js', { tab, expression })).text);
      const tab = await openAllowed('/tall');
      const front = await frontTab();
      assert((await tabInfo(tab)).active === false && front !== tab, 'the tab to scroll is in front');
      // A background tab that has been idle for a few seconds takes the wheel event and may move nothing. Reporting
      // success with no movement is what must never happen.
      await sleep(3_000);
      const hidden = await call('act', { tab, steps: [{ action: 'scroll', dy: 3000 }] });
      const hiddenY = await scrollY(tab);
      if (hidden.error) assert(/did not scroll/.test(hidden.text) && /in the background/.test(hidden.text) && !/tabs switch/.test(hidden.text), `a failed scroll does not say why: ${hidden.text}`);
      else assert(hiddenY > 0, `the scroll was reported as done but the page is at ${hiddenY}: ${hidden.text}`);

      // In front it scrolls, and that is reported.
      await call('tabs', { action: 'switch', tab });
      const before = await scrollY(tab);
      const shown = await call('act', { tab, steps: [{ action: 'scroll', dy: 1000 }] });
      assert(!shown.error, `a scroll in front failed: ${shown.text}`);
      assert((await scrollY(tab)) > before, `the page in front did not scroll: ${before} -> ${await scrollY(tab)}`);
      await browser.worker(`chrome.tabs.update(${front}, { active: true })`);
      await closeTab(tab);

      // The element under the pointer counts as well as the page.
      const inner = await openAllowed('/inner');
      await call('tabs', { action: 'switch', tab: inner });
      const innerReply = await call('act', { tab: inner, steps: [{ action: 'scroll', dy: 800 }] });
      assert(!innerReply.error, `a scroll of an element in front failed: ${innerReply.text}`);
      assert((await scrollY(inner, 'document.getElementById("box").scrollTop')) > 0, 'the element did not scroll');
      await browser.worker(`chrome.tabs.update(${front}, { active: true })`);
      await closeTab(inner);

      // Where the wheel cannot move the page whatever the tab shows, nothing is reported: the root is clipped, or a
      // scroller that keeps the wheel to itself sits under the pointer and has no room.
      for (const path of ['/clip', '/contained']) {
        const blocked = await openAllowed(path);
        const refused = await call('act', { tab: blocked, steps: [{ action: 'scroll', dy: 500 }] });
        assert(!refused.error, `a scroll on ${path} failed though the wheel cannot move it: ${refused.text}`);
        await closeTab(blocked);
      }

      // A tab the owner can see is never failed for not moving: a page may take the wheel itself.
      const trap = await openAllowed('/trap');
      await call('tabs', { action: 'switch', tab: trap });
      const trapStarted = Date.now();
      const trapped = await call('act', { tab: trap, steps: [{ action: 'scroll', dy: 500 }] });
      assert(!trapped.error, `a scroll in front of a page that takes the wheel failed: ${trapped.text}`);
      assert(Date.now() - trapStarted < 1_500, `a scroll in front waited ${Date.now() - trapStarted} ms for a page that took the wheel`);
      await browser.worker(`chrome.tabs.update(${front}, { active: true })`);
      await closeTab(trap);

      // A page with nothing to scroll is not an error, and is not waited on.
      const flat = await openAllowed('/one');
      const started = Date.now();
      const nothing = await call('act', { tab: flat, steps: [{ action: 'scroll', dy: 500 }] });
      assert(!nothing.error, `a scroll on a page with nothing to scroll failed: ${nothing.text}`);
      assert(Date.now() - started < 1_500, `a scroll with nothing to move took ${Date.now() - started} ms`);
      await closeTab(flat);

      // A background tab that has been idle gives no frame: the capture ends in seconds, with a reason, or works.
      const idle = await openAllowed('/red');
      await sleep(2_500);
      const shot = Date.now();
      const picture = await call('screenshot', { tab: idle });
      const took = Date.now() - shot;
      assert(took < 6_000, `the screenshot of an idle background tab took ${took} ms`);
      if (picture.error) assert(/no picture of the page/.test(picture.text) && /in the background/.test(picture.text) && !/tabs switch/.test(picture.text), `a failed screenshot does not say why: ${picture.text}`);
      else assert(picture.content.some((item) => item.type === 'image'), `a screenshot without an image: ${picture.text}`);
      await closeTab(idle);
    });

    await check('an empty session is told what to do', async () => {
      idle = await connectMcp(home, 'agent-tools-empty');
      const list = await call('tabs', {}, idle.client);
      assert(/open/.test(list.text) && /share/.test(list.text), `tabs: ${list.text}`);
      const acted = await call('act', { steps: [{ action: 'press', key: 'Enter' }] }, idle.client);
      assert(acted.error && /open/i.test(acted.text) && /share/.test(acted.text), `act: ${acted.text}`);
    });

    await check('read shows the address of links it cannot otherwise tell apart', async () => {
      const tab = await openAllowed('/links');
      const read = await call('read', { tab, full: true });
      assert(read.text.includes('/items/1/edit') && read.text.includes('/items/2/edit?tab=a'), `two Edit links: ${read.text}`);
      assert(!read.text.includes(urls.allowed.slice(7) + '/items'), `a same-site address is not shortened: ${read.text}`);
      assert(read.text.includes('/picture'), `a link with no name: ${read.text}`);
      assert(!/About us"[^\n]*\/about/.test(read.text), `a link with a unique name spent tokens on its address: ${read.text}`);
      const about = refFor(read.text, 'About us');
      const subtree = await call('read', { tab, ref: about });
      assert(subtree.text.includes('/about'), `a subtree read of a link: ${subtree.text}`);
      await closeTab(tab);
    });

    await check('press takes the obvious key spellings', async () => {
      const tab = await openAllowed('/keys');
      for (const key of ['enter', 'ESC', 'tab', 'F5', 'f12', 'pagedown', 'space', 'up', ' ']) {
        const acted = await call('act', { tab, steps: [{ action: 'press', key }] });
        assert(!acted.error, `press ${key}: ${acted.text}`);
      }
      const keys = await call('run_js', { tab, expression: 'k.textContent' });
      assert(keys.text === '"Enter,Escape,Tab,F5,F12,PageDown, ,ArrowUp, ,"', `keys the page saw: ${keys.text}`);
      await closeTab(tab);

      const dialog = await openAllowed('/dialog');
      const page = await call('read', { tab: dialog });
      await call('act', { tab: dialog, steps: [{ action: 'click', ref: refFor(page.text, 'button "Ask"') }, { action: 'press', key: 'enter' }] });
      const answered = await call('run_js', { tab: dialog, expression: 'r.textContent' });
      assert(answered.text === '"yes"', `a dialog answered with "enter": ${answered.text}`);
      await closeTab(dialog);
    });

    await check('tabs goes to an address, back, forward and reloads', async () => {
      const tab = await openAllowed('/one');
      const went = await call('tabs', { action: 'goto', tab, url: `${urls.allowed}/two` });
      assert(!went.error && went.text.includes('Two'), `goto: ${went.text}`);
      const back = await call('tabs', { action: 'back', tab });
      assert(!back.error && back.text.includes('One'), `back: ${back.text}`);
      const forward = await call('tabs', { action: 'forward', tab });
      assert(!forward.error && forward.text.includes('Two'), `forward: ${forward.text}`);
      const loads = hits.allowed.filter((path) => path === '/two').length;
      const reload = await call('tabs', { action: 'reload', tab });
      assert(!reload.error && hits.allowed.filter((path) => path === '/two').length === loads + 1, `reload: ${reload.text}`);
      const read = await call('read', { tab, all: true });
      assert(read.text.includes('second'), `read after reload: ${read.text}`);

      const seen = hits.other.length;
      const leave = call('tabs', { action: 'goto', tab, url: `${urls.other}/one` });
      const prompt = await waitPrompt((item) => item.tool === 'open' && item.origin === urls.other);
      assert(hits.other.length === seen, 'goto loaded a new origin before asking');
      assert(prompt.url === `${urls.other}/one` && prompt.tab?.id === tab, `goto prompt: ${JSON.stringify(prompt)}`);
      await decide(prompt, 'decline');
      assert((await leave).error, 'a declined goto went through');
      assert((await tabInfo(tab)).url === `${urls.allowed}/two`, 'a declined goto moved the tab');

      const first = await call('tabs', { action: 'back', tab });
      assert(!first.error, `back: ${first.text}`);
      const none = await call('tabs', { action: 'back', tab });
      assert(none.error && /earlier/.test(none.text), `back with no earlier page: ${none.text}`);
      await closeTab(tab);
    });

    await check('goto is refused when the tab moved while its prompt waited', async () => {
      const tab = await openAllowed('/one');
      const seen = hits.other.length;
      const going = call('tabs', { action: 'goto', tab, url: `${urls.other}/two` });
      const prompt = await waitPrompt((item) => item.tool === 'open' && item.origin === urls.other);
      await call('run_js', { tab, expression: `location.href = ${JSON.stringify(`${urls.ask}/start`)}; 0` });
      for (let attempt = 0; attempt < 60 && !(await tabInfo(tab)).url.startsWith(urls.ask); attempt += 1) await sleep(50);
      await decide(prompt, 'allow-once');
      const result = await going;
      assert(result.error && /moved/.test(result.text), `goto from a tab that moved: ${result.text}`);
      assert(hits.other.length === seen, `the approved page was loaded over one nobody approved: ${hits.other.join(' ')}`);
      assert((await tabInfo(tab)).url === `${urls.ask}/start`, `the tab was moved: ${(await tabInfo(tab)).url}`);
      await closeTab(tab);
    });

    await check('back and forward between entries of one document return at once', async () => {
      const tab = await openAllowed('/one');
      await call('run_js', { tab, expression: "history.pushState({}, '', '/one/next'); 0" });
      for (const [action, path] of [['back', '/one'], ['forward', '/one/next']]) {
        const started = Date.now();
        const moved = await call('tabs', { action, tab });
        assert(!moved.error, `${action}: ${moved.text}`);
        assert(Date.now() - started < 3_000, `${action} within one document took ${Date.now() - started} ms`);
        const where = await call('run_js', { tab, expression: 'location.pathname' });
        assert(where.text === JSON.stringify(path), `${action} ended at ${where.text}`);
      }
      await closeTab(tab);
    });

    await check('reload never sends a form again', async () => {
      const tab = await openAllowed('/form-post');
      const form = await call('read', { tab });
      await call('act', { tab, steps: [{ action: 'click', ref: refFor(form.text, 'button "Send"') }] });
      assert(hits.allowed.filter((hit) => hit === 'POST /posted').length === 1, `the form was not sent once: ${hits.allowed.join(' ')}`);
      const entries = () => call('run_js', { tab, expression: 'history.length' });
      const before = (await entries()).text;
      const reload = await call('tabs', { action: 'reload', tab });
      assert(!reload.error && reload.text.includes('Posted'), `reload: ${reload.text}`);
      assert(hits.allowed.filter((hit) => hit === 'POST /posted').length === 1, `reload sent the form again: ${hits.allowed.join(' ')}`);
      assert(hits.allowed.at(-1) === '/posted', `reload did not fetch the page: ${hits.allowed.at(-1)}`);
      assert((await entries()).text === before, 'reload added a history entry');
      await closeTab(tab);
    });

    await check('depth marks elements with more inside', async () => {
      const tab = await openAllowed('/nest');
      const read = await call('read', { tab, depth: 0 });
      assert(/navigation "Outer" …/.test(read.text), `no marker on the clipped element: ${read.text}`);
      assert(!/button "Shallow" …/.test(read.text), `a marker on an element with nothing hidden: ${read.text}`);
      await closeTab(tab);
    });

    await check('an action leaves nothing in the page for a site to find', async () => {
      const tab = await openAllowed('/red');
      const globals = async () => JSON.parse((await call('run_js', { tab, expression: 'Object.getOwnPropertyNames(globalThis).filter((name) => !/^(on|webkit|[A-Z])/.test(name))' })).text);
      const before = new Set(await globals());
      const page = await call('read', { tab });
      await call('act', { tab, steps: [{ action: 'click', ref: refFor(page.text, 'button "Press"') }] });
      const added = (await globals()).filter((name) => !before.has(name));
      assert(added.length === 0, `page-visible globals: ${added.join(' ')}`);
      await closeTab(tab);
    });
  } finally {
    if (idle !== undefined) await idle.client.close().catch(() => undefined);
    if (mcp !== undefined) await mcp.client.close().catch(() => undefined);
    if (browser !== undefined) await browser.close();
    await Promise.all(Object.values(servers).map(closeServer));
    await stopDaemon(home.statePath);
    await rm(home.tempHome, { recursive: true, force: true });
  }
  if (failures.length > 0) throw new Error(`Agent tool checks failed:\n${failures.join('\n')}`);
}

if (process.argv[1]?.endsWith('checks-agent-tools.mjs')) {
  await checkAgentTools();
  console.log('Agent tool checks passed');
  process.exit(0);
}
