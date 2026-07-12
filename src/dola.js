// Low-level client for dola.com's private /chat/completion endpoint.
//
// Reverse-engineered facts (see README):
//   - Endpoint:  POST https://www.dola.com/chat/completion?<static query params>
//   - Auth:      session cookies only. NO a_bogus / msToken signing required.
//   - Headers:   content-type: application/json, Agw-Js-Conv: str
//   - Model:     option.need_deep_think = 0 (Fast) | 3 (Pro); ext.use_deep_think mirrors it as a string.
//   - Image gen: chat_ability = { ability_type: 3, ability_param: '{"ability_param":{},"ability_type":1}' }
//   - Video gen: chat_ability = { ability_type: 17, ability_param: '{"model":"ic_mini","duration":10}' }
//                model "ic_mini" == "Dreamina Seedance 1.0". (2.0 Fast is a different model — intentionally NOT used.)
//   - Response:  SSE. Text deltas arrive in STREAM_MSG_NOTIFY events; block_type 10000 = answer text
//                (patch_type 1 = append), block_type 10040 = reasoning/thinking (Pro). SSE_REPLY_END ends the turn.

import { randomUUID, createHash, createHmac } from 'node:crypto';

const BASE_QUERY =
  '?aid=495671&device_platform=web&language=en&region=AU&samantha_web=1' +
  '&sys_region=AU&use-olympus-account=1&version_code=20800&web_platform=browser';
const COMPLETION_URL = 'https://www.dola.com/chat/completion' + BASE_QUERY;
const DELETE_URL = 'https://www.dola.com/im/conversation/batch_del_user_conv' + BASE_QUERY;

// The Dola/Doubao default assistant bot. Override via DOLA_BOT_ID if needed.
export const DEFAULT_BOT_ID = '7339470689562525703';

// Video model that maps to "Dreamina Seedance 1.0". This proxy deliberately
// only supports 1.0; "2.0 Fast" is refused per project requirement.
export const VIDEO_MODEL_1_0 = 'ic_mini';

