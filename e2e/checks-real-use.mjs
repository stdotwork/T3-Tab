// What a real-use test of the tools found. It runs in a browser only the extension debugs: under Playwright a
// dialog is answered for you and a background tab acts focused, so the bugs below do not show.
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

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
  rootDir,
  sleep,
  stopDaemon,
  text,
  waitForBrowser,
} from './harness.mjs';

const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const LOGIN = '<form action="/secure" method="get"><label>Username <input name="username" type="text"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>';

const pages = (otherSite) => ({
  '/plain': page('Plain', '<button onclick="r.textContent=\'You clicked: Ok\'">Go</button><p id="r">before</p>'),
  '/login': page('Login', LOGIN),
  // The same form sent into a new tab, with a field marked as the account's password.
  '/login-new-tab': page(
    'Login in a new tab',
    '<form action="/secure" method="get" target="_blank"><label>Username <input name="username" type="text"></label><label>Password <input name="password" type="text" autocomplete="current-password"></label><button type="submit">Log in</button></form>',
  ),
  // A form sent by name into a tab a link opened earlier, so no new tab is reported when the form is sent.
  '/login-named': page(
    'Login into a named tab',
    '<a href="/secure" target="results">Open results</a><form action="/secure" method="get" target="results"><label>Username <input name="username" type="text"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>',
  ),
  // A form a select's change sends into a new tab, with no click or key press.
  '/select-new-tab': page(
    'Plan in a new tab',
    '<form action="/secure" method="get" target="_blank"><label>PIN <input name="pin" type="password"></label><label>Plan <select name="plan" onchange="this.form.submit()"><option>Free</option><option>Pro</option></select></label></form>',
  ),
  '/secure': page('Secure', '<p>Signed in</p>'),
  // Every way a field hides what it holds: a password input under another ARIA role, and text fields a style masks.
  '/secrets': page(
    'Secrets',
    `<style>.disc{-webkit-text-security:disc}.sq{-webkit-text-security:square}</style>
     <label>PW combo <input type="password" role="combobox"></label>
     <label>PW search <input type="password" role="searchbox"></label>
     <label>PW button <input type="password" role="button" id="pwbutton"></label>
     <label>PW plain <input type="password" id="pwplain"></label>
     <label>PIN disc <input type="text" class="disc" id="pindisc"></label>
     <label>PIN square <input type="text" class="sq"></label>
     <label for="inherited">PIN inherited</label><div class="disc"><input type="text" id="inherited"></div>
     <label>PIN area <textarea class="disc"></textarea></label>
     <label>Plain text <input type="text" value="visible-ok"></label>
     <button type="button">Pay <input type="text" class="disc" aria-label="Pay PIN"></button>
     <a href="#top">Link <input type="text" class="disc" aria-label="Link PIN"></a>
     <h2>Head <input type="text" class="disc" aria-label="Head PIN"></h2>
     <label for="target">Label <input type="password" aria-label="Label PW"></label><input type="text" id="target">
     <span id="cardlbl">Card</span>
     <button type="button" aria-labelledby="cardlbl pindisc">Named by pin</button>
     <button type="button" aria-labelledby="pwplain">Named by password</button>
     <iframe title="pin frame" srcdoc="<!doctype html><style>.disc{-webkit-text-security:disc}</style><label>Frame PIN <input type='text' class='disc'></label>"></iframe>`,
  ),
  // Names built from a masked field through shadow roots, scripts, a crowd of referrers, a long value and over-redaction bait.
  '/secrets-more': page(
    'More secrets',
    `<style>.disc{-webkit-text-security:disc}</style>
     <label>Main PIN <input type="text" class="disc" id="mainpin"></label>
     <button type="button" id="viaattr">Via attribute</button>
     <button type="button" id="viaprop">Via property</button>
     <div id="openhost"></div><div id="closedhost"></div>
     <button type="button" id="openbtn" aria-labelledby="openhost">Open host label</button>
     <button type="button" id="closedbtn" aria-labelledby="closedhost">Closed host label</button>
     <button type="button" id="contentbtn">Inside </button>
     <div id="crowd"></div>
     <button type="button">Wide <input type="text" class="disc" aria-label="Long PIN"></button>
     <input type="text" autocomplete="current-password" aria-label="Shown current">
     <input type="text" autocomplete="new-password" aria-label="Shown new">
     <input type="text" autocomplete="one-time-code" aria-label="Shown code">
     <input type="text" autocomplete="cc-number" aria-label="Shown card">
     <input type="text" autocomplete="section-a shipping cc-csc" aria-label="Shown csc">
     <input type="text" autocomplete="username" aria-label="Shown username">
     <button type="button">Pay <input type="text" class="disc" aria-label="Code"></button>
     <a href="#x">Free energy</a><h3>Level of care and an elephant</h3><button type="button">Reduce</button>
     <script>
       const secretRoot = (host, mode, label) => { const root = host.attachShadow({ mode }); root.innerHTML = '<input type="text" class="disc" aria-label="' + label + '"><style>.disc{-webkit-text-security:disc}</style>'; return root; };
       secretRoot(openhost, 'open', 'Open shadow PIN');
       secretRoot(closedhost, 'closed', 'Closed shadow PIN');
       const inside = document.createElement('span'); contentbtn.append(inside); secretRoot(inside, 'open', 'Content shadow PIN');
       viaattr.setAttribute('aria-labelledby', 'mainpin');
       viaprop.ariaLabelledByElements = [mainpin];
       for (let i = 0; i < 205; i += 1) { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-labelledby', 'mainpin'); b.textContent = 'Referrer ' + i; crowd.append(b); }
     </script>`,
  ),
  // Secrets the tree does not show as fields: hidden in several ways, under other roles, passed on through names, echoed in text.
  '/secrets-hidden': page(
    'Hidden secrets',
    `<style>.disc{-webkit-text-security:disc}</style>
     <div hidden id="l1">Password <input type="password" value="Tr0ub4dor&amp;3"></div><button type="button" aria-labelledby="l1">Sign in 1</button>
     <div aria-hidden="true" id="l2">Password <input type="password" value="ARIAHIDDEN-SECRET-31"></div><button type="button" aria-labelledby="l2">Sign in 2</button>
     <div style="display:none" id="l3">Card <input type="text" class="disc" value="DISPLAYNONE-SECRET-32"></div><button type="button" aria-labelledby="l3">Sign in 3</button>
     <div style="visibility:hidden" id="l4">Card <input type="text" autocomplete="cc-number" value="VISIBILITY-SECRET-33"></div><button type="button" aria-labelledby="l4">Sign in 4</button>
     <dialog id="l5">Password <input type="password" value="DIALOG-SECRET-34"></dialog><button type="button" aria-labelledby="l5">Sign in 5</button>
     <input type="text" role="link" autocomplete="cc-number" value="LINKROLE-SECRET-41" aria-label="Role link">
     <input type="text" role="checkbox" class="disc" value="CHECKROLE-SECRET-42" aria-label="Role check">
     <input type="text" role="switch" autocomplete="cc-csc" value="SWITCHROLE-SECRET-43" aria-label="Role switch">
     <label>Taint password <input type="password" id="pwtaint"></label>
     <label for="t2">PIN <span aria-labelledby="pwtaint">y</span></label><input type="text" id="t2">
     <button type="button">Pay <span aria-labelledby="pwtaint">z</span></button>
     <label>Net PIN <input type="text" class="disc" id="netpin" oninput="echo.textContent = 'You typed ' + this.value"></label><p id="echo">Nothing typed</p>`,
  ),
  // Echoes a page can print: split over elements, upper-cased, from a hidden field no name was built from.
  '/secrets-text': page(
    'Echoed secrets',
    `<style>.disc{-webkit-text-security:disc}</style>
     <label>Echo PIN <input type="text" class="disc" id="echopin"></label>
     <div id="split"></div><p id="bold"></p><p id="upper" style="text-transform:uppercase"></p>
     <div hidden><input type="password" id="hid" value="HIDDENECHO-SECRET-51"></div><p id="hecho"></p>
     <script>
       hecho.textContent = 'Hidden echo: ' + hid.value;
       echopin.addEventListener('input', () => {
         const v = echopin.value;
         split.replaceChildren(...[...('Split: ' + v)].map((c) => { const s = document.createElement('span'); s.textContent = c; return s; }));
         bold.innerHTML = '<b>' + v.slice(0, 3) + '</b>' + v.slice(3) + ' (bold)';
         upper.textContent = 'Echo2: ' + v;
       });
     </script>`,
  ),
  // A form with thousands of masked fields and a crowd of buttons named from it: what a hostile page can make a read cost.
  '/hostile': page(
    'Hostile',
    `<style>.disc{-webkit-text-security:disc}</style>
     <form id="big"></form><div id="btns"></div>
     <script>
       for (let i = 0; i < 3000; i += 1) { const f = document.createElement('input'); f.type = 'text'; f.className = 'disc'; f.value = 'HOSTILE-PIN-' + i; big.append(f); }
       for (let i = 0; i < 200; i += 1) { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-labelledby', 'big'); b.textContent = 'Pay ' + i; btns.append(b); }
     </script>`,
  ),
  '/keys': page('Keys', '<p id="k">0</p><script>addEventListener("keydown",(e)=>{if(e.key==="/")k.textContent=+k.textContent+1})</script>'),
  '/dialogs': page(
    'Dialogs',
    `<button onclick="alert('hello');r.textContent='alert done'">Alert</button>
     <button onclick="r.textContent=confirm('sure?')?'confirmed':'cancelled'">Confirm</button>
     <button onclick="r.textContent='got:'+prompt('name?','default')">Prompt</button><p id="r">none</p>`,
  ),
  '/alert-on-load': page('Alert on load', "<p id=\"r\">loaded</p><script>alert('on load')</script>"),
  '/foreign-dialog': page('Foreign dialog', `<iframe title="other" src="${otherSite}/frame-alert"></iframe>`),
  '/frame-alert': page('Frame alert', "<script>setTimeout(() => alert('FOREIGN-SECRET'), 50)</script>"),
  '/scroll': page('Scroll', '<div style="height:5000px">tall</div><p>end</p><script>addEventListener("wheel",()=>{window.wheels=(window.wheels||0)+1})</script>'),
  '/count': page('Count', '<button onclick="n.textContent=+n.textContent+1">Add</button><p id="n">0</p>'),
  '/hover': page('Hover', `<img alt="User one" width="100" height="100" src="${GIF}" onmouseover="t.textContent='hovered'"><img width="100" height="100" src="${GIF}"><p id="t">idle</p>`),
  '/frames': page(
    'Frames',
    `<iframe id="sd" title="srcdoc" srcdoc="<!doctype html><body><p>inner srcdoc text</p><button onclick='this.textContent=&quot;pressed&quot;'>In frame</button></body>"></iframe>
     <iframe title="login" src="/login"></iframe>
     <iframe id="blank" title="editor"></iframe>
     <iframe title="sandboxed" sandbox srcdoc="<p>SANDBOX-SECRET</p>"></iframe>
     <iframe title="other" src="${otherSite}/secret"></iframe>
     <script>const d = blank.contentDocument; d.open(); d.write('<!doctype html><body contenteditable><p>editor text</p></body>'); d.close();</script>`,
  ),
  '/secret': page('Secret', '<p>OTHER-ORIGIN-SECRET</p>'),
});

