export const isMac = /Mac/i.test(navigator.userAgent);
export const isApplyShortcut = e => e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey);
