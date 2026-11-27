// A closed shadow root, as Bitwarden's inline menu uses, so the page's own DOM cannot see the frame.
function addFrame() {
  if (document.getElementById('injected-menu') !== null) return;
  const host = document.createElement('div');
  host.id = 'injected-menu';
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('menu.html');
  frame.style = 'position:fixed;top:0;right:0;width:200px;height:80px;border:0';
  host.attachShadow({ mode: 'closed' }).append(frame);
  document.documentElement.append(host);
}

document.addEventListener(
  'focusin',
  (event) => {
    if (event.target.matches?.('input[type=password], input[name=username]')) addFrame();
  },
  true,
);

// A key that opens a frame, as Vimium's search bar does: the debugger drops while the key press is in flight.
document.addEventListener('keydown', (event) => {
  if (event.key === '/') addFrame();
});
