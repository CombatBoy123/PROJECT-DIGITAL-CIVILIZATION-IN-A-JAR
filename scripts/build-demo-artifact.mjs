/**
 * Build the standalone browser demo as ONE self-contained HTML fragment.
 *
 *   pnpm demo:build
 *
 * 1. Runs the Vite demo build (apps/web/vite.demo.config.ts → apps/web/dist-demo/).
 * 2. Inlines the emitted CSS and the single JS bundle into
 *    apps/web/dist-demo/digital-civilization-in-a-jar.html.
 *
 * The output is a fragment, not a full document: the publishing host wraps it in
 * <!doctype html><head>…</head><body>. It is, in order: <title>, the
 * viewport-fit meta, one inline <style>, <div id="root"></div>, and one inline
 * <script type="module">. It loads nothing from the network.
 *
 * Fails (exit code 1) if Vite emitted anything besides demo.html, one .js and at
 * most one .css file: everything must be inline.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps', 'web');
const outDir = join(webDir, 'dist-demo');
const outFile = join(outDir, 'digital-civilization-in-a-jar.html');
const TITLE = 'Digital Civilization in a Jar';

function fail(message) {
  process.stderr.write(`build-demo-artifact: ${message}\n`);
  process.exit(1);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Text that is safe inside an inline <script>: no premature end tag, no comment opener. */
function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

/** Text that is safe inside an inline <style>. */
function escapeStyle(css) {
  return css.replace(/<\/style/gi, '<\\/style');
}

// 1. Vite build (same toolchain as the app; no new dependencies).
process.stdout.write('Building the demo bundle with Vite…\n');
try {
  execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.demo.config.ts'], {
    cwd: webDir,
    stdio: 'inherit',
  });
} catch {
  fail('the Vite demo build failed (see above).');
}

// 2. Check that everything was emitted as one JS and one CSS file.
const files = listFiles(outDir).filter((f) => f !== outFile);
const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));
const html = files.filter((f) => f.endsWith('.html'));
const others = files.filter((f) => !js.includes(f) && !css.includes(f) && !html.includes(f));
const rel = (list) => list.map((f) => relative(outDir, f)).join(', ');
if (js.length !== 1) fail(`expected exactly one JS file, found ${js.length}: ${rel(js)}`);
if (css.length > 1) fail(`expected at most one CSS file, found ${css.length}: ${rel(css)}`);
if (html.length !== 1) fail(`expected only demo.html, found: ${rel(html)}`);
if (others.length > 0) fail(`assets were emitted as separate files: ${rel(others)}`);

const script = readFileSync(js[0], 'utf8');
const style = css.length === 1 ? readFileSync(css[0], 'utf8') : '';

// The bundle must not try to load further chunks or files at runtime.
if (/\bimport\s*\(\s*["'`]\.{0,2}\//.test(script))
  fail('the bundle contains a dynamic import of a file.');

// 3. Assemble the fragment.
const fragment = [
  `<title>${TITLE}</title>`,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  `<style>\n${escapeStyle(style)}\n</style>`,
  '<div id="root"></div>',
  `<script type="module">\n${escapeScript(script)}\n</script>`,
  '',
].join('\n');
writeFileSync(outFile, fragment);

const bytes = statSync(outFile).size;
const mib = (bytes / 1024 / 1024).toFixed(2);
process.stdout.write(
  `\nWrote ${relative(root, outFile)}\n` +
    `  size: ${bytes.toLocaleString('en-US')} bytes (${mib} MiB; JS ${script.length.toLocaleString('en-US')} chars, CSS ${style.length.toLocaleString('en-US')} chars)\n`,
);
if (bytes > 16 * 1024 * 1024) fail('the artifact exceeds 16 MB.');
