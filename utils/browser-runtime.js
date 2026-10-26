'use strict';

// The local slideshow renderer needs a Chromium-family browser. This module finds one
// (Playwright's own download first, then any Chrome/Chromium/Edge already on the machine)
// and can install Playwright's Chromium on request so nobody has to open a terminal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const INSTALL_LOG_LIMIT = 4000;

let installState = { status: 'idle', startedAt: null, finishedAt: null, log: '', error: null };
let installPromise = null;

function exists(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        if (exists(candidate)) return candidate;
      }
    }
  }
  return null;
}

function browsersRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

// Any Chromium build Playwright has downloaded, newest first (it may differ from the exact
// revision this version of Playwright expects, which is fine for rendering still images).
function playwrightDownloads() {
  const root = browsersRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root).filter(name => /^chromium-\d+$/.test(name));
  } catch (_error) {
    return [];
  }
  entries.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  // Playwright changed the folder names between releases, so try both layouts.
  const layouts = {
    linux: [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']],
    darwin: [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
    ],
    win32: [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
  }[process.platform] || [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
  const results = [];
  for (const entry of entries) {
    for (const layout of layouts) {
      const candidate = path.join(root, entry, ...layout);
      if (exists(candidate)) results.push(candidate);
    }
  }
  return results;
}

function systemBrowsers() {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  }
  const onPath = findOnPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']);
  if (onPath) candidates.push(onPath);
  return candidates.filter(exists);
}

function playwrightDefaultPath() {
  try {
    const { chromium } = require('playwright');
    const executable = chromium.executablePath();
    return exists(executable) ? executable : null;
  } catch (_error) {
    return null;
  }
}

// Ordered list of browsers that could render slides, with where each came from.
function candidateBrowsers() {
  const found = [];
  const add = (executablePath, source) => {
    if (executablePath && !found.some(item => item.executablePath === executablePath)) found.push({ executablePath, source });
  };
  if (process.env.CHROMIUM_PATH && exists(process.env.CHROMIUM_PATH)) add(process.env.CHROMIUM_PATH, 'CHROMIUM_PATH');
  add(playwrightDefaultPath(), 'Playwright Chromium');
  for (const download of playwrightDownloads()) add(download, 'Playwright Chromium');
  for (const browser of systemBrowsers()) add(browser, 'Installed browser');
  return found;
}

function getRendererStatus() {
  const [best] = candidateBrowsers();
  return {
    ready: Boolean(best),
    source: best ? best.source : null,
    executablePath: best ? best.executablePath : null,
    install: { ...installState }
  };
}

// Starts a browser for rendering slides. Tries each candidate until one launches.
async function launchRenderer(launchOptions = {}) {
  const { chromium } = require('playwright');
  const errors = [];
  for (const candidate of candidateBrowsers()) {
    try {
      return await chromium.launch({
        executablePath: candidate.executablePath,
        // The sandbox needs kernel features that containers and some Linux setups do not
        // provide; this process only opens pages generated by this app.
        args: process.platform === 'linux' ? ['--no-sandbox'] : [],
        ...launchOptions
      });
    } catch (error) {
      errors.push(`${candidate.source}: ${String(error.message).split('\n')[0]}`);
    }
  }
  const hint = 'No browser is available to render slides. Open Connections and choose "Install renderer", or install Google Chrome.';
  throw new Error(errors.length ? `${hint} (${errors.join('; ')})` : hint);
}

function appendLog(text) {
  installState.log = (installState.log + text).slice(-INSTALL_LOG_LIMIT);
}

// Downloads Playwright's Chromium. Only one install runs at a time.
function installRenderer() {
  if (installPromise) return installPromise;
  let cli;
  try {
    cli = require.resolve('playwright/cli.js');
  } catch (_error) {
    return Promise.reject(new Error('Playwright is not installed. Reinstall the app dependencies.'));
  }
  installState = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, log: '', error: null };
  installPromise = new Promise(resolve => {
    const args = [cli, 'install', 'chromium'];
    if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--with-deps');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.stdout.on('data', chunk => appendLog(chunk.toString()));
    child.stderr.on('data', chunk => appendLog(chunk.toString()));
    child.on('error', error => finish(`Could not start the installer: ${error.message}`));
    child.on('close', code => finish(code === 0 ? null : `The installer exited with code ${code}.`));
    function finish(errorMessage) {
      clearTimeout(timer);
      installState = {
        ...installState,
        status: errorMessage ? 'failed' : 'done',
        finishedAt: new Date().toISOString(),
        error: errorMessage
      };
      installPromise = null;
      resolve(getRendererStatus());
    }
  });
  return installPromise;
}

function startRendererInstall() {
  if (installState.status === 'running') return getRendererStatus();
  installRenderer().catch(() => {});
  return getRendererStatus();
}

module.exports = { getRendererStatus, launchRenderer, startRendererInstall, candidateBrowsers };