export async function checkRealUse() {
  const home = await createHome();
  let site;
  let other;
  let browser;
  let mcp;
  const failures = [];
  try {
    await requireBuild(home);
    let content = {};
    const handler = (request, response) => {
      const body = content[new URL(request.url ?? '/', 'http://x').pathname];
      response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body ?? 'not found');
    };
    site = createServer(handler);
    other = createServer(handler);
    await Promise.all([listen(site), listen(other)]);
    const siteUrl = `http://127.0.0.1:${site.address().port}`;
    const otherUrl = `http://127.0.0.1:${other.address().port}`;
    content = pages(otherUrl);
    await installNativeHost(home);
    browser = await launchUndrivenBrowser(home, `${siteUrl}/plain`, [join(rootDir, 'e2e/fixtures/frame-injector')]);
    mcp = await connectMcp(home, 'real-use');
    await waitForBrowser(home);
    await browser.panel({ type: 'panel.setSite', origin: siteUrl, setting: 'allow' });

    const call = async (name, args) => {
      const started = Date.now();
      try {
        const result = await mcp.client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
        return { error: result.isError === true, text: text(result), ms: Date.now() - started };
      } catch (error) {
        return { error: true, text: `no reply: ${error.message}`, ms: Date.now() - started };
      }
    };
    let lastOpened = '';
    const open = async (path) => {
      const opened = await call('tabs', { action: 'open', url: `${siteUrl}${path}` });
      const tab = Number(/^Opened tab (\d+)/.exec(opened.text)?.[1]);
      assert(Number.isInteger(tab), `tabs open ${path}: ${opened.text}`);
      lastOpened = opened.text;
      loadReplies.set(tab, opened.text);
      return tab;
    };
    const act = (tab, ...steps) => call('act', { tab, steps });
    const js = async (tab, expression) => (await call('run_js', { tab, expression })).text;
    const loadReplies = new Map();
    // A full read right after a load that showed the page says only that nothing changed: the page is the load's reply.
    const read = async (tab, extra = {}) => {
      const reply = await call('read', { tab, full: true, ...extra });
      return /^tab \d+\nNo changes since the load's reply/.test(reply.text) ? { ...reply, text: loadReplies.get(tab) ?? reply.text } : reply;
    };
    const check = async (name, run) => {
      try {
        await run();
        console.log(`Real use: ${name}`);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    };

    await check('a frame from another extension does not break the tab', async () => {
      const tab = await open('/login');
      const first = await read(tab);
      const filled = await act(
        tab,
        { action: 'fill', ref: refFor(first.text, 'textbox "Username"'), text: 'ada' },
        { action: 'fill', ref: refFor(first.text, 'textbox "Password"'), text: 'pw' },
      );
      assert(!filled.error, `fill: ${filled.text}`);
      assert((await read(tab)).text.includes('value="ada"'), 'read after the frame appeared');
      assert((await call('screenshot', { tab })).error === false, 'screenshot after the frame appeared');
      const clicked = await act(tab, { action: 'click', ref: refFor(first.text, 'button "Log in"') });
      assert(!clicked.error, `click with a ref from before the frame: ${clicked.text}`);
      assert((await js(tab, 'location.pathname')) === '"/secure"', 'the form was not submitted');
    });

    await check('a key press that brings in a frame lands once and leaves the tab usable', async () => {
      const tab = await open('/keys');
      await read(tab);
      const pressed = await act(tab, { action: 'press', key: '/' });
      assert(!pressed.error, `press: ${pressed.text}`);
      assert((await js(tab, 'k.textContent')) === '"1"', 'the key did not land exactly once');
      assert(!(await read(tab)).error, 'read after the frame appeared');
    });

    await check('an alert is reported at once and answered with Enter', async () => {
      const tab = await open('/dialogs');
      const first = await read(tab);
      const clicked = await act(tab, { action: 'click', ref: refFor(first.text, 'button "Alert"') });
      assert(!clicked.error && clicked.ms < 5_000 && clicked.text.includes('alert: "hello"'), `click: ${clicked.ms}ms ${clicked.text}`);
      const blocked = await read(tab);
      assert(blocked.error && blocked.ms < 2_000 && blocked.text.includes('press Enter'), `read: ${blocked.ms}ms ${blocked.text}`);
      const answered = await act(tab, { action: 'press', key: 'Enter' });
      assert(!answered.error, `Enter: ${answered.text}`);
      assert((await js(tab, 'r.textContent')) === '"alert done"', 'the page did not continue');
    });

    await check('a confirm is cancelled with Escape, in the same batch as its click', async () => {
      const tab = await open('/dialogs');
      const first = await read(tab);
      const done = await act(tab, { action: 'click', ref: refFor(first.text, 'button "Confirm"') }, { action: 'press', key: 'Escape' });
      assert(!done.error, done.text);
      assert((await js(tab, 'r.textContent')) === '"cancelled"', 'confirm was not cancelled');
    });

    await check('a prompt takes typed text', async () => {
      const tab = await open('/dialogs');
      const first = await read(tab);
      const done = await act(
        tab,
        { action: 'click', ref: refFor(first.text, 'button "Prompt"') },
        { action: 'type', text: 'Ada' },
        { action: 'press', key: 'Enter' },
      );
      assert(!done.error, done.text);
      assert((await js(tab, 'r.textContent')) === '"got:Ada"', 'prompt text did not arrive');
    });

    await check('a dialog during page load does not lock the new tab', async () => {
      const tab = await open('/alert-on-load');
      assert(lastOpened.includes('on load'), `the open reply does not name the dialog: ${lastOpened}`);
      const seen = await read(tab);
      assert(seen.error && seen.text.includes('on load'), seen.text);
      assert(!(await act(tab, { action: 'press', key: 'Enter' })).error, 'Enter');
      assert((await js(tab, 'r.textContent')) === '"loaded"', 'the page did not finish');
    });

    await check("another origin's dialog hides its text and can only be dismissed", async () => {
      const tab = await open('/foreign-dialog');
      assert(!lastOpened.includes('FOREIGN-SECRET'), `the open reply shows another origin's dialog: ${lastOpened}`);
      await sleep(300);
      const seen = await read(tab);
      assert(seen.error && seen.text.includes(otherUrl) && !seen.text.includes('FOREIGN-SECRET'), seen.text);
      const refused = await act(tab, { action: 'press', key: 'Enter' });
      assert(refused.error && !refused.text.includes('FOREIGN-SECRET'), refused.text);
      assert(!(await act(tab, { action: 'press', key: 'Escape' })).error, 'Escape');
    });

    await check('a background tab scrolls and clicks without delay, and is hidden again afterwards', async () => {
      const tab = await open('/scroll');
      const counter = await open('/count');
      await open('/plain');
      const scrolled = await act(tab, { action: 'scroll', dy: 900 });
      assert(!scrolled.error && scrolled.ms < 3_000, `scroll: ${scrolled.ms}ms ${scrolled.text}`);
      assert((await js(tab, 'scrollY')) === '900', 'the page did not scroll');
      assert((await js(tab, 'window.wheels')) === '1', 'the page saw no wheel event');
      assert((await js(tab, 'document.visibilityState')) === '"hidden"', 'the tab still acts visible');
      const first = await read(counter);
      const clicked = await act(counter, { action: 'click', ref: refFor(first.text, 'button "Add"') });
      assert(!clicked.error && clicked.ms < 2_000, `click: ${clicked.ms}ms`);
      assert((await js(counter, 'n.textContent')) === '"1"', 'one click, one count');
    });

    await check('run_js takes statements that start with an assignment', async () => {
      const tab = await open('/plain');
      for (const [source, expected] of [
        ['window.x = 1; window.y = 2; return x + y', '3'],
        ['z = 5\nreturn z', '5'],
        ['const a = 1; return a + 1', '2'],
        ['1 + 1', '2'],
        ['document.title;', '"Plain"'],
        ['await Promise.resolve(4)', '4'],
      ]) {
        const got = await js(tab, source);
        assert(got === expected, `${source} gave ${got}`);
      }
    });

    await check('run_js names a returned element', async () => {
      const tab = await open('/plain');
      assert((await js(tab, 'document.body')) === '"body"', 'element');
      assert((await js(tab, 'document.querySelectorAll("p#r")')) === '["p#r"]', 'node list');
    });

    await check('a change in plain text is reported', async () => {
      const tab = await open('/plain');
      const first = await read(tab);
      const clicked = await act(tab, { action: 'click', ref: refFor(first.text, 'button "Go"') });
      assert(clicked.text.includes('You clicked: Ok'), clicked.text);
    });

    await check('images have refs in an all read and can be hovered', async () => {
      const tab = await open('/hover');
      const all = await read(tab, { all: true });
      const ref = refFor(all.text, 'img "User one"');
      assert(ref !== undefined, all.text);
      assert(!(await act(tab, { action: 'hover', ref })).error, 'hover');
      assert((await js(tab, 't.textContent')) === '"hovered"', 'hover did not land');
    });

    await check('same-origin frames are read and usable, other frames stay out', async () => {
      const tab = await open('/frames');
      const all = await read(tab, { all: true });
      assert(all.text.includes('inner srcdoc text') && all.text.includes('editor text'), all.text);
      assert(all.text.includes('value=<redacted>') || all.text.includes('textbox "Password"'), 'password field in a frame');
      assert(!all.text.includes('SANDBOX-SECRET') && !all.text.includes('OTHER-ORIGIN-SECRET'), all.text);
      assert(all.text.includes(`frame omitted: ${otherUrl}`) && all.text.includes('frame omitted: unknown origin'), all.text);
      const clicked = await act(tab, { action: 'click', ref: refFor(all.text, 'button "In frame"') });
      assert(!clicked.error, clicked.text);
      assert((await js(tab, 'sd.contentDocument.querySelector("button").textContent')) === '"pressed"', 'click in a frame');
    });

    await check('a password typed in a same-origin frame stays redacted', async () => {
      const tab = await open('/frames');
      const first = await read(tab);
      const filled = await act(tab, { action: 'fill', ref: refFor(first.text, 'textbox "Password"'), text: 'FRAME-PASSWORD' });
      assert(!filled.error, filled.text);
      assert(!(await read(tab, { all: true })).text.includes('FRAME-PASSWORD'), 'the password was printed');
    });

    await check('every password field and masked text field stays redacted in read, find, diffs and act replies', async () => {
      const tab = await open('/secrets');
      const first = await read(tab, { all: true });
      const secrets = {
        'combobox "PW combo"': 'COMBO-SECRET-1',
        'searchbox "PW search"': 'SEARCH-SECRET-2',
        'textbox "PW plain"': 'PLAIN-SECRET-3',
        'textbox "PIN disc"': 'DISC-PIN-4',
        'textbox "PIN square"': 'SQUARE-PIN-5',
        'textbox "PIN inherited"': 'INHERIT-PIN-6',
        'textbox "PIN area"': 'AREA-PIN-7',
        'textbox "Frame PIN"': 'FRAME-PIN-8',
        'textbox "Pay PIN"': 'PAY-PIN-11',
        'textbox "Link PIN"': 'LINK-PIN-12',
        'textbox "Head PIN"': 'HEAD-PIN-13',
        'textbox "Label PW"': 'LABEL-SECRET-14',
      };
      for (const label of Object.keys(secrets)) {
        const line = first.text.split('\n').find((candidate) => candidate.includes(label));
        assert(line !== undefined && line.trim().endsWith('value=<redacted>'), `${label} is not marked redacted when empty:\n${first.text}`);
      }
      assert(first.text.includes('textbox "Plain text" value="visible-ok"'), `an ordinary text field lost its value:\n${first.text}`);
      const filled = await act(
        tab,
        ...Object.entries(secrets).map(([label, secret]) => ({ action: 'fill', ref: refFor(first.text, label), text: secret })),
      );
      assert(!filled.error, `fill: ${filled.text}`);
      // The role-button password input cannot be filled by ref; set it from the page, as a script or autofill would.
      await js(tab, 'pwbutton.value = "BUTTON-SECRET-9"');
      assert(!/SECRET|PIN-\d|•/.test(filled.text), `the fill reply shows a value or its length:\n${filled.text}`);
      const views = {
        'all read': await read(tab, { all: true }),
        'full read': await read(tab),
        'find by name': await call('read', { tab, find: 'PW' }),
        'find by pin': await call('read', { tab, find: 'PIN' }),
        'find by value': await call('read', { tab, find: 'SECRET', regex: false }),
        'find by bullets': await call('read', { tab, find: '•' }),
        'find by regex': await call('read', { tab, find: '(SECRET|PIN)-\\d', regex: true }),
        'diff read': await call('read', { tab }),
      };
      for (const [name, view] of Object.entries(views)) {
        assert(!view.error, `${name}: ${view.text}`);
        // A find that matches nothing repeats the query, which is not the page's text.
        const shown = view.text.replace(/No matches for ".*"\./, '');
        assert(!/SECRET|PIN-\d|•|■/.test(shown), `${name} shows a value or its length:\n${view.text}`);
      }
      // Names the browser builds from a hidden value say so instead of showing it, or its length.
      for (const expected of [
        'button "Pay <redacted>"',
        'link "Link <redacted>"',
        '## Head <redacted>',
        'textbox "Label <redacted>"',
        'button "Card <redacted>"',
        'button "<redacted>"',
      ]) {
        assert(views['all read'].text.includes(expected), `${expected} is missing from the read:\n${views['all read'].text}`);
      }
      for (const label of [...Object.keys(secrets), 'button "PW button"']) {
        assert(views['all read'].text.includes(label), `${label} is missing from the read:\n${views['all read'].text}`);
      }
      assert(views['all read'].text.includes('textbox "Plain text" value="visible-ok"'), 'the plain field lost its value after the others were filled');
      // A change to an already redacted field answers with the field, never its new value.
      const again = await act(tab, { action: 'fill', ref: refFor(first.text, 'combobox "PW combo"'), text: 'NEW-SECRET-10' });
      assert(!again.error && !/SECRET|•/.test(again.text), `refilling a redacted field: ${again.text}`);
      assert(!/SECRET|PIN-\d|•/.test((await call('read', { tab, all: true, full: true })).text), 'a later read shows a value');
    });

    await check('shadow roots, script labels, 205 referrers, a 260-character value, show-password toggles and over-redaction', async () => {
      const tab = await open('/secrets-more');
      const first = await read(tab, { all: true });
      const long = `LONG${'abcdefghij'.repeat(26)}`;
      const secrets = {
        'textbox "Main PIN"': 'MAIN-PIN-21',
        'textbox "Open shadow PIN"': 'OPEN-SHADOW-PIN-22',
        'textbox "Closed shadow PIN"': 'CLOSED-SHADOW-PIN-23',
        'textbox "Content shadow PIN"': 'CONTENT-SHADOW-PIN-24',
        'textbox "Long PIN"': long,
        'textbox "Shown current"': 'CURRENT-SECRET-25',
        'textbox "Shown new"': 'NEW-SECRET-26',
        'textbox "Shown code"': 'CODE-SECRET-27',
        'textbox "Shown card"': 'CARD-SECRET-28',
        'textbox "Shown csc"': 'CSC-SECRET-29',
        'textbox "Code"': 'e',
      };
      for (const label of Object.keys(secrets)) {
        const line = first.text.split('\n').find((candidate) => candidate.includes(label));
        assert(line !== undefined && line.trim().endsWith('value=<redacted>'), `${label} is not marked redacted when empty:\n${first.text}`);
      }
      assert(first.text.includes('textbox "Shown username"') && !/Shown username.*redacted/.test(first.text), `a username field was redacted:\n${first.text}`);
      const filled = await act(
        tab,
        ...Object.entries(secrets).map(([label, secret]) => ({ action: 'fill', ref: refFor(first.text, label), text: secret })),
        { action: 'fill', ref: refFor(first.text, 'textbox "Shown username"'), text: 'ada-visible' },
      );
      assert(!filled.error, `fill: ${filled.text}`);
      const leak = /SECRET|PIN-\d|abcdefghij|•|■/;
      assert(!leak.test(filled.text), `the fill reply shows a value or its length:\n${filled.text}`);
      const all = await read(tab, { all: true, full: true });
      const views = {
        'all read': all,
        'full read': await read(tab),
        'find by pin': await call('read', { tab, find: 'PIN' }),
        'find by tail': await call('read', { tab, find: 'abcdefghij' }),
        'find by regex': await call('read', { tab, find: '(SECRET|PIN)-\\d', regex: true }),
        'find by referrer': await call('read', { tab, find: 'Referrer' }),
        'diff read': await call('read', { tab }),
      };
      for (const [name, view] of Object.entries(views)) {
        assert(!view.error, `${name}: ${view.text}`);
        assert(!leak.test(view.text.replace(/No matches for ".*"\./, '')), `${name} shows a value or its length:\n${view.text}`);
      }
      const text = all.text;
      for (const expected of [
        'textbox "Shown username" value="ada-visible"',
        'button "<redacted>"',
        'textbox "Code" value=<redacted>',
        'button "Pay <redacted>"',
        'link "Free energy"',
        '## Level of care and an elephant',
        'button "Reduce"',
        'button "Wide <redacted>"',
        'button "Inside <redacted>"',
      ]) {
        assert(text.includes(expected), `${expected} is missing from the read:\n${text}`);
      }
      const redactedButtons = text.split('\n').filter((line) => /button "<redacted>"/.test(line)).length;
      assert(redactedButtons >= 208, `only ${redactedButtons} of the 209 buttons named from the PIN are redacted:\n${text.slice(0, 3000)}`);
    });

    await check('hidden fields, other roles, names that pass a secret on, and text that echoes one', async () => {
      const tab = await open('/secrets-hidden');
      const first = await read(tab, { all: true });
      const filled = await act(
        tab,
        { action: 'fill', ref: refFor(first.text, 'textbox "Taint password"'), text: 'TAINT-SECRET-35' },
        { action: 'fill', ref: refFor(first.text, 'textbox "Net PIN"'), text: 'NET-SECRET-37' },
      );
      assert(!filled.error, `fill: ${filled.text}`);
      const leak = /SECRET|Tr0ub4dor|•|■/;
      assert(!leak.test(filled.text), `the fill reply shows a value or its length:\n${filled.text}`);
      const all = await read(tab, { all: true, full: true });
      const views = {
        'all read': all,
        'full read': await read(tab),
        'find by value': await call('read', { tab, find: 'SECRET' }),
        'find by password': await call('read', { tab, find: 'Tr0ub4dor' }),
        'find by echo': await call('read', { tab, find: 'You typed' }),
        'diff read': await call('read', { tab }),
      };
      for (const [name, view] of Object.entries(views)) {
        assert(!view.error, `${name}: ${view.text}`);
        assert(!leak.test(view.text.replace(/No matches for ".*"\./, '')), `${name} shows a value or its length:\n${view.text}`);
      }
      const text = all.text;
      for (const expected of [
        'Password <redacted>',
        'Card <redacted>',
        'textbox "PIN <redacted>"',
        'button "Pay <redacted>"',
        'You typed <redacted>',
      ]) {
        assert(text.includes(expected), `${expected} is missing from the read:\n${text}`);
      }
      assert((text.match(/^e[1-5] button ".*<redacted>"$/gm) ?? []).length === 5, `five buttons named from hidden fields should be redacted:\n${text}`);
    });

    await check('text the page split over elements, upper-cased or took from a hidden field stays redacted', async () => {
      const tab = await open('/secrets-text');
      const first = await read(tab, { all: true });
      assert(first.text.includes('Hidden echo: <redacted>') && !/HIDDENECHO-SECRET-51/i.test(first.text), `hidden field echo:\n${first.text}`);
      const filled = await act(tab, { action: 'fill', ref: refFor(first.text, 'textbox "Echo PIN"'), text: 'splitpin-secret-52' });
      assert(!filled.error, `fill: ${filled.text}`);
      assert(!/SPLITPIN|-SECRET-|HIDDENECHO/i.test(filled.text), `the fill reply shows a value:\n${filled.text}`);
      const views = {
        'all read': await read(tab, { all: true, full: true }),
        'full read': await read(tab),
        'find by value': await call('read', { tab, find: 'secret' }),
        'find by echo': await call('read', { tab, find: 'echo' }),
      };
      for (const [name, view] of Object.entries(views)) {
        assert(!view.error, `${name}: ${view.text}`);
        const shown = view.text.replace(/No matches for ".*"\./, '');
        assert(!/SPLITPIN|-SECRET-|HIDDENECHO/i.test(shown), `${name} shows the value:\n${view.text}`);
        // Not its letters in a row either, across the lines of the page.
        const letters = shown.split('\n').map((line) => line.replace(/^\s*e\d+\s+\S+\s+/, '').replace(/[^a-z0-9-]/gi, '')).join('');
        assert(!/splitpin-secret-52/i.test(letters), `${name} shows the value across lines:\n${view.text}`);
      }
      assert(views['all read'].text.includes('ECHO2: <redacted>'), `the upper-cased echo is not marked:\n${views['all read'].text}`);
    });

    await check('a password the page sends in its address stays out of the title and address a reply shows', async () => {
      const tab = await open('/login');
      const first = await read(tab);
      // As autofill or the owner would put it there: from the page, not through the tools.
      await js(tab, 'document.querySelector("input[name=username]").value = "ada"; document.querySelector("input[type=password]").value = "GETLOGIN-SECRET-61"');
      const clicked = await act(tab, { action: 'click', ref: refFor(first.text, 'button "Log in"') });
      assert(!clicked.error, `click: ${clicked.text}`);
      assert((await js(tab, 'location.search')).includes('GETLOGIN-SECRET-61'), 'the form did not send the value in the address');
      assert(!/GETLOGIN-SECRET-61/i.test(clicked.text) && clicked.text.includes('password=<redacted>'), `the act reply shows the address:\n${clicked.text}`);
      const listed = await call('tabs', { action: 'list' });
      assert(!listed.error && !/GETLOGIN-SECRET-61/i.test(listed.text) && listed.text.includes('password=<redacted>'), `tabs list:\n${listed.text}`);
      const again = await read(tab, { all: true });
      assert(!/GETLOGIN-SECRET-61/i.test(again.text), `a later read shows the address:\n${again.text}`);
    });

    await check('a password a form sends into a new tab stays out of that tab\'s title and address in the act reply and tabs list', async () => {
      const tab = await open('/login-new-tab');
      const first = await read(tab);
      const clicked = await act(
        tab,
        { action: 'fill', ref: refFor(first.text, 'textbox "Username"'), text: 'ada' },
        { action: 'fill', ref: refFor(first.text, 'textbox "Password"'), text: 'NEWTAB!(SECRET)-73' },
        { action: 'click', ref: refFor(first.text, 'button "Log in"') },
      );
      assert(!clicked.error, `click: ${clicked.text}`);
      const opened = Number(/^Opened tab (\d+)/m.exec(clicked.text)?.[1]);
      assert(Number.isInteger(opened), `the reply does not name the new tab:\n${clicked.text}`);
      // A form encodes ! ( ) as %21 %28 %29, which encodeURIComponent leaves as they are.
      assert((await js(opened, 'location.search')).includes('NEWTAB%21%28SECRET%29-73'), 'the form did not send the value in the new tab\'s address');
      assert(!/NEWTAB/i.test(clicked.text) && clicked.text.includes('password=<redacted>'), `the act reply shows the address:\n${clicked.text}`);
      const listed = await call('tabs', { action: 'list' });
      assert(!listed.error && !/NEWTAB/i.test(listed.text) && listed.text.includes('password=<redacted>'), `tabs list:\n${listed.text}`);
      await call('tabs', { action: 'close', tab: opened });
    });

    await check('a password a form sends by name into a tab opened earlier stays out of that tab\'s address in tabs list and a read', async () => {
      const tab = await open('/login-named');
      const first = await read(tab);
      const linked = await act(tab, { action: 'click', ref: refFor(first.text, 'link "Open results"') });
      const results = Number(/^Opened tab (\d+)/m.exec(linked.text)?.[1]);
      assert(!linked.error && Number.isInteger(results), `the link did not open a tab:\n${linked.text}`);
      const sent = await act(
        tab,
        { action: 'fill', ref: refFor(first.text, 'textbox "Password"'), text: 'NAMED-SECRET-91' },
        { action: 'click', ref: refFor(first.text, 'button "Log in"') },
      );
      assert(!sent.error && !/^Opened tab/m.test(sent.text), `the form opened a tab instead of using "results":\n${sent.text}`);
      let reached = false;
      for (let tries = 0; tries < 50 && !reached; tries += 1) {
        reached = (await js(results, 'location.search')).includes('NAMED-SECRET-91');
        if (!reached) await sleep(100);
      }
      assert(reached, 'the form did not reach the named tab');
      const listed = await call('tabs', { action: 'list' });
      assert(!listed.error && !/NAMED-SECRET-91/i.test(listed.text) && listed.text.includes('password=<redacted>'), `tabs list:\n${listed.text}`);
      const shown = await read(results);
      assert(!shown.error && !/NAMED-SECRET-91/i.test(shown.text), `the read shows the address:\n${shown.text}`);
      await call('tabs', { action: 'close', tab: results });
    });

    await check('a password a select\'s change sends into a new tab stays out of the act reply and tabs list', async () => {
      const tab = await open('/select-new-tab');
      const first = await read(tab);
      const chosen = await act(
        tab,
        { action: 'fill', ref: refFor(first.text, 'textbox "PIN"'), text: 'SELECT-SECRET-44' },
        { action: 'select', ref: refFor(first.text, 'combobox "Plan"'), text: 'Pro' },
      );
      assert(!chosen.error, `select: ${chosen.text}`);
      const opened = Number(/^Opened tab (\d+)/m.exec(chosen.text)?.[1]);
      assert(Number.isInteger(opened), `the reply does not name the new tab:\n${chosen.text}`);
      assert((await js(opened, 'location.search')).includes('SELECT-SECRET-44'), 'the form did not send the value in the new tab\'s address');
      assert(!/SELECT-SECRET-44/i.test(chosen.text) && chosen.text.includes('pin=<redacted>'), `the act reply shows the address:\n${chosen.text}`);
      const listed = await call('tabs', { action: 'list' });
      assert(!listed.error && !/SELECT-SECRET-44/i.test(listed.text) && listed.text.includes('pin=<redacted>'), `tabs list:\n${listed.text}`);
      await call('tabs', { action: 'close', tab: opened });
    });

    await check('a page of 3,000 masked fields and 200 buttons named from them is read in bounded time with no value in it', async () => {
      const tab = await open('/hostile');
      const view = await read(tab, { all: true });
      assert(!view.error, `read: ${view.text.slice(0, 300)}`);
      assert(view.ms < 20_000, `the read took ${view.ms} ms`);
      assert(!/HOSTILE-PIN/i.test(view.text), `a value is in the read:\n${view.text.slice(0, 2000)}`);
      // The extension still answers every session straight after.
      const listed = await call('tabs', { action: 'list' });
      assert(!listed.error && listed.ms < 5_000, `tabs list after the read: ${listed.ms} ms ${listed.text.slice(0, 200)}`);
      console.log(`Real use: the hostile read took ${view.ms} ms, ${view.text.length} characters`);
    });

    await check('a modifier key can be pressed on its own', async () => {
      const tab = await open('/plain');
      assert(!(await act(tab, { action: 'press', key: 'Shift' })).error, 'Shift');
    });

    await check('data: URLs stay refused', async () => {
      const refused = await call('tabs', { action: 'open', url: 'data:text/html,hi' });
      assert(refused.error && /data: scheme/.test(refused.text), refused.text);
    });
  } finally {
    await mcp?.client.close().catch(() => undefined);
    await browser?.close();
    await stopDaemon(home.statePath);
    await Promise.all([closeServer(site), closeServer(other)]).catch(() => undefined);
    await rm(home.tempHome, { recursive: true, force: true }).catch(() => undefined);
  }
  if (failures.length > 0) throw new Error(`Real-use checks failed:\n${failures.join('\n')}`);
  console.log('Real-use checks: all passed');
}

if (process.argv[1]?.endsWith('checks-real-use.mjs')) await checkRealUse();
