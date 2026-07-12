// Interactive terminal chat for dola.com.
//
//   node chat.js            # start in Fast mode
//   node chat.js pro        # start in Pro mode
//   node chat.js --model pro
//
// In-chat commands:
//   /model            show current model + options
//   /model fast|pro   switch model (keeps the conversation)
//   /new              start a fresh conversation (clears context)
//   /paste            attach an image from the clipboard (same as Ctrl-V)
//   /help             list commands
//   /exit  (or Ctrl-C, or Ctrl-D)   quit
//
// Vision: press Ctrl-V (macOS) to attach an image that's on your clipboard, then type your
// question and hit Enter — the image is sent to the model with your message.
//
// Unlike the HTTP proxy (which is stateless), this REPL keeps one Dola conversation
// for the whole session, so the model remembers what you said earlier.

import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamCompletion, uploadImage } from './src/dola.js';
import { downloadMedia } from './src/media.js';

// Load .env for DOLA_COOKIE (Node >=20.6).
try { process.loadEnvFile?.(); } catch { /* rely on real env */ }

const COOKIE = process.env.DOLA_COOKIE || '';

// Read an image off the clipboard as PNG bytes (macOS). Returns Buffer or null.
// Uses AppleScript to write the clipboard's PNG data to a temp file; throws inside osascript
// if the clipboard holds no image, which we catch and treat as "nothing to paste".
function clipboardImage() {
  if (process.platform !== 'darwin') return null;
  const tmp = path.join(os.tmpdir(), `dola-clip-${Date.now()}.png`);
  try {
    execFileSync('osascript', [
      '-e', 'set thePng to (the clipboard as «class PNGf»)',
      '-e', `set fp to open for access POSIX file "${tmp}" with write permission`,
      '-e', 'write thePng to fp',
      '-e', 'close access fp',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf.length ? buf : null;
  } catch {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* ignore */ }
    return null;
  }
}

// PNG dimensions from the IHDR chunk (bytes 16..24).
function pngSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

const MODELS = {
  fast: { deepThink: 0, label: 'Fast — solves most problems' },
  pro: { deepThink: 3, label: 'Pro — advanced, shows reasoning' },
};

// ---- ANSI helpers (no dependencies) ----
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ---- pick starting model from argv ----
function parseModelArg() {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === '--model' || a === '-m');
  let m = i >= 0 ? args[i + 1] : args.find((a) => !a.startsWith('-'));
  m = (m || 'fast').toLowerCase();
  return MODELS[m] ? m : 'fast';
}

let modelKey = parseModelArg();
let conversationId = undefined; // undefined => next message creates a fresh conversation
let pendingImages = [];         // uploaded images to attach to the next message
let busy = false;               // a request is in flight

if (!COOKIE) {
  console.error(c.red('DOLA_COOKIE is not set.'));
  console.error('Paste your dola.com cookie into .env (DOLA_COOKIE="..."), then rerun.');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => {
  const imgTag = pendingImages.length ? c.dim(` [${pendingImages.length} img]`) : '';
  rl.setPrompt(c.cyan(`dola:${modelKey}`) + c.dim(conversationId ? '' : ' (new)') + imgTag + '> ');
  rl.prompt();
};

// Grab an image off the clipboard, upload it to Dola, and queue it for the next message.
async function pasteImage() {
  if (busy) return;
  const buf = clipboardImage();
  if (!buf) { process.stdout.write('\n' + c.dim(process.platform === 'darwin' ? 'no image on clipboard' : 'clipboard paste is macOS-only') + '\n'); prompt(); return; }
  const { width, height } = pngSize(buf);
  process.stdout.write('\n' + c.dim(`uploading image (${width}×${height})…`));
  try {
    const img = await uploadImage(COOKIE, buf, 'clipboard.png', width, height);
    pendingImages.push(img);
    process.stdout.write('\r' + c.green(`✓ image attached (${width}×${height}) — type your question and Enter`) + '\n');
  } catch (e) {
    process.stdout.write('\r' + c.red(`image upload failed: ${e.message}`) + '\n');
  }
  prompt();
}

// Ctrl-V handler. Terminals can't paste image data as text, so we intercept the keypress
// and pull the image from the OS clipboard ourselves.
readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', (_ch, key) => {
  if (key && key.ctrl && key.name === 'v') pasteImage();
});

