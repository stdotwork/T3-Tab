import { describe, expect, it } from 'vitest';

import { isSidePanelSender } from '../src/panel-security';

const id = 'gggnknbjooockcnnocejdolfdpjifebm';

describe('side-panel message sender', () => {
  it('accepts only the extension side-panel page with no tab sender', () => {
    expect(isSidePanelSender({ id, url: `chrome-extension://${id}/sidepanel.html` }, id)).toBe(true);
    expect(isSidePanelSender({ id, url: `chrome-extension://${id}/sidepanel.html?tabId=4` }, id)).toBe(true);
  });

  it('rejects other senders, extension pages in tabs, and other paths', () => {
    expect(isSidePanelSender({ id: 'other', url: `chrome-extension://${id}/sidepanel.html` }, id)).toBe(false);
    expect(isSidePanelSender({ id, tab: { id: 1 }, url: `chrome-extension://${id}/sidepanel.html` }, id)).toBe(false);
    expect(isSidePanelSender({ id, url: `chrome-extension://${id}/background.js` }, id)).toBe(false);
    expect(isSidePanelSender({ id, url: 'https://example.com/sidepanel.html' }, id)).toBe(false);
    expect(isSidePanelSender({ id }, id)).toBe(false);
  });
});
