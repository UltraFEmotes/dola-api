// Shared helper: download generated media (Dola's signed, hotlink-protected URLs) into a local
// generated_content/ folder so the files are stable and openable. Used by both server.js (which
// then serves them over HTTP) and chat.js (which prints the local path).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'generated_content');

export const EXT_BY_CT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'image/gif': 'gif',
};

export function ensureGenDir() {
  fs.mkdirSync(GEN_DIR, { recursive: true });
}

// Download one media URL into generated_content. Returns { name, filepath }.
// A plain server-side fetch works even though these URLs 403 when opened directly in a browser.
export async function downloadMedia(url, hintKind) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = (r.headers.get('content-type') || '').split(';')[0];
  let ext = EXT_BY_CT[ct];
  if (!ext) {
    const m = url.split('?')[0].match(/\.(jpe?g|png|webp|mp4|gif)(?=[^.]*$)/i);
    ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : (hintKind === 'video' ? 'mp4' : 'jpg');
  }
  ensureGenDir();
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = path.join(GEN_DIR, name);
  fs.writeFileSync(filepath, buf);
  return { name, filepath };
}
