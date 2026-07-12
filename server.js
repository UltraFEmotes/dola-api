// OpenAI-compatible HTTP proxy for dola.com (ByteDance Doubao).
//
// Endpoints:
//   GET  /health
//   GET  /v1/models
//   POST /v1/chat/completions        (model: "dola-fast" | "dola-pro")
//   POST /v1/images/generations      (image generation — free on Dola)
//   POST /v1/videos/generations      (video generation — Dreamina Seedance 1.0 only; costs Dola points)
//
// Stateless by design: every request spins up a brand-new Dola conversation, sends the
// message, waits for the assistant to finish, and returns the result — like a real API.
// (API-created conversations don't appear in the dola.com history sidebar, so they don't
// clutter the UI. Their messages still persist server-side.)
//
// Config via environment (see .env.example):
//   DOLA_COOKIE        required — full Cookie header from an authenticated dola.com session
//   DOLA_BOT_ID        optional — defaults to the Dola assistant bot
//   DOLA_DELETE_AFTER  optional — best-effort delete after each request (usually a no-op)
//   PORT               optional — defaults to 8787
//
// Feature flags. Everything is ON by default EXCEPT video generation (which can't return the
// finished clip from a standalone server and costs points). Set a flag to "0" to turn it off,
// or ENABLE_VIDEO=1 to re-enable video:
//   ENABLE_PRO     (default on)   dola-pro model
//   ENABLE_VISION  (default on)   sending images to the model
//   ENABLE_IMAGE   (default on)   /v1/images/generations
//   ENABLE_VIDEO   (default OFF)  /v1/videos/generations

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamCompletion, deleteConversation, uploadImage, CHAT_ABILITY, DEFAULT_BOT_ID } from './src/dola.js';
import { downloadMedia, ensureGenDir, GEN_DIR, EXT_BY_CT } from './src/media.js';

// Load .env if present (Node >=20.6). Non-fatal if missing.
try { process.loadEnvFile?.(); } catch { /* no .env file — rely on real env */ }