// A text message (content block 10000).
function textMessage(text) {
  return {
    local_message_id: randomUUID(),
    content_block: [
      {
        block_type: 10000,
        content: { text_block: { text, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
        block_id: randomUUID(), parent_id: '', meta_info: [], append_fields: [],
      },
    ],
    message_status: 0,
  };
}

// An image-attachment message (content block 10052). `images` is [{ uri, name, width, height }],
// where uri is an ImageX StoreUri returned by uploadImage().
function attachmentMessage(images) {
  return {
    local_message_id: randomUUID(),
    content_block: [
      {
        block_type: 10052,
        content: {
          attachment_block: {
            attachments: images.map((img) => ({
              type: 1,
              identifier: randomUUID(),
              image: {
                name: img.name || 'image.png',
                uri: img.uri,
                image_ori: { url: '', width: img.width || 0, height: img.height || 0, format: '', url_formats: {} },
              },
              parse_state: 0, review_state: 1, upload_status: 1, progress: 100, src: '',
            })),
          },
          pc_event_block: '',
        },
        block_id: randomUUID(), parent_id: '', meta_info: [], append_fields: [],
      },
    ],
    message_status: 0,
  };
}

// Build the full request body. `text` is the user prompt. `deepThink` is 0 (Fast) or 3 (Pro).
// `chatAbility` is an optional { ability_type, ability_param } object for image/video generation.
// `images` (optional) is an array of uploaded images ({ uri, name, width, height }); when present
// they are sent as a separate attachment message before the text (Dola's vision format).
//
// If `conversationId` is falsy, the body is built in "create" mode: Dola spins up a brand-new
// conversation for this request (need_create_conversation:true, empty conversation_id + a fresh
// local_conversation_id). The new id comes back in the SSE_ACK event. This is how the proxy
// behaves like a stateless API — every call is its own throwaway chat.
function buildBody({ conversationId, botId, text, deepThink, chatAbility, images, lastSectionId, lastMessageIndex }) {
  const create = !conversationId;
  const messages = [];
  if (images && images.length) messages.push(attachmentMessage(images));
  if (text || !messages.length) messages.push(textMessage(text || ''));
  const body = {
    client_meta: create
      ? {
          local_conversation_id: 'local_' + Date.now() + Math.floor(Math.random() * 1e6),
          conversation_id: '',
          bot_id: botId,
          last_section_id: '',
          last_message_index: null,
        }
      : {
          conversation_id: conversationId,
          bot_id: botId,
          ...(lastSectionId ? { last_section_id: lastSectionId } : {}),
          ...(Number.isInteger(lastMessageIndex) ? { last_message_index: lastMessageIndex } : {}),
        },
    messages,
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: deepThink,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: create,
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false,
      is_old_user: false,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
    },
    ...(chatAbility ? { chat_ability: chatAbility } : {}),
    user_context: [],
    ext: {
      use_deep_think: String(deepThink),
      fp: '',
      collection_id: '',
      commerce_credit_config_enable: '0',
    },
  };
  return body;
}

// Parse a raw SSE text buffer into discrete { id, event, data } records.
// Dola frames events as: `id: N\nevent: NAME\ndata: {...}` separated by blank lines.
function parseSseFrames(buffer) {
  const frames = [];
  for (const raw of buffer.split('\n\n')) {
    const block = raw.trim();
    if (!block) continue;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    let parsed = null;
    if (data) { try { parsed = JSON.parse(data); } catch { /* keep raw */ } }
    frames.push({ event, data: parsed, raw: data });
  }
  return frames;
}

// Deep-scan an object for the first http(s) URL under a key matching /pattern/, ignoring icons.
function findUrl(obj, pattern) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/icon/i.test(k)) continue;
    if (typeof v === 'string' && /^https?:\/\//.test(v) && pattern.test(k)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const u = findUrl(v, pattern); if (u) return u; }
  }
  return null;
}

// Collect finished media (image/video) from a content_block array.
//   - block_type 2074 `creation_block.creations[]` carries generated images/videos: for each
//     creation we take the original image URL (or the video URL).
//   - other blocks are scanned generically for a media URL (skipping text/thinking/icon fields).
function collectMedia(blocks, arr) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    const c = b?.content || {};
    if (c.creation_block?.creations) {
      for (const cr of c.creation_block.creations) {
        if (cr.video) {
          const url = findUrl(cr.video, /url|play|video|mp4/i);
          if (url) arr.push({ kind: 'video', field: 'creation', url });
        } else if (cr.image) {
          const url = cr.image.image_ori?.url || findUrl(cr.image, /url/i);
          if (url) arr.push({ kind: 'image', field: 'creation', url });
        }
      }
      continue;
    }
    for (const [k, v] of Object.entries(c)) {
      if (k === 'text_block' || k === 'thinking_block' || k === 'pc_event_block' || k === 'loading_block') continue;
      if (k.endsWith('_block') && v && typeof v === 'object') {
        for (const [vk, vv] of Object.entries(v)) {
          if (/icon/i.test(vk)) continue;
          if (typeof vv === 'string' && /^https?:\/\//.test(vv) && /(url|video|image|img|cover)/i.test(vk)) {
            arr.push({ kind: k.replace('_block', ''), field: vk, url: vv });
          }
        }
      }
    }
  }
}

// True if a text_block belongs to the Pro "deep think" reasoning stream (tagged with the
// Deep_Think tool icon) rather than the final answer.
function isThinkingBlock(textBlock) {
  return /Deep_Think/i.test(textBlock?.icon_url || '') || /Deep_Think/i.test(textBlock?.icon_url_dark || '');
}

