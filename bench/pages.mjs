// The fixed pages the token benchmark reads. They must not change without the budget being redone:
// every number in bench/budget.json is a measurement of these pages and nothing else.

const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>${title}</title></head><body>${body}</body></html>`;

const FORM = shell(
  'Sign up',
  `<h1>Sign up</h1>
<nav aria-label="Main"><a href="/">Home</a> <a href="/products">Products</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a></nav>
<main>
  <h2>Create an account</h2>
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
    const result = document.createElement('p');
    result.textContent = 'Welcome ' + data.get('name') + ' (' + data.get('email') + ')';
    document.querySelector('main').append(result);
  });
</script>`,
);

const PRODUCTS = [
  ['Trail shoes', 'Light shoes with a grippy sole for wet ground.'],
  ['Rain jacket', 'A packable shell that keeps out heavy rain.'],
  ['Day pack', 'Twenty litres, a hip belt and a rain cover.'],
  ['Water bottle', 'Steel, one litre, keeps drinks cold for a day.'],
  ['Head torch', 'Three modes, 300 lumens, runs on one AAA battery.'],
  ['Wool socks', 'Merino, mid height, no seams over the toes.'],
];

const productList = shell(
  'Products',
  `<h1>Products</h1>
<nav aria-label="Main"><a href="/">Home</a> <a href="/products">Products</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a></nav>
<main>
  <h2>All products</h2>
  <ul>${PRODUCTS.map(([name, blurb], index) => `<li><a href="/products/${index + 1}">${name}</a> <span>${blurb}</span></li>`).join('\n  ')}</ul>
</main>`,
);

const productPage = (index) => {
  const [name, blurb] = PRODUCTS[index - 1];
  return shell(
    name,
    `<h1>${name}</h1>
<nav aria-label="Main"><a href="/">Home</a> <a href="/products">Products</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a></nav>
<main>
  <p>${blurb}</p>
  <h2>Buy</h2>
  <label>Quantity <input name="quantity" type="number" value="1"></label>
  <button>Add to cart</button>
  <a href="/products">Back to all products</a>
</main>`,
  );
};

const SENTENCES = [
  'Requests are authenticated with a bearer token that you create in the dashboard.',
  'Every response carries a request id, which support can use to find the call in the logs.',
  'Pages of results hold at most one hundred items and end with a cursor for the next page.',
  'Webhooks are retried for a day with growing gaps, and a retry keeps the original event id.',
  'Timestamps are in UTC and written as ISO 8601 text with a trailing Z.',
  'Idempotency keys let a client repeat a write without creating the same record twice.',
  'Deleted records stay readable for thirty days and can be restored during that time.',
];

const RATE_LIMIT = 'A rate limit of sixty requests per minute applies to each token, and a limited call returns status 429.';

const docsSection = (index) => {
  const sentences = [0, 1, 2].map((offset) => SENTENCES[(index + offset * 3) % SENTENCES.length]);
  // Only three topics mention the limit, so a search for it finds a few places, as on a real page.
  if (index % 8 === 0) sentences.push(RATE_LIMIT);
  return `<section aria-labelledby="s${index}">
  <h2 id="s${index}">Topic ${index}: ${['Tokens', 'Pages', 'Events', 'Limits', 'Records', 'Webhooks'][index % 6]}</h2>
  <p>${sentences.join(' ')}</p>
  <p>${SENTENCES[(index * 5 + 1) % SENTENCES.length]} See <a href="/docs#s${index}-more">the details for topic ${index}</a>.</p>
  <button>Copy example ${index}</button>
</section>`;
};

const DOCS = shell(
  'API guide',
  `<h1>API guide</h1>
<nav aria-label="Main"><a href="/">Home</a> <a href="/products">Products</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a></nav>
<form role="search" aria-label="Search the guide"><label>Search <input name="q" type="search"></label> <button type="submit">Search</button></form>
<main>
${Array.from({ length: 24 }, (_, index) => docsSection(index + 1)).join('\n')}
</main>
<footer><p>Last updated 21 November 2026.</p><a href="/contact">Contact us</a></footer>`,
);

const DEPARTMENTS = ['Tents', 'Sleeping bags', 'Stoves', 'Lights', 'Packs', 'Footwear', 'Jackets', 'Trousers', 'Gloves', 'Hats', 'Maps', 'Repairs'];
const ITEM_KINDS = ['tent', 'stove', 'lamp', 'pack', 'boot', 'jacket', 'glove', 'map'];

/**
 * A long catalogue: a header with two navigations, an introduction, 80 items (a link and a line about it each), an order
 * form after them and a footer. Sent to `/catalogue/order`, the form comes back with its email field marked invalid and an
 * error under it, as a server that checks a form does.
 */
const catalogue = (ordered) =>
  shell(
    ordered ? 'Catalogue: check your order' : 'Catalogue',
    `<header><a href="/">Outfitters</a>
<nav aria-label="Main"><a href="/">Home</a> <a href="/products">Products</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a></nav>
<nav aria-label="Departments">${DEPARTMENTS.map((name, index) => `<a href="/catalogue/d${index + 1}">${name}</a>`).join(' ')}</nav></header>
<main>
  <h1>Catalogue</h1>
  <p>${SENTENCES.slice(0, 3).join(' ')} Every item ships within two working days from the warehouse nearest to you.</p>
  <p>${SENTENCES.slice(3, 6).join(' ')} Returns are free for thirty days, in the box the item came in.</p>
  <h2>All items</h2>
  <ul>${Array.from({ length: 80 }, (_, index) => {
    const kind = ITEM_KINDS[index % ITEM_KINDS.length];
    return `<li><a href="/catalogue/${index + 1}">Item ${index + 1}: field ${kind}</a> <span>A ${kind} for long trips, ${200 + index * 7} grams, in stock.</span></li>`;
  }).join('\n  ')}</ul>
  <h2>Order</h2>
  <form aria-label="Order" action="/catalogue/order" method="get">
    <label>Email <input name="email" type="text"${ordered ? ' aria-invalid="true" aria-describedby="email-error"' : ''}></label>
    ${ordered ? '<p id="email-error">Enter an email address with an @ in it.</p>' : ''}
    <label>Quantity <input name="quantity" type="number" value="1"></label>
    <button type="submit">Place order</button>
  </form>
</main>
<footer>${['About', 'Careers', 'Press', 'Stores', 'Help', 'Shipping', 'Returns', 'Warranty', 'Privacy', 'Terms'].map((name) => `<a href="/${name.toLowerCase()}">${name}</a>`).join(' ')}</footer>`,
  );

const NOT_FOUND = shell('Not found', '<h1>Not found</h1>');

/** The page for a request path, and its status. */
export function benchPage(path) {
  if (path === '/form') return { status: 200, body: FORM };
  if (path === '/products') return { status: 200, body: productList };
  if (path === '/docs') return { status: 200, body: DOCS };
  if (path === '/catalogue') return { status: 200, body: catalogue(false) };
  if (path === '/catalogue/order') return { status: 200, body: catalogue(true) };
  const product = /^\/products\/([1-6])$/.exec(path);
  if (product !== null) return { status: 200, body: productPage(Number(product[1])) };
  return { status: 404, body: NOT_FOUND };
}