// flag(name, default): reads an env var as a boolean, falling back to `def` when unset.
const flag = (name, def = false) => {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
};
const PORT = Number(process.env.PORT || 8787);
const COOKIE = 'hook_slardar_session_id=202607121734367A737E2EB049E66EF99F; biz_trace_id=7bed4a6a; ttwid=1%7COvXHzbcwwGfAax-hznA2iWVR06MP2yVSkmzK37QbPvg%7C1783848903%7C47b387fb512443e86d76df47b66d73d2e2a6a06aa828e54231398b467783522c; flow_ssr_sidebar_expand=1; flow_user_country=AU; flow_cur_user_sec_id=Kz9bAGEdJCBsLCAyL0ERBDITDgNBCCdBKTgsO30lXRMVGg0ULWZQCConRSlnGTdLXg4nIUoRCiBmASVDHh4lRCgUMj5MWQo4FV0WBg==; dbx-web-theme=light; i18next=en; flow_multi_user_sec_info=Kz9bAGEdJCBsLCAyL0ERBDITDgNBCCdBKTgsO30lXRMVGg0ULWZQCConRSlnGTdLXg4nIUoRCiBmASVDHh4lRCgUMj5MWQo4FV0WBhcQCg1KAQRJWhpbQUFDQFseXVFKVw==; has_biz_token=false; odin_tt=53161185aed9b28635a5322f637a5c2fe52f857b68c49475dd2c143b81483021b2597a6bd8810524b4bab1ab3d7795ef75447ece3d5e9ce47c9bd9a30a2bc949; passport_auth_status=3301155c71eb680f236927bc03106ab1%2C; passport_auth_status_ss=3301155c71eb680f236927bc03106ab1%2C; sessionid=fc2555eefbc8ac89b55b4d30fe2c1f72; sessionid_ss=fc2555eefbc8ac89b55b4d30fe2c1f72; sid_guard=fc2555eefbc8ac89b55b4d30fe2c1f72%7C1783834436%7C5184000%7CThu%2C+10-Sep-2026+05%3A33%3A56+GMT; sid_tt=fc2555eefbc8ac89b55b4d30fe2c1f72; sid_ucp_v1=1.0.0-KGY3YjI5M2U3M2UwOTI0MzRjMTY5M2EwNzE3YTIyY2UxNjUxNWVlN2IKIAi1iIrk4J7IqWoQxM7M0gYYt6AeIAwwq87M0gY4CEASEAMaA215YSIgZmMyNTU1ZWVmYmM4YWM4OWI1NWI0ZDMwZmUyYzFmNzI; ssid_ucp_v1=1.0.0-KGY3YjI5M2U3M2UwOTI0MzRjMTY5M2EwNzE3YTIyY2UxNjUxNWVlN2IKIAi1iIrk4J7IqWoQxM7M0gYYt6AeIAwwq87M0gY4CEASEAMaA215YSIgZmMyNTU1ZWVmYmM4YWM4OWI1NWI0ZDMwZmUyYzFmNzI; store-country-code=au; store-country-code-src=uid; store-idc=mya; uid_tt=ad9ed71690f7a73a9bc3bc8d6fd64cd954ce4a22a8972ff287d7516a992fa91b; uid_tt_ss=ad9ed71690f7a73a9bc3bc8d6fd64cd954ce4a22a8972ff287d7516a992fa91b; msToken=GviXb5NSGJHWgp9xB7pa6Eznxg2k45ulEMaL5ot8PDBb9sm_lJsWKOU8AgsS-sK_QYDQnHz_5dwZERJe7PGgWhHaoAymNJBzx3_XDppUOfM2QR0bh3AxLQkDZti-Ca0=; oauth_token=cc191bf6-e550-475e-93dc-7fa10defe17f; oauth_token_v2=cc191bf6-e550-475e-93dc-7fa10defe17f; passport_csrf_token=3e550b90b96a37283146e2fedced75f9; passport_csrf_token_default=3e550b90b96a37283146e2fedced75f9; s_v_web_id=verify_mrhcyd50_lfsP19sz_hK2U_4Hrv_8uU4_V0GrBTHOuUdr';
const BOT_ID = process.env.DOLA_BOT_ID || DEFAULT_BOT_ID;
const DELETE_AFTER = flag('DOLA_DELETE_AFTER');
// Feature flags — everything on by default except video.
const ENABLE_PRO = flag('ENABLE_PRO', true);
const ENABLE_VISION = flag('ENABLE_VISION', true);
const ENABLE_IMAGE = flag('ENABLE_IMAGE', true);
const ENABLE_VIDEO = flag('ENABLE_VIDEO', false);
// Public base URL used to build links to generated media. Override if behind a proxy/tunnel.
const PUBLIC_BASE = (process.env.PUBLIC_BASE || `http://localhost:${PORT}`).replace(/\/$/, '');

// Best-effort: create the local generated_content/ folder. On a read-only serverless FS (Vercel)
// this fails harmlessly — media is still served by streaming through /media (see below).
try { ensureGenDir(); } catch { /* read-only FS (e.g. Vercel) */ }

// Only Dola's own media hosts may be proxied through /media (prevents this being an open relay).
const MEDIA_HOST_ALLOW = /(^|\.)(ibyteimg\.com|bytevcloudapi\.com|byteimg\.com|ciciai\.com|dola\.com)$/i;

// For each generated media item, build a STABLE, browser-openable link:
//   - a streaming proxy URL (/media?src=…) that re-fetches Dola's signed URL on demand. This is
//     stateless, so it works on Vercel (read-only FS) as well as locally.
//   - also save a local copy into generated_content/ when the filesystem is writable (best-effort).
async function saveAllMedia(mediaUrls) {
  const out = [];
  for (const m of mediaUrls) {
    const proxyUrl = `${PUBLIC_BASE}/media?src=${encodeURIComponent(Buffer.from(m.url).toString('base64url'))}`;
    let localFile;
    try { localFile = (await downloadMedia(m.url, m.kind)).name; } catch { /* read-only FS or download blip */ }
    out.push({ url: proxyUrl, kind: m.kind, source_url: m.url, ...(localFile ? { local: `/generated_content/${localFile}` } : {}) });
  }
  return out;
}

