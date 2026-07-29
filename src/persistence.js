// Crash/reload recovery for per-track DSL code.
const PREFIX = 'spectraloli:code:';
const saveTimers = new Map();

export function loadSavedCode(name) {
    try {
        return localStorage.getItem(PREFIX + name) || null;
    } catch {
        return null;
    }
}

export function scheduleSaveCode(name, code) {
    clearTimeout(saveTimers.get(name));
    saveTimers.set(name, setTimeout(() => {
        try {
            if (code) localStorage.setItem(PREFIX + name, code);
            else localStorage.removeItem(PREFIX + name);
        } catch {
            // localStorage unavailable
            console.log('localStorage is unavailable');
        }
    }, 400));
}
