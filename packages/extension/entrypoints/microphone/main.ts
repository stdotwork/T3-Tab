// Opened in a tab by the side panel's mic button: a side panel cannot show the browser's permission prompt, a tab can.
// The grant is for the extension, so the panel can record once it is given here.
const title = document.getElementById('title') as HTMLElement;
const detail = document.getElementById('detail') as HTMLElement;
const again = document.getElementById('again') as HTMLButtonElement;

function show(heading: string, text: string, retry: boolean): void {
  title.textContent = heading;
  detail.textContent = text;
  again.hidden = !retry;
  again.textContent = 'Try again';
}

async function ask(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    show('The microphone is on for T3-Tab', 'Go back to the side panel and press the microphone again. This tab closes by itself.', false);
    setTimeout(() => window.close(), 1_500);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotFoundError') show('No microphone found', 'Connect a microphone, then try again.', true);
    else if (name === 'NotReadableError') show('The microphone is busy', 'Another program may be using it, or the system did not let the browser use it.', true);
    else show('The microphone was not allowed', "Allow it with the icon in the address bar, or in the browser's site settings for this extension, then try again.", true);
  }
}

again.addEventListener('click', () => void ask());
void ask();