// Stream a Dola media URL through this server (stable link, works on read-only serverless FS).
async function proxyMedia(res, src) {
  let url;
  try { url = Buffer.from(decodeURIComponent(src), 'base64url').toString('utf8'); } catch { return json(res, 400, { error: { message: 'bad src' } }); }
  let host;
  try { host = new URL(url).host; } catch { return json(res, 400, { error: { message: 'bad url' } }); }
  if (!MEDIA_HOST_ALLOW.test(host)) return json(res, 403, { error: { message: 'host not allowed' } });
  const r = await fetch(url);
  if (!r.ok) return json(res, 502, { error: { message: `upstream ${r.status}` } });
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=31536000' });
  const buf = Buffer.from(await r.arrayBuffer());
  res.end(buf);
}

// Serve a file from generated_content (basic, read-only, no traversal).
function serveGenerated(res, name) {
  const safe = path.basename(name);
  const file = path.join(GEN_DIR, safe);
  if (!file.startsWith(GEN_DIR) || !fs.existsSync(file)) return json(res, 404, { error: { message: 'not found' } });
  const ext = path.extname(file).slice(1).toLowerCase();
  const ct = Object.entries(EXT_BY_CT).find(([, e]) => e === (ext === 'jpg' ? 'jpg' : ext))?.[0] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=31536000' });
  fs.createReadStream(file).pipe(res);
}

const MODELS = {
  'dola-fast': { deepThink: 0, label: 'Dola Fast' },
  'dola-pro': { deepThink: 3, label: 'Dola Pro (advanced)' },
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Flatten OpenAI-style messages into a single prompt string.
// Dola keeps conversation state server-side (per conversation_id), but we still
// forward the full turn so the proxy works with stateless OpenAI clients.
function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('')
        : '';
    if (!content) continue;
    if (m.role === 'system') parts.push(`[system]\n${content}`);
    else if (m.role === 'assistant') parts.push(`[assistant]\n${content}`);
    else parts.push(content);
  }
  return parts.join('\n\n');
}

// Extract images from OpenAI-style messages and upload them to Dola. Supports the vision format
// where a message's content is an array of parts; image parts look like
// { type: "image_url", image_url: { url: "data:image/png;base64,..." | "https://..." } }.
// Returns [{ uri, name, width, height }] ready for streamCompletion({ images }).
async function extractAndUploadImages(messages) {
  const images = [];
  if (!Array.isArray(messages)) return images;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const url = part?.type === 'image_url' ? (part.image_url?.url || part.image_url) : (part?.type === 'input_image' ? part.image_url : null);
      if (typeof url !== 'string') continue;
      let buf, name = 'image.png';
      const dataMatch = url.match(/^data:(image\/\w+);base64,(.*)$/);
      if (dataMatch) {
        buf = Buffer.from(dataMatch[2], 'base64');
        name = 'image.' + dataMatch[1].split('/')[1].replace('jpeg', 'jpg');
      } else if (/^https?:\/\//.test(url)) {
        const r = await fetch(url);
        buf = Buffer.from(await r.arrayBuffer());
        name = (url.split('?')[0].split('/').pop() || 'image.png');
      } else {
        continue;
      }
      images.push(await uploadImage(COOKIE, buf, name));
    }
  }
  return images;
}

function requireConfig(res) {
  if (!COOKIE) { json(res, 500, { error: { message: 'DOLA_COOKIE is not set', type: 'config_error' } }); return false; }
  return true;
}

