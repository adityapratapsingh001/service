import path from 'path';
import fs from 'fs';
export function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    let candidates = [];
    if (process.platform === 'win32') {
        candidates = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
        ];
    } else {
        candidates = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium'
        ];
    }
    for (const executablePath of candidates) {
        if (executablePath && fs.existsSync(executablePath)) return executablePath;
    }
    return null;
}
export function getProfileDir() {
    let dir = process.env.TS_PROFILE_DIR;
    if (!dir) {
        // A STABLE location, not %TEMP% (which disk-cleanup can wipe, losing
        // the ChatGPT login). Both login.js and app.js resolve to the same dir
        // so the session is shared.
        if (process.platform === 'win32') {
            const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.USERPROFILE || 'C:\\';
            dir = path.join(base, 'gpt2api-chrome-profile');
        } else {
            dir = path.join(process.env.HOME || '/tmp', '.gpt2api-chrome-profile');
        }
    }
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}