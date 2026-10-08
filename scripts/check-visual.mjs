#!/usr/bin/env node
// Checks index.html against the visual design rules in AGENTS.md.
// Drives headless Chrome over the DevTools pipe, so it needs no npm packages.
//
//   node scripts/check-visual.mjs [page]   check index.html (or page), exit 1 on failure
//   node scripts/check-visual.mjs --hook   Claude Code Stop hook: skip when the
//                                          page is unchanged, exit 2 on failure
//
// Set CHROME_PATH to pick a browser; otherwise common install paths are tried.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || join(ROOT, 'index.html'));
const NAME = relative(ROOT, PAGE);
const WATCHED = ['index.html', 'scripts.js', 'images'];

function pageChanged() {
  const git = (...args) => {
    try {
      execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  };
  const uncommitted = git('diff', '--quiet', 'HEAD', '--', ...WATCHED);
  const onBranch = git('diff', '--quiet', 'origin/master...HEAD', '--', ...WATCHED);
  return uncommitted || onBranch;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const caches = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
  for (const cache of caches.filter(existsSync)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell'))) {
      for (const sub of readdirSync(join(cache, dir))) {
        const bin = join(cache, dir, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(existsSync);
}

// Runs inside the page before any page script, so it sees motion that starts on load.
const RECORD_MOTION = `
  window.__motion = new Set();
  const record = (e) => {
    const section = e.target.closest && e.target.closest('section');
    if (section) window.__motion.add(section);
  };
  document.addEventListener('animationstart', record, true);
  document.addEventListener('transitionstart', record, true);
`;

// Runs inside the page after load. Returns a list of failure messages.
const AUDIT = `(async (reduced) => {
  const failures = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (s) => s.id || s.querySelector('h1,h2,h3')?.textContent.trim().slice(0, 40) || 'unnamed section';
  const sections = [...document.querySelectorAll('section')];
  if (!sections.length && !reduced) failures.push('no <section> elements: wrap each resume section in <section>');

  for (const s of sections) {
    s.scrollIntoView({ block: 'center' });
    await sleep(400);
  }
  await sleep(400);

  const metric = /\\$\\d|\\d[\\d,.]*\\s?(%|x\\b|×|[KMB]\\+|TB|ms\\b|QPS)/;
  for (const s of sections) {
    const name = label(s);
    if (reduced) {
      if (window.__motion.has(s)) failures.push(name + ': animates even when prefers-reduced-motion is reduce');
      const hidden = [s, ...s.querySelectorAll('*')].some((el) => {
        const css = getComputedStyle(el);
        return css.opacity === '0' || css.visibility === 'hidden';
      });
      if (hidden) failures.push(name + ': content stays hidden when prefers-reduced-motion is reduce');
      continue;
    }
    if (!window.__motion.has(s)) failures.push(name + ': no entrance animation or transition when scrolled into view');
    if (metric.test(s.textContent) && !s.querySelector('svg, canvas, [data-viz]')) {
      failures.push(name + ': states metrics but has no visual (svg, canvas, or [data-viz])');
    }
  }
  if (reduced) return failures;

  const controls = [...document.querySelectorAll('button, summary, [aria-expanded], [role="tab"], input, select')];
  if (!controls.length) failures.push('no interactive elements (button, summary, [aria-expanded], tab, input, or select)');
  for (const el of controls) {
    const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' + el.textContent.trim().slice(0, 30) + '"';
    if (el.tabIndex < 0 || el.disabled) {
      failures.push(name + ': not reachable by keyboard');
      continue;
    }
    const restingShadow = getComputedStyle(el).boxShadow;
    el.focus({ focusVisible: true });
    const css = getComputedStyle(el);
    const ring = (css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0) || css.boxShadow !== restingShadow;
    if (document.activeElement !== el || !ring) failures.push(name + ': no visible focus indicator');
    el.blur();
  }
  return failures;
})`;

class Chrome {
  constructor(bin) {
    this.profile = mkdtempSync(join(tmpdir(), 'check-visual-'));
    const args = [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--window-size=1280,900',
      ...(process.env.CI ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let log = '';
    this.proc.stderr.on('data', (chunk) => (log = (log + chunk).slice(-2000)));
    this.proc.on('exit', (code) => {
      const err = new Error(`Chrome exited early (code ${code}):\n${log.trim()}`);
      for (const { fail } of this.pending.values()) fail(err);
      this.pending.clear();
    });
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = [];
    this.exceptions = [];
    let buffer = '';
    this.proc.stdio[4].on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        this.dispatch(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  }

  dispatch(msg) {
    if (msg.id !== undefined) {
      const { ok, fail } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? fail(new Error(`${msg.error.message}`)) : ok(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    this.waiters = this.waiters.filter((w) => (w.method === msg.method ? (w.ok(msg.params), false) : true));
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }

  once(method) {
    return new Promise((ok) => this.waiters.push({ method, ok }));
  }

  async close() {
    if (this.proc.exitCode === null) {
      const exited = new Promise((ok) => this.proc.once('exit', ok));
      this.proc.kill();
      await exited;
    }
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function audit(bin) {
  const chrome = new Chrome(bin);
  try {
    const { targetInfos } = await chrome.send('Target.getTargets');
    const { targetId } = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => chrome.send(method, params, sessionId);
    await page('Page.enable');
    await page('Runtime.enable');
    await page('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_MOTION });

    const failures = [];
    for (const reduced of [false, true]) {
      await page('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
      });
      const loaded = chrome.once('Page.loadEventFired');
      await page('Page.navigate', { url: pathToFileURL(PAGE).href });
      await loaded;
      const { result, exceptionDetails } = await page('Runtime.evaluate', {
        expression: `${AUDIT}(${reduced})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`audit script failed: ${exceptionDetails.exception?.description}`);
      failures.push(...result.value);
    }
    failures.push(...chrome.exceptions.map((e) => `page threw: ${e}`));
    return failures;
  } finally {
    await chrome.close();
  }
}

async function main() {
  const hook = process.argv.includes('--hook');
  const failCode = hook ? 2 : 1;
  if (hook) {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    // A second stop in a row means Claude already saw the failures; let the turn end.
    if (input.stop_hook_active || !pageChanged()) return 0;
  }

  const bin = findChrome();
  if (!bin) {
    console.error('check-visual: no Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.');
    return failCode;
  }
  const timer = setTimeout(() => {
    console.error('check-visual: timed out after 60s');
    process.exit(failCode);
  }, 60_000);
  const failures = await audit(bin);
  clearTimeout(timer);

  if (!failures.length) {
    console.log(`check-visual: ${NAME} meets the visual design rules in AGENTS.md`);
    return 0;
  }
  console.error(`check-visual: ${NAME} breaks ${failures.length} visual design rule(s) from AGENTS.md:`);
  for (const f of failures) console.error(`  - ${f}`);
  return failCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`check-visual: ${err.stack || err}`);
    process.exit(process.argv.includes('--hook') ? 2 : 1);
  },
);