// Best-effort cleanup of the throwaway conversation created for a request.
// Only runs when DOLA_DELETE_AFTER is enabled; failures are swallowed (see deleteConversation).
async function maybeDelete(conversationId) {
  if (!DELETE_AFTER || !conversationId) return;
  const r = await deleteConversation({ cookie: COOKIE, conversationId });
  if (!r.ok) console.warn(`[delete] conversation ${conversationId} not deleted: ${r.statusDesc || r.statusCode}`);
}

async function handleChat(req, res) {
  if (!requireConfig(res)) return;
  const payload = await readJsonBody(req);
  let modelKey = (payload.model || 'dola-fast').toLowerCase();
  // Pro is gated: fall back to Fast unless ENABLE_PRO is set.
  if (modelKey === 'dola-pro' && !ENABLE_PRO) modelKey = 'dola-fast';
  const model = MODELS[modelKey] || MODELS['dola-fast'];
  const prompt = messagesToPrompt(payload.messages);

  // Vision: pull any images out of the OpenAI-style messages and upload them to Dola.
  // Gated by ENABLE_VISION — otherwise images are ignored (text still answered).
  let images = [];
  if (ENABLE_VISION) {
    try { images = await extractAndUploadImages(payload.messages); }
    catch (e) { return json(res, 502, { error: { message: 'image upload failed: ' + e.message, type: 'upstream_error' } }); }
  }

  if (!prompt && !images.length) return json(res, 400, { error: { message: 'no messages/content', type: 'invalid_request_error' } });

  const stream = payload.stream === true;
  const id = 'chatcmpl-' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const sendChunk = (delta, finish = null) => {
      const chunk = {
        id, object: 'chat.completion.chunk', created, model: modelKey,
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    sendChunk({ role: 'assistant' });
    try {
      const out = await streamCompletion({
        cookie: COOKIE, botId: BOT_ID,
        text: prompt, deepThink: model.deepThink, images,
        onDelta: (t) => sendChunk({ content: t }),
      });
      sendChunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      await maybeDelete(out.conversationId);
    } catch (e) {
      sendChunk({ content: `\n[proxy error: ${e.message}]` }, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  try {
    const out = await streamCompletion({
      cookie: COOKIE, botId: BOT_ID,
      text: prompt, deepThink: model.deepThink, images,
    });
    json(res, 200, {
      id, object: 'chat.completion', created, model: modelKey,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: out.text,
          ...(out.thinking ? { reasoning_content: out.thinking } : {}),
        },
        finish_reason: 'stop',
      }],
      usage: {},
    });
    await maybeDelete(out.conversationId);
  } catch (e) {
    json(res, 502, { error: { message: e.message, type: 'upstream_error', dola: e.dola } });
  }
}

async function handleImage(req, res) {
  if (!ENABLE_IMAGE) return json(res, 403, { error: { message: 'Image generation is disabled on this deployment.', type: 'feature_disabled' } });
  if (!requireConfig(res)) return;
  const payload = await readJsonBody(req);
  const prompt = payload.prompt;
  if (!prompt) return json(res, 400, { error: { message: 'prompt required', type: 'invalid_request_error' } });
  try {
    const out = await streamCompletion({
      cookie: COOKIE, botId: BOT_ID,
      text: prompt, deepThink: 0, chatAbility: CHAT_ABILITY.image,
    });
    // Images arrive in-stream (block_type 2074). Return stable proxy links (streamed via /media,
    // Vercel-safe) instead of Dola's hotlink-protected signed URLs.
    const saved = await saveAllMedia(out.mediaUrls);
    json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: saved,
      note: saved.length ? undefined : 'No image URLs returned by Dola for this prompt.',
      message: out.text || undefined,
    });
    await maybeDelete(out.conversationId);
  } catch (e) {
    json(res, 502, { error: { message: e.message, type: 'upstream_error', dola: e.dola } });
  }
}

