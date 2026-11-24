export const EXTENSION_MANIFEST_VERSION = 3;
export const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAupWDfC6cIQKfe0nJcN3X+66rH48nV9/aj5Z2NHM5z5tK2dTGh812c23hQ+p6zkPltJiodV5+mh+iUivMxBZxrlVFdiF/uY7SpB1AMmXVE5q3gQ5P25IxD33eVWWqns9NcOqhHIZrgdaaoB/BD8DsJ98qv1QGD8xU318ClKL7b+n6v6DuxojRVRGK9PU3Ho+CFbKA8HPEybI7BFrJ9vKWunNX7pOQF1Oi9MR16H/EVpVAAiu3wKtmLjIn5tBTZ2Fv6dyEPYkuoEvc9OLmrh+ut+CBZQF7j1B3jzaNUyFdB7qdlJgyxZdRhWgnwGwgEVz9Ke450h8Ol10PraO9ve6iLQIDAQAB';

export const EXTENSION_MANIFEST = {
  name: 'T3-Tab',
  description: 'Browser tools and a side panel for coding agents.',
  version: '0.1.0',
  key: EXTENSION_KEY,
  permissions: ['debugger', 'nativeMessaging', 'scripting', 'sidePanel', 'storage', 'tabGroups', 'tabs', 'webNavigation'],
  // Only for `clearForeignFrames`: the debugger already reaches every page, but `chrome.scripting` needs this too.
  host_permissions: ['<all_urls>'],
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: {
    default_title: 'T3-Tab',
    default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  },
};
