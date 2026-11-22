export const SITE_NOT_FOUND = '<!doctype html><html lang="en"><head><title>Not found</title></head><body><h1>Not found</h1></body></html>';

export const SITE = {
  '/': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>T3-Tab E2E</title></head>
  <body>
    <h1>T3-Tab E2E</h1>
    <nav aria-label="Main">
      <a href="/">Home</a> <a href="/about">About</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a>
    </nav>
    <main>
      <h2>Sign up</h2>
      <form id="signup" aria-label="Sign up">
        <label>Name <input name="name" type="text" required></label>
        <label>Email <input name="email" type="email"></label>
        <label>Password <input name="password" type="password"></label>
        <label>Country
          <select name="country"><option>Australia</option><option>Brazil</option><option>Canada</option></select>
        </label>
        <fieldset>
          <legend>Plan</legend>
          <label><input type="radio" name="plan" value="free" checked> Free</label>
          <label><input type="radio" name="plan" value="pro"> Pro</label>
        </fieldset>
        <label><input type="checkbox" name="terms"> I agree to the terms</label>
        <label>Notes <textarea name="notes"></textarea></label>
        <button type="submit">Create account</button>
        <button type="reset">Reset</button>
      </form>
      <h2>Details</h2>
      <button id="toggle" aria-expanded="false">Show details</button>
      <section id="details" hidden>
        <p>Release 1.2 notes are here.</p>
        <a href="/notes">Release notes</a>
      </section>
    </main>
    <script>
      const toggle = document.getElementById('toggle');
      const details = document.getElementById('details');
      toggle.addEventListener('click', () => {
        const open = details.hidden;
        details.hidden = !open;
        toggle.textContent = open ? 'Hide details' : 'Show details';
        toggle.setAttribute('aria-expanded', String(open));
      });
      document.getElementById('signup').addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const result = document.createElement('a');
        result.id = 'signup-result';
        result.href = '/success';
        result.textContent = 'Welcome ' + data.get('name') + ' (' + data.get('email') + ')';
        document.querySelector('main').append(result);
      });
    </script>
  </body>
</html>`,
  '/perm-a': `<!doctype html>
<html lang="en"><head><title>Permission A</title></head><body><h1>Permission A</h1><button id="act-a">Action A</button><p id="result-a">Ready</p><script>document.getElementById('act-a').addEventListener('click', () => { document.getElementById('act-a').textContent = 'Action A completed'; document.getElementById('result-a').textContent = 'Done'; });</script></body></html>`,
  '/perm-b': `<!doctype html>
<html lang="en"><head><title>Permission B</title></head><body><h1>Permission B</h1><p>Session B private tab.</p></body></html>`,
  '/secret': `<!doctype html>
<html lang="en"><head><title>Secret</title></head><body><h1>Secret</h1><p>SECRET-OF-SITE-A-INBOX</p></body></html>`,
  '/regex': `<!doctype html>
<html lang="en"><head><title>Regex timeout</title></head><body><h1>Regex timeout</h1><p>${'a'.repeat(350)}!</p></body></html>`,
  '/search': `<!doctype html>
<html lang="en"><head><title>Search</title></head><body><h1>Search</h1><form action="/about" method="get"><label>Query <input name="q" type="text"></label></form></body></html>`,
  '/about': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>About</title></head>
  <body>
    <h1>About</h1>
    <p>A page to open and read next to the main one.</p>
    <a href="/">Back home</a>
  </body>
</html>`,
};