/**
 * Stream a completion. Calls `onDelta(text)` for each answer-text chunk and
 * `onThinking(text)` for reasoning chunks (Pro). Resolves with the aggregated result.
 *
 * @param {object} opts
 * @param {string} opts.cookie        Full Cookie header value from an authenticated dola.com session.
 * @param {string} [opts.conversationId]  Existing Dola conversation id. Omit to create a fresh
 *                                        throwaway conversation for this request (stateless mode).
 * @param {string} [opts.botId]       Bot id (defaults to the Dola assistant).
 * @param {string} opts.text          The user prompt.
 * @param {number} [opts.deepThink]   0 = Fast, 3 = Pro.
 * @param {object} [opts.chatAbility] Optional media ability descriptor.
 * @param {(t:string)=>void} [opts.onDelta]
 * @param {(t:string)=>void} [opts.onThinking]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text,thinking,mediaUrls,conversationId,messageId,error}>}
 *          Resolves only after the assistant has finished (stream closed).
 */
export async function streamCompletion(opts) {
  const {
    cookie, conversationId, botId = DEFAULT_BOT_ID, text,
    deepThink = 0, chatAbility, images, onDelta, onThinking, signal,
    lastSectionId, lastMessageIndex,
  } = opts;

  if (!cookie) throw new Error('Missing Dola cookie');
  if (!text && !(images && images.length)) throw new Error('Missing text');

  const body = buildBody({ conversationId, botId, text, deepThink, chatAbility, images, lastSectionId, lastMessageIndex });

  const resp = await fetch(COMPLETION_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Agw-Js-Conv': 'str',
      cookie,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Dola HTTP ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const out = { text: '', thinking: '', mediaUrls: [], error: null, conversationId, messageId: null };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleFrames = (frames) => {
    for (const f of frames) {
      if (f.event === 'STREAM_ERROR') {
        out.error = f.data || { error_msg: 'stream error' };
        continue;
      }
      if (f.event === 'SSE_ACK' && f.data?.ack_client_meta) {
        out.conversationId = f.data.ack_client_meta.conversation_id || out.conversationId;
      }
      // Answer text arrives on one of two channels depending on the model, and the two do NOT
      // overlap, so we parse both:
      //   - Fast: text_block deltas inside STREAM_MSG_NOTIFY (its STREAM_CHUNK text is empty).
      //   - Pro:  text_block deltas inside STREAM_CHUNK patch_ops (its STREAM_MSG_NOTIFY is just
      //           the thinking header). Pro reasoning tokens are tagged with the Deep_Think icon.
      const applyTextBlock = (tb) => {
        if (!tb || tb.text == null || tb.text === '') return;
        if (isThinkingBlock(tb)) { out.thinking += tb.text; onThinking?.(tb.text); }
        else { out.text += tb.text; onDelta?.(tb.text); }
      };
      if (f.event === 'STREAM_MSG_NOTIFY' && f.data) {
        for (const cb of f.data.content?.content_block || []) {
          applyTextBlock(cb.content?.text_block);
          collectMedia([cb], out.mediaUrls);
        }
      }
      if (f.event === 'STREAM_CHUNK' && f.data) {
        for (const op of f.data.patch_op || []) {
          for (const cb of op.patch_value?.content_block || []) {
            applyTextBlock(cb.content?.text_block);
            collectMedia([cb], out.mediaUrls);
          }
        }
        if (f.data.message_id) out.messageId = f.data.message_id;
      }
      // FULL_MSG_NOTIFY echoes whole messages — including the user's own prompt — so we do NOT
      // treat its text as answer content. We only mine it for finished media URLs (image/video).
      if (f.event === 'FULL_MSG_NOTIFY' && f.data && f.data.message?.user_type !== 1) {
        const blocks = f.data.content?.content_block || parseFullMsgBlocks(f.data);
        collectMedia(blocks, out.mediaUrls);
        if (f.data.message?.message_id) out.messageId = f.data.message.message_id;
      }
    }
  };

  // Read the SSE stream frame-by-frame.
  // We split on the blank-line frame boundary so partial frames stay buffered.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lastBoundary = buffer.lastIndexOf('\n\n');
    if (lastBoundary === -1) continue;
    const ready = buffer.slice(0, lastBoundary);
    buffer = buffer.slice(lastBoundary + 2);
    handleFrames(parseSseFrames(ready));
  }
  if (buffer.trim()) handleFrames(parseSseFrames(buffer));

  if (out.error) {
    const e = new Error(`Dola stream error: ${out.error.error_msg || 'unknown'} (${out.error.error_code || ''})`);
    e.dola = out.error;
    throw e;
  }
  // Media blocks stream repeatedly as they update — de-dupe by URL (ignoring signature params).
  const seen = new Set();
  out.mediaUrls = out.mediaUrls.filter((m) => {
    const key = m.url.split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out;
}

// FULL_MSG_NOTIFY carries the echoed/full message with `content` as a JSON string of blocks.
function parseFullMsgBlocks(data) {
  const raw = data?.message?.content;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

/**
 * Best-effort delete of a conversation via Dola's frontier IM endpoint.
 *
 * ⚠️ Known limitation: this endpoint (`/im/conversation/batch_del_user_conv`, cmd 4171) is
 * served by ByteDance's Agw "frontier" gateway, which requires the browser's webmssdk to
 * encode/sign the request (the `Agw-Js-Conv` transform). A plain cookie-authenticated POST —
 * from a server OR even from inside the authenticated browser — is rejected with
 * status_code 712012002 "不支持编码类型" (unsupported encoding type); the gateway never
 * decodes the body. So this call will typically NOT succeed from a standalone proxy.
 *
 * The good news: conversations created via the API (streamCompletion in create mode) do NOT
 * appear in the dola.com chat-history sidebar, so they don't clutter the UI even without
 * deletion. The messages still persist server-side. Deletion is therefore best-effort only.
 *
 * Returns { ok, statusCode, statusDesc }. Never throws.
 */
export async function deleteConversation({ cookie, conversationId }) {
  if (!cookie || !conversationId) return { ok: false, statusDesc: 'missing cookie/conversationId' };
  try {
    const resp = await fetch(DELETE_URL, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json; charset=utf-8', 'Agw-Js-Conv': 'str' },
      body: JSON.stringify({
        cmd: 4171,
        uplink_body: {
          batch_delete_user_conversation_uplink_body: {
            conversation_id: [conversationId],
            delete_all: false,
            conversation_type: 3,
          },
        },
        sequence_id: randomUUID(),
        channel: 2,
        version: '1',
      }),
    });
    const j = await resp.json().catch(() => ({}));
    const ok = j.status_code === 0 && JSON.stringify(j.downlink_body || {}).includes('true');
    return { ok, statusCode: j.status_code, statusDesc: j.status_desc };
  } catch (e) {
    return { ok: false, statusDesc: e.message };
  }
}

// ---------------------------------------------------------------------------
// Image upload (vision input) via ByteDance ImageX.
//
// Flow (all authenticated by the session cookie + short-lived STS creds):
//   1. POST /alice/resource/prepare_upload  -> service_id, upload_host, STS creds
//   2. ApplyImageUpload (Volcengine AWS-SigV4 GET) -> StoreUri, upload node, SessionKey, Auth
//   3. POST bytes to https://<node>/upload/v1/<StoreUri>  (Auth + Content-CRC32)
//   4. CommitImageUpload (SigV4 POST { SessionKey }) -> confirmed Uri
// The returned Uri is what streamCompletion({ images }) references.
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32hex(buf) {
  let c = ~0;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return ((~c) >>> 0).toString(16).padStart(8, '0');
}
const sha256hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (key, d) => createHmac('sha256', key).update(d).digest();

// Volcengine ImageX signs in AWS-SigV4-compatible mode (x-amz-* headers, region us-east-1).
function signV4({ ak, sk, token, method, host, query = {}, region = 'us-east-1', service = 'imagex', body = '' }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
  const headers = { host, 'x-amz-date': amzDate, 'x-amz-security-token': token };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => k + ':' + headers[k] + '\n').join('');
  const canonicalRequest = [method, '/', canonicalQuery, canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + sk, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalQuery,
  };
}

/**
 * Upload an image and return its ImageX StoreUri (usable in streamCompletion({ images })).
 * @param {string} cookie  Dola session cookie.
 * @param {Buffer|Uint8Array} buf  Raw image bytes.
 * @param {string} [name]  Filename (its extension is used).
 * @param {number} [width] @param {number} [height]  Optional dimensions.
 */
export async function uploadImage(cookie, buf, name = 'image.png', width = 0, height = 0) {
  const ext = '.' + (name.split('.').pop() || 'png');
  const prep = await fetch('https://www.dola.com/alice/resource/prepare_upload' + BASE_QUERY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Agw-Js-Conv': 'str', cookie },
    body: JSON.stringify({ tenant_id: '5', scene_id: '4', resource_type: 2 }),
  }).then((r) => r.json());
  if (prep.code !== 0) throw new Error('prepare_upload failed: ' + JSON.stringify(prep).slice(0, 150));
  const { service_id, upload_host } = prep.data;
  const { access_key: ak, secret_key: sk, session_token: token } = prep.data.upload_auth_token;

  const applyQuery = { Action: 'ApplyImageUpload', Version: '2018-08-01', ServiceId: service_id, FileSize: String(buf.length), FileExtension: ext, s: Math.random().toString(36).slice(2, 13) };
  const sig = signV4({ ak, sk, token, method: 'GET', host: upload_host, query: applyQuery });
  const apply = await fetch(`https://${upload_host}/?${sig.canonicalQuery}`, {
    headers: { 'X-Amz-Date': sig.amzDate, 'x-amz-security-token': token, Authorization: sig.authorization },
  }).then((r) => r.json());
  const addr = apply.Result?.UploadAddress;
  if (!addr) throw new Error('ApplyImageUpload failed: ' + JSON.stringify(apply).slice(0, 150));
  const store = addr.StoreInfos[0];

  const put = await fetch(`https://${addr.UploadHosts[0]}/upload/v1/${store.StoreUri}`, {
    method: 'POST',
    headers: { Authorization: store.Auth, 'Content-CRC32': crc32hex(buf), 'Content-Type': 'application/octet-stream' },
    body: buf,
  }).then((r) => r.json());
  if (put.code !== 2000) throw new Error('image byte upload failed: ' + JSON.stringify(put).slice(0, 150));

  const commitBody = JSON.stringify({ SessionKey: addr.SessionKey });
  const cq = { Action: 'CommitImageUpload', Version: '2018-08-01', ServiceId: service_id };
  const csig = signV4({ ak, sk, token, method: 'POST', host: upload_host, query: cq, body: commitBody });
  const commit = await fetch(`https://${upload_host}/?${csig.canonicalQuery}`, {
    method: 'POST',
    headers: { 'X-Amz-Date': csig.amzDate, 'x-amz-security-token': token, Authorization: csig.authorization, 'Content-Type': 'application/json' },
    body: commitBody,
  }).then((r) => r.json());
  const result = commit.Result?.Results?.[0];
  if (result?.UriStatus !== 2000) throw new Error('CommitImageUpload failed: ' + JSON.stringify(commit).slice(0, 150));
  return { uri: result.Uri, name, width, height };
}

export const CHAT_ABILITY = {
  image: { ability_type: 3, ability_param: JSON.stringify({ ability_param: {}, ability_type: 1 }) },
  // Video 1.0 (Dreamina Seedance 1.0). duration in seconds (UI default 10).
  video1: (duration = 10) => ({ ability_type: 17, ability_param: JSON.stringify({ model: VIDEO_MODEL_1_0, duration }) }),
};
