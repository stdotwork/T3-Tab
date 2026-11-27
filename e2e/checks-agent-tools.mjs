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

/** A page too long to send whole, with an order form after its 200 items; sent, the form comes back with an error in it. */
const catalogue = (ordered) =>
  `<!doctype html><html lang="en"><head><title>${ordered ? 'Check your order' : 'Catalogue'}</title></head><body>` +
  `<nav aria-label="Departments">${Array.from({ length: 12 }, (_, index) => `<a href="/d${index + 1}">Department ${index + 1}</a>`).join(' ')}</nav>` +
  `<main><h1>Catalogue</h1><p>${'Every item ships within two working days from the warehouse nearest to you. '.repeat(6)}</p><ul>` +
  Array.from({ length: 200 }, (_, index) => `<li><a href="/item/${index + 1}">Item ${index + 1}</a> <span>A field item for long trips, ${200 + index} grams.</span></li>`).join('') +
  `</ul><form aria-label="Order" action="/ordered" method="get"><label>Email <input name="email"${ordered ? ' aria-invalid="true"' : ''}></label>` +
  `${ordered ? '<p>Enter an email address with an @ in it.</p>' : ''}<button>Place order</button></form></main></body></html>`;

const PAGES = {
  '/catalogue': catalogue(false),
  '/ordered': catalogue(true),
  '/start': page('Start', '<p>start page</p>'),
  '/private': page('Private', "<p>private page</p><script>fetch('/js-ran')</script>"),
  '/landing': page('Landing', '<p>landed</p>'),
  '/red': '<!doctype html><html><head><title>Red</title><style>html,body{margin:0;height:100%;background:#f00}</style></head><body><button onclick="this.textContent=\'pressed\'">Press</button></body></html>',
  '/painted': page('Painted', '<p id="r">not yet</p><script>requestAnimationFrame(() => requestAnimationFrame(() => { r.textContent = "painted by script"; }))</script>'),
  '/long': page('Long', `<p>${LONG_TEXT}</p>`),
  '/novel': page('Novel', Array.from({ length: 60 }, (_, index) => `<p>Paragraph ${index + 1} of a page whose text alone is longer than a load's reply can carry.</p>`).join('')),
  '/huge': page('Huge', Array.from({ length: 60 }, (_, index) => `<button>Item ${index + 1}</button><p>Line ${index + 1} of a page too long for a load's reply.</p>`).join('')),
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
  '/jump-select': page(
    'Jump select',
    '<select aria-label="Section" onchange="location.href = \'/landing\'"><option>Pick</option><option>Landing</option></select><label>Note <input id="note"></label>',
  ),
  '/debounced': page(
    'Debounced',
    '<label>Code <input id="code" oninput="clearTimeout(window.later); window.later = setTimeout(() => { send.disabled = false }, 100)"></label><button id="send" disabled onclick="fetch(\'/submitted\')">Send</button>',
  ),
  '/slow-field': page(
    'Slow field',
    '<label>Code <input id="code" oninput="fetch(\'/hint\').then(() => { hint.textContent = \'checked\' })"></label><button onclick="seen.textContent = hint.textContent">Send</button><p id="hint">unchecked</p><p id="seen">nothing</p>',
  ),
  '/tall': page('Tall', '<div style="height:6000px">tall page</div>'),
  '/trap': page('Trap', '<div style="height:6000px">wheel trap</div><script>addEventListener("wheel", (event) => event.preventDefault(), { passive: false })</script>'),
  '/clip': '<!doctype html><html style="overflow:clip"><head><title>Clip</title></head><body><div style="height:6000px">clipped page</div></body></html>',
  '/contained': '<!doctype html><html><head><title>Contained</title></head><body><div style="height:6000px">tall page</div><div id="box" style="position:fixed;inset:0;overflow:auto;overscroll-behavior:contain"><div style="height:3000px">long content</div></div><script>box.scrollTop = box.scrollHeight</script></body></html>',
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
      if (pathname === '/hint') {
        setTimeout(() => response.end('ok'), 60);
        return;
      }
      if (pathname === '/to-other') {
        response.writeHead(302, { location: `${urls.other}/landing` });
        response.end();
        return;
      }
      if (pathname === '/opener') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          page(
            'Opener',
            `<a href="/landing" target="_blank">Same site report</a><button onclick="window.open('${urls.ask}/private')">Other site</button>` +
              '<a href="/to-other" target="_blank">Redirected report</a><button onclick="window.open(\'\')">Blank</button><p id="state">ready</p>',
          ),
        );
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
    await waitForBrowser(home);
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
    // A load replies with the page, so its refs come from the reply and a read after it has nothing new.
    const openAllowedPage = async (path) => {
      const reply = await call('tabs', { action: 'open', url: `${urls.allowed}${path}` });
      return { tab: opened(reply), text: reply.text };
    };
    const openAllowed = async (path) => (await openAllowedPage(path)).tab;
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
      const loaded = await again;
      const tab = opened(loaded);
      assert(loaded.text.includes('"private page"'), `the open reply does not carry the page: ${loaded.text}`);
      assert((await pending()).length === 0, 'reading the page it opened asked again');
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
      const { tab, text: loaded } = await openAllowedPage('/red');
      assert((await frontTab()) === front, 'opening a tab took the owner away from their tab');
      const info = await tabInfo(tab);
      assert(info.active === false, 'the new tab is in front');
      assert(info.groupId !== -1, 'the new tab is not in the session group');

      const read = await call('read', {});
      assert(!read.error && read.text.startsWith(`tab ${tab}`), `read without a tab did not use the new tab: ${read.text}`);
      assert(read.text.endsWith('No changes since the last read.'), `the open reply is not the read baseline: ${read.text}`);
      const ref = refFor(loaded, 'button "Press"');
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

      const { tab: painted, text: paintedReply } = await openAllowedPage('/painted');
      assert(paintedReply.includes('painted by script'), `the open reply is from before the page drew: ${paintedReply}`);
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

    await check('a session that reached for the tools by itself gets a collapsed group, and act, scroll and screenshot work in it', async () => {
      const group = (tab) => browser.worker(`chrome.tabs.get(${tab}).then((t) => t.groupId < 0 ? undefined : chrome.tabGroups.get(t.groupId)).then((g) => g && { id: g.id, collapsed: g.collapsed, title: g.title })`);
      const front = await frontTab();
      // One of the owner's own groups, collapsed and expanded, that nothing the session does may change.
      const ownerTabs = await browser.worker(`Promise.all([chrome.tabs.create({ url: 'about:blank', active: false }), chrome.tabs.create({ url: 'about:blank', active: false })]).then((tabs) => tabs.map((t) => t.id))`);
      const ownerGroups = await browser.worker(`(async () => {
        const shut = await chrome.tabs.group({ tabIds: [${ownerTabs[0]}] });
        const open = await chrome.tabs.group({ tabIds: [${ownerTabs[1]}] });
        await chrome.tabGroups.update(shut, { collapsed: true, title: 'Owner shut' });
        await chrome.tabGroups.update(open, { collapsed: false, title: 'Owner open' });
        return [shut, open];
      })()`);
      const { tab, text: loaded } = await openAllowedPage('/red');
      const first = await group(tab);
      assert(first?.collapsed === true, `the group of a self-started session is not collapsed: ${JSON.stringify(first)}`);
      assert(first.title.startsWith('agent-tools ·'), `the group does not name the session: ${JSON.stringify(first)}`);
      // Straight after the load, as for any background tab: one left idle for seconds draws no frame, group or not.
      const shot = await call('screenshot', { tab });
      assert(shot.content.some((item) => item.type === 'image'), `a screenshot of a collapsed group's tab: ${shot.text}`);
      const acted = await call('act', { tab, steps: [{ action: 'click', ref: refFor(loaded, 'button "Press"') }] });
      assert(!acted.error && acted.text.includes('pressed'), `a click in a collapsed group's tab: ${acted.text}`);
      // Scrolled straight after its load too: a background tab idle for seconds may take no wheel, which the scroll
      // check below covers for any background tab.
      const tall = await openAllowed('/tall');
      assert((await group(tall))?.id === first.id && (await group(tall)).collapsed === true, `a second tab expanded the group or went elsewhere: ${JSON.stringify(await group(tall))}`);
      const scrolled = await call('act', { tab: tall, steps: [{ action: 'scroll', dy: 2000 }] });
      const scrollY = Number((await call('run_js', { tab: tall, expression: 'window.scrollY' })).text);
      assert(!scrolled.error && scrollY > 0, `a scroll in a collapsed group's tab: ${scrollY}, ${scrolled.text}`);
      const after = await group(tab);
      assert(after?.collapsed === true, `a tool expanded the group: ${JSON.stringify(after)}`);
      assert((await frontTab()) === front && (await tabInfo(tab)).active === false, 'a tool in a collapsed group took the owner\'s view');

      // The owner expands it; the session's next tab does not collapse it again.
      await browser.worker(`chrome.tabGroups.update(${first.id}, { collapsed: false })`);
      const third = await openAllowed('/one');
      assert((await group(third))?.collapsed === false, `a new tab collapsed the group the owner expanded: ${JSON.stringify(await group(third))}`);
      const owners = await browser.worker(`Promise.all([${ownerGroups[0]}, ${ownerGroups[1]}].map((id) => chrome.tabGroups.get(id))).then((groups) => groups.map((g) => g.collapsed))`);
      assert(owners[0] === true && owners[1] === false, `the session changed the owner's own groups: ${JSON.stringify(owners)}`);
      console.log(`Agent tools: group ${first.id} "${first.title}" created collapsed; click, scroll (to ${scrollY}) and screenshot worked with it collapsed; the owner's expand held over a new tab; the owner's groups kept their state`);
      for (const id of [tab, tall, third]) await closeTab(id);
      await browser.worker(`chrome.tabs.remove(${JSON.stringify(ownerTabs)})`);
    });

    await check('a long page is left out of the load reply and comes with the read after it', async () => {
      const { tab, text: loaded } = await openAllowedPage('/huge');
      assert(/too long for this reply: read shows it, find searches it/.test(loaded) && !loaded.includes('Item 1'), `the load reply of a long page: ${loaded}`);
      const read = await call('read', { tab });
      assert(read.text.includes('button "Item 60"') && read.text.includes('Line 60'), `the read after a left-out page: ${read.text.slice(0, 300)}`);
      const full = await call('read', { tab, full: true });
      assert(full.text.includes('button "Item 60"'), `a full read after it: ${full.text.slice(0, 300)}`);
      // A page whose text alone is too long is not read for the load at all, and find still reads it.
      const novel = await call('tabs', { action: 'open', url: `${urls.allowed}/novel` });
      assert(/characters of text, too long for this reply/.test(novel.text) && !novel.text.includes('Paragraph 1'), `the load reply of a page of long text: ${novel.text}`);
      const novelTab = opened(novel);
      const found = await call('tabs', { action: 'goto', tab: novelTab, url: `${urls.allowed}/novel#end`, find: 'Paragraph 60' });
      assert(found.text.includes('Paragraph 60'), `find on a load of a page of long text: ${found.text}`);
      await closeTab(novelTab);
      const short = await openAllowedPage('/one');
      const again = await call('read', { tab: short.tab, full: true });
      assert(/^tab \d+\nNo changes since the load's reply, which showed the whole page\.$/.test(again.text), `a full read right after a short load: ${again.text}`);
      await closeTab(tab);
      await closeTab(short.tab);
    });

    await check('a redirect to another origin keeps the tab, unapproved, and says where it went', async () => {
      const reply = call('tabs', { action: 'open', url: `${urls.ask}/to-other` });
      await decide(await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask), 'allow-once');
      const result = await reply;
      assert(!result.error, `the redirect failed the open: ${result.text}`);
      const tab = opened(result);
      assert(result.text.includes('[needs approval]') && result.text.includes(urls.other), `the reply does not say where it went: ${result.text}`);
      assert(!result.text.includes('Landing') && !result.text.includes('landed'), `the reply shows an unapproved page: ${result.text}`);
      assert(/read this tab to ask/.test(result.text), `the reply does not say how to ask: ${result.text}`);
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
      assert(result.text.includes('"landed"'), `the reply does not carry an allowed target's page: ${result.text}`);
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
      assert(!acted.text.includes('\n'), `the no-tab error is more than one line: ${acted.text}`);
    });

    await check('read and goto with a url open a tab in an empty session, asking as open does', async () => {
      const fresh = await connectMcp(home, 'agent-tools-fresh');
      try {
        const before = await tabCount();
        const seen = hits.ask.length;
        const reply = call('read', { url: `${urls.ask}/private`, find: 'page' }, fresh.client);
        const prompt = await waitPrompt((item) => item.tool === 'open' && item.origin === urls.ask);
        assert(hits.ask.length === seen, `the page was fetched before the answer: ${hits.ask.slice(seen).join(' ')}`);
        assert((await tabCount()) === before, 'a tab was created before the answer');
        assert(prompt.tab === undefined && prompt.url === `${urls.ask}/private`, `read's open prompt: ${JSON.stringify(prompt)}`);
        await decide(prompt, 'allow-once');
        const result = await reply;
        assert(!result.error && /^Opened tab \d+ \[current\]: Private/.test(result.text), `read with a url: ${result.text}`);
        assert(result.text.includes('"private page"'), `find on the load: ${result.text}`);
        const tab = opened(result);
        assert((await tabInfo(tab)).groupId !== -1, 'the tab read opened is not in the session group');

        const goto = await call('tabs', { action: 'goto', url: `${urls.allowed}/long`, find: 'needle-429' }, fresh.client);
        assert(!goto.error && goto.text.startsWith(`Loaded tab ${tab} [current]: Long`), `goto with a tab moves it: ${goto.text}`);
        assert(goto.text.includes('needle-429') && goto.text.length < 900, `find on goto: ${goto.text}`);
        await call('tabs', { action: 'close', tab }, fresh.client);
        const reopened = await call('tabs', { action: 'goto', url: `${urls.allowed}/two` }, fresh.client);
        assert(!reopened.error && /^Opened tab \d+ \[current\]: Two/.test(reopened.text) && reopened.text.includes('second'), `goto with no tab: ${reopened.text}`);
        await call('tabs', { action: 'close', tab: opened(reopened) }, fresh.client);
      } finally {
        await fresh.client.close().catch(() => undefined);
      }
    });

    await check('read with a url reads a tab already at the address and never moves one', async () => {
      const tab = await openAllowed('/one');
      const marked = await call('run_js', { tab, expression: '(window.keptAcrossRead = 1)' });
      assert(marked.text === '1', `run_js: ${marked.text}`);
      const before = await tabCount();
      const again = await call('read', { url: `${urls.allowed}/one#top` });
      assert(!again.error && again.text.startsWith(`tab ${tab}`), `read of a tab already at the address: ${again.text}`);
      assert((await tabCount()) === before, 'read with the address of a tab it has opened another');
      const kept = await call('run_js', { tab, expression: 'window.keptAcrossRead' });
      assert(kept.text === '1', `read with a url loaded the page again: ${kept.text}`);
      const other = await call('read', { url: `${urls.allowed}/two` });
      const otherTab = opened(other);
      assert(otherTab !== tab && other.text.includes('second'), `read with another address: ${other.text}`);
      assert((await tabInfo(tab)).url === `${urls.allowed}/one`, `read with another address moved the tab: ${(await tabInfo(tab)).url}`);
      await closeTab(otherTab);
      await closeTab(tab);
    });

    await check('read shows the address of links it cannot otherwise tell apart', async () => {
      const { tab, text: linksPage } = await openAllowedPage('/links');
      const read = { text: linksPage };
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

      const { tab: dialog, text: dialogPage } = await openAllowedPage('/dialog');
      const page = { text: dialogPage };
      await call('act', { tab: dialog, steps: [{ action: 'click', ref: refFor(page.text, 'button "Ask"') }, { action: 'press', key: 'enter' }] });
      const answered = await call('run_js', { tab: dialog, expression: 'r.textContent' });
      assert(answered.text === '"yes"', `a dialog answered with "enter": ${answered.text}`);
      await closeTab(dialog);
    });

    await check('tabs goes to an address, back, forward and reloads', async () => {
      const tab = await openAllowed('/one');
      const went = await call('tabs', { action: 'goto', tab, url: `${urls.allowed}/two` });
      assert(!went.error && went.text.includes('Two') && went.text.includes('"second"'), `goto: ${went.text}`);
      const back = await call('tabs', { action: 'back', tab });
      assert(!back.error && back.text.includes('One') && back.text.includes('"first"'), `back: ${back.text}`);
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
      const { tab, text: formPage } = await openAllowedPage('/form-post');
      const form = { text: formPage };
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

    await check('a field change that starts a page load is waited for before the next step uses the old page', async () => {
      const { tab, text: readText } = await openAllowedPage('/jump-select');
      const read = { text: readText };
      const acted = await call('act', {
        tab,
        steps: [
          { action: 'select', ref: refFor(read.text, 'combobox "Section"'), text: 'Landing' },
          { action: 'fill', ref: refFor(read.text, 'textbox "Note"'), text: 'x' },
        ],
      });
      assert(/no longer on the page/.test(acted.text), `the second step ran on the old page: ${acted.text}`);
      assert(/step 1 \(select\) replaced the page/.test(acted.text), `the error does not name the step that moved the page: ${acted.text}`);
      assert(acted.text.includes('Landing'), `the reply is not the new page: ${acted.text}`);
      await closeTab(tab);
    });

    await check('a field change that asks the server something is answered before the click after it', async () => {
      const { tab, text: readText } = await openAllowedPage('/slow-field');
      const read = { text: readText };
      const acted = await call('act', {
        tab,
        steps: [
          { action: 'fill', ref: refFor(read.text, 'textbox "Code"'), text: '123' },
          { action: 'click', ref: refFor(read.text, 'button "Send"') },
        ],
      });
      assert(!acted.error, `act: ${acted.text}`);
      const seen = await call('run_js', { tab, expression: 'seen.textContent' });
      assert(seen.text === '"checked"', `the click ran before the server's answer was in: ${seen.text}`);
      await closeTab(tab);
    });

    await check('a click waits for a check the page runs a moment after a field change', async () => {
      const { tab, text: readText } = await openAllowedPage('/debounced');
      const read = { text: readText };
      const before = hits.allowed.filter((hit) => hit === '/submitted').length;
      const acted = await call('act', {
        tab,
        steps: [
          { action: 'fill', ref: refFor(read.text, 'textbox "Code"'), text: '123' },
          { action: 'click', ref: refFor(read.text, 'button "Send"') },
        ],
      });
      assert(!acted.error, `act: ${acted.text}`);
      for (let attempt = 0; attempt < 40 && hits.allowed.filter((hit) => hit === '/submitted').length === before; attempt += 1) await sleep(50);
      assert(hits.allowed.filter((hit) => hit === '/submitted').length === before + 1, 'the click ran before the page enabled Send, so nothing was sent');
      await closeTab(tab);
    });

    await check('an act reply names the tabs its steps opened, with the page only where a read would not ask', async () => {
      const { tab, text: loaded } = await openAllowedPage('/opener');
      const before = await tabCount();
      const same = await call('act', { tab, steps: [{ action: 'click', ref: refFor(loaded, 'link "Same site report"') }] });
      assert(!same.error, `act: ${same.text}`);
      const sameId = Number(/^Opened tab (\d+): Landing — /m.exec(same.text)?.[1]);
      assert(Number.isInteger(sameId) && same.text.includes('"landed"'), `the reply does not carry the opened tab and its page: ${same.text}`);
      assert((await tabCount()) === before + 1, 'the click did not open one tab');
      assert((await tabInfo(sameId)).groupId === (await tabInfo(tab)).groupId, 'the opened tab is not in the session group');
      const again = await call('read', { tab: sameId });
      assert(again.text === `tab ${sameId}\nNo changes since the last read.`, `the opened tab's page is not the read baseline: ${again.text}`);
      const list = await call('tabs', {});
      assert(new RegExp(`^${tab} \\[current\\]`, 'm').test(list.text), `the opener stopped being the current tab: ${list.text}`);

      const hitsBefore = hits.ask.length;
      const other = await call('act', { tab, steps: [{ action: 'click', ref: refFor(loaded, 'button "Other site"') }] });
      assert(!other.error, `act: ${other.text}`);
      const otherLine = other.text.split('\n').find((line) => line.startsWith('Opened tab'));
      assert(otherLine !== undefined && /^Opened tab \d+ \[needs approval\] /.test(otherLine) && otherLine.endsWith(`] ${urls.ask}`), `an unapproved opened tab: ${other.text}`);
      assert(!other.text.includes('private page') && !other.text.includes('/private'), `the reply shows more than the origin: ${other.text}`);
      assert((await pending()).length === 0, 'naming the opened tab asked the owner');
      const otherId = Number(/^Opened tab (\d+)/.exec(otherLine ?? '')?.[1]);
      for (let attempt = 0; attempt < 40 && hits.ask.length === hitsBefore; attempt += 1) await sleep(50);
      assert(hits.ask.includes('/private'), 'the window.open page never loaded');

      // A tab that opens on this site and is redirected to another one shows only where it ended up.
      const redirected = await call('act', { tab, steps: [{ action: 'click', ref: refFor(loaded, 'link "Redirected report"') }] });
      const redirectedLine = redirected.text.split('\n').find((line) => line.startsWith('Opened tab'));
      assert(redirectedLine?.endsWith(`[needs approval] ${urls.other}`), `a tab redirected to another origin: ${redirected.text}`);
      assert(!redirected.text.includes('landed'), `the redirected tab's page is in the reply: ${redirected.text}`);
      // A tab left on the blank page it was created with is said to be loading, not refused.
      const blank = await call('act', { tab, steps: [{ action: 'click', ref: refFor(loaded, 'button "Blank"') }] });
      assert(/^Opened tab \d+ \[needs approval\] about:blank\nIt is still loading\.$/m.test(blank.text), `a blank tab: ${blank.text}`);
      assert((await pending()).length === 0, 'naming the opened tabs asked the owner');
      const ids = [redirected.text, blank.text].map((reply) => Number(/^Opened tab (\d+)/m.exec(reply)?.[1]));
      for (const id of [otherId, sameId, ...ids]) if (Number.isInteger(id)) await closeTab(id);
      await closeTab(tab);
    });

    await check('an act with find replies with the matching lines only', async () => {
      const { tab, text: loaded } = await openAllowedPage('/red');
      const found = await call('act', { tab, steps: [{ action: 'click', ref: refFor(loaded, 'button "Press"') }], find: 'pressed' });
      assert(!found.error && found.text.includes('pressed'), `act find: ${found.text}`);
      assert(!found.text.includes('Changed since the last read'), `act find sent the diff too: ${found.text}`);
      // The search set no baseline: the next read still shows the change.
      const read = await call('read', { tab });
      assert(read.text.includes('pressed'), `the read after an act find: ${read.text}`);
      await closeTab(tab);
    });

    await check('a long page is read as an outline that keeps its form, and an order sent back with an error shows it', async () => {
      const { tab } = await openAllowedPage('/catalogue');
      const read = await call('read', { tab });
      assert(/\n\(Outline of a long page: \d+ links and \d+ text lines left out, \d+ characters\. find searches them, read a ref for one part, full for the whole view\)$/.test(read.text), `the read of a long page: ${read.text}`);
      assert(read.text.includes('link "Item 40"') && !read.text.includes('Item 41'), `the outline's links: ${read.text}`);
      const email = refFor(read.text, 'textbox "Email"');
      const order = refFor(read.text, 'button "Place order"');
      assert(email !== undefined && order !== undefined, `the outline left out the form: ${read.text}`);
      const sent = await call('act', { tab, steps: [{ action: 'fill', ref: email, text: 'ada.example.com' }, { action: 'click', ref: order }] });
      assert(!sent.error && sent.text.includes('(Outline of a long page') && /textbox "Email"[^\n]*\[invalid\]\n\s*"Enter an email address with an @ in it\."/.test(sent.text), `the act reply to the order: ${sent.text}`);
      const full = await call('read', { tab, full: true });
      assert(full.text.includes('link "Item 200"') && !full.text.includes('Outline of a long page'), `a full read of the long page: ${full.text.slice(-400)}`);
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
      const { tab, text: redPage } = await openAllowedPage('/red');
      const globals = async () => JSON.parse((await call('run_js', { tab, expression: 'Object.getOwnPropertyNames(globalThis).filter((name) => !/^(on|webkit|[A-Z])/.test(name))' })).text);
      const before = new Set(await globals());
      await call('act', { tab, steps: [{ action: 'click', ref: refFor(redPage, 'button "Press"') }] });
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