async function handleVideo(req, res) {
  if (!ENABLE_VIDEO) return json(res, 403, { error: { message: 'Video generation is disabled on this deployment.', type: 'feature_disabled' } });
  const payload = await readJsonBody(req);

  // Enforce project rule first, independent of config: only Dreamina Seedance 1.0
  // is allowed. Refuse "2.0 fast".
  const requested = (payload.model || '1.0').toString().toLowerCase();
  if (requested.includes('2.0') || requested.includes('fast') || requested.includes('2')) {
    return json(res, 400, {
      error: {
        message: 'This proxy only supports Dreamina Seedance 1.0 for video. "2.0 Fast" is not enabled.',
        type: 'invalid_request_error',
      },
    });
  }

  if (!requireConfig(res)) return;
  const prompt = payload.prompt;
  if (!prompt) return json(res, 400, { error: { message: 'prompt required', type: 'invalid_request_error' } });
  const duration = Number(payload.duration || 10);
  try {
    const out = await streamCompletion({
      cookie: COOKIE, botId: BOT_ID,
      text: prompt, deepThink: 0, chatAbility: CHAT_ABILITY.video1(duration),
    });
    const saved = await saveAllMedia(out.mediaUrls.filter((m) => m.kind === 'video' || /\.mp4/i.test(m.url)));
    json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      model: 'dreamina-seedance-1.0',
      data: saved,
      note: saved.length ? undefined
        : 'No video URL in the initial stream — Dola renders video asynchronously (~1-3 min, costs points). Re-request or poll; the finished clip is not yet available.',
      message: out.text || undefined,
    });
    await maybeDelete(out.conversationId);
  } catch (e) {
    json(res, 502, { error: { message: e.message, type: 'upstream_error', dola: e.dola } });
  }
}

function listModels() {
  const models = [{ id: 'dola-fast', object: 'model', owned_by: 'dola', label: MODELS['dola-fast'].label }];
  if (ENABLE_PRO) models.push({ id: 'dola-pro', object: 'model', owned_by: 'dola', label: MODELS['dola-pro'].label });
  if (ENABLE_IMAGE) models.push({ id: 'dola-image', object: 'model', owned_by: 'dola', label: 'Dola Image' });
  if (ENABLE_VIDEO) models.push({ id: 'dreamina-seedance-1.0', object: 'model', owned_by: 'dola', label: 'Dola Video 1.0' });
  return models;
}

// The single request handler — used both by the local http server and the Vercel function.
export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, {
        ok: true, configured: Boolean(COOKIE),
        features: { pro: ENABLE_PRO, vision: ENABLE_VISION, image: ENABLE_IMAGE, video: ENABLE_VIDEO },
      });
    }
    if (req.method === 'GET' && url.pathname === '/media') {
      const src = url.searchParams.get('src');
      if (!src) return json(res, 400, { error: { message: 'src required' } });
      return await proxyMedia(res, src);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/generated_content/')) {
      return serveGenerated(res, url.pathname.slice('/generated_content/'.length));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: listModels() });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChat(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/images/generations') return await handleImage(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/videos/generations') return await handleVideo(req, res);
    json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
  }
}

export default handleRequest;

// Start a local HTTP server only when run directly (not when imported by the Vercel function).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  http.createServer(handleRequest).listen(PORT, () => {
    const on = (b) => (b ? 'on' : 'off');
    console.log(`dolaproxy listening on http://localhost:${PORT}`);
    console.log(`  cookie=${COOKIE ? 'yes' : 'NO'}  features: pro=${on(ENABLE_PRO)} vision=${on(ENABLE_VISION)} image=${on(ENABLE_IMAGE)} video=${on(ENABLE_VIDEO)}`);
    console.log('  POST /v1/chat/completions  (model: dola-fast' + (ENABLE_PRO ? ' | dola-pro' : '') + ')');
    if (ENABLE_IMAGE) console.log('  POST /v1/images/generations');
    if (ENABLE_VIDEO) console.log('  POST /v1/videos/generations  (Seedance 1.0 only)');
  });
}