function banner() {
  console.log(c.bold('Dola chat') + c.dim('  —  type /help for commands, /exit to quit'));
  console.log(c.dim(`model: ${modelKey} (${MODELS[modelKey].label})`));
}

function handleCommand(line) {
  const [cmd, arg] = line.trim().split(/\s+/, 2);
  switch (cmd) {
    case '/exit':
    case '/quit':
      rl.close();
      return true;
    case '/help':
      console.log(c.dim([
        '/model            show current model',
        '/model fast|pro   switch model',
        '/paste            attach an image from the clipboard (or press Ctrl-V)',
        '/new              start a fresh conversation',
        '/exit             quit',
      ].join('\n')));
      return true;
    case '/paste':
      pasteImage();
      return true;
    case '/model':
      if (!arg) {
        console.log(c.dim(`current: ${modelKey}`));
        for (const [k, v] of Object.entries(MODELS)) {
          console.log(`  ${k === modelKey ? c.green('●') : ' '} ${c.bold(k)} — ${v.label}`);
        }
      } else if (MODELS[arg.toLowerCase()]) {
        modelKey = arg.toLowerCase();
        console.log(c.dim(`switched to ${modelKey}`));
      } else {
        console.log(c.red(`unknown model "${arg}". options: ${Object.keys(MODELS).join(', ')}`));
      }
      return true;
    case '/new':
      conversationId = undefined;
      console.log(c.dim('started a fresh conversation (context cleared)'));
      return true;
    default:
      console.log(c.red(`unknown command "${cmd}". try /help`));
      return true;
  }
}

async function send(text) {
  const model = MODELS[modelKey];
  let thinkingLabel = false;
  let answerLabel = false;
  const images = pendingImages;
  pendingImages = []; // consume attachments for this turn
  try {
    const out = await streamCompletion({
      cookie: COOKIE,
      conversationId,
      text,
      images,
      deepThink: model.deepThink,
      onThinking: (t) => {
        if (!thinkingLabel) { process.stdout.write(c.dim('[thinking] ')); thinkingLabel = true; }
        process.stdout.write(c.dim(t));
      },
      onDelta: (t) => {
        if (!answerLabel) {
          if (thinkingLabel) process.stdout.write('\n');
          process.stdout.write(c.green('assistant› '));
          answerLabel = true;
        }
        process.stdout.write(t);
      },
    });
    conversationId = out.conversationId || conversationId; // keep context across turns
    // Download any generated media locally — Dola's URLs are signed and 403 in a browser.
    if (out.mediaUrls?.length) {
      if (answerLabel) process.stdout.write('\n');
      process.stdout.write(c.dim(`downloading ${out.mediaUrls.length} file(s)…`));
      const paths = [];
      for (const m of out.mediaUrls) {
        try { paths.push((await downloadMedia(m.url, m.kind)).filepath); }
        catch (e) { paths.push(`(failed: ${e.message})`); }
      }
      process.stdout.write('\r' + c.green(`saved ${paths.length} file(s):`) + '\n');
      for (const p of paths) process.stdout.write('  ' + p + '\n');
    } else if (!answerLabel) {
      process.stdout.write(c.dim('(no content returned)') + '\n');
    } else {
      process.stdout.write('\n');
    }
  } catch (e) {
    process.stdout.write('\n' + c.red(`error: ${e.message}`) + '\n');
    if (/HTTP 401|not login|token|login/i.test(e.message)) {
      console.log(c.dim('Your cookie may have expired — refresh DOLA_COOKIE in .env.'));
    }
  }
}

banner();
prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (text.startsWith('/')) {
    // /paste manages its own prompt (async); other commands prompt here.
    if (text.trim() === '/paste') { handleCommand(text); return; }
    handleCommand(text);
    if (!rl.closed) prompt();
    return;
  }
  if (!text && !pendingImages.length) return prompt();
  busy = true;
  rl.pause();
  await send(text);
  busy = false;
  if (shouldExit) { console.log(c.dim('bye')); process.exit(0); }
  rl.resume();
  prompt();
});

let shouldExit = false;
rl.on('close', () => {
  // Don't cut off an in-flight request/download; finish it first.
  if (busy) { shouldExit = true; return; }
  console.log(c.dim('\nbye'));
  process.exit(0);
});
