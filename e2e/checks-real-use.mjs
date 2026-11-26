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
  '/secure': page('Secure', '<p>Signed in</p>'),
  // Every way a field hides what it holds: a password input under another ARIA role, and text fields a style masks.
  '/secrets': page(
    'Secrets',
    `<style>.disc{-webkit-text-security:disc}.sq{-webkit-text-security:square}</style>
     <label>PW combo <input type="password" role="combobox"></label>
     <label>PW search <input type="password" role="searchbox"></label>
     <label>PW button <input type="password" role="button" id="pwbutton"></label>
     <label>PW plain <input type="password"></label>
     <label>PIN disc <input type="text" class="disc"></label>
     <label>PIN square <input type="text" class="sq"></label>
     <label for="inherited">PIN inherited</label><div class="disc"><input type="text" id="inherited"></div>
     <label>PIN area <textarea class="disc"></textarea></label>
     <label>Plain text <input type="text" value="visible-ok"></label>
     <iframe title="pin frame" srcdoc="<!doctype html><style>.disc{-webkit-text-security:disc}</style><label>Frame PIN <input type='text' class='disc'></label>"></iframe>`,
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
    await waitForBrowser(mcp.client);
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
    const open = async (path) => {
      const opened = await call('tabs', { action: 'open', url: `${siteUrl}${path}` });
      const tab = Number(/^Opened tab (\d+)/.exec(opened.text)?.[1]);
      assert(Number.isInteger(tab), `tabs open ${path}: ${opened.text}`);
      return tab;
    };
    const act = (tab, ...steps) => call('act', { tab, steps });
    const js = async (tab, expression) => (await call('run_js', { tab, expression })).text;
    const read = (tab, extra = {}) => call('read', { tab, full: true, ...extra });
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
      const seen = await read(tab);
      assert(seen.error && seen.text.includes('on load'), seen.text);
      assert(!(await act(tab, { action: 'press', key: 'Enter' })).error, 'Enter');
      assert((await js(tab, 'r.textContent')) === '"loaded"', 'the page did not finish');
    });

    await check("another origin's dialog hides its text and can only be dismissed", async () => {
      const tab = await open('/foreign-dialog');
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
      for (const label of [...Object.keys(secrets), 'button "PW button"']) {
        assert(views['all read'].text.includes(label), `${label} is missing from the read:\n${views['all read'].text}`);
      }
      assert(views['all read'].text.includes('textbox "Plain text" value="visible-ok"'), 'the plain field lost its value after the others were filled');
      // A change to an already redacted field answers with the field, never its new value.
      const again = await act(tab, { action: 'fill', ref: refFor(first.text, 'combobox "PW combo"'), text: 'NEW-SECRET-10' });
      assert(!again.error && !/SECRET|•/.test(again.text), `refilling a redacted field: ${again.text}`);
      assert(!/SECRET|PIN-\d|•/.test((await call('read', { tab, all: true, full: true })).text), 'a later read shows a value');
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
