# dolaproxy

An OpenAI-compatible HTTP proxy for **dola.com** — exposing Dola's **Fast** and **Pro**
chat models, **vision** (send images to the model), and **image** / **video (1.0)** generation,
behind a familiar `/v1/chat/completions` style API. Generated media is downloaded into a local
`generated_content/` folder and served back through the proxy as stable links.

> Dola is a ByteDance product. Under the hood it is **Doubao / Cici** — the same
> infrastructure (`ciciai.com`, `bytedance`), and answer frames self-identify as
> `agent_name: "Doubao"`.

## How Dola works (reverse-engineered)

All chat, image, and video requests go through a single streaming endpoint:

```
POST https://www.dola.com/chat/completion?aid=495671&device_platform=web&language=en&region=AU&...
```

| Aspect | Finding |
| --- | --- |
| **Auth** | Session **cookies only**. The `a_bogus` / `msToken` anti-bot query params in the browser are **not required** — a request with valid cookies and no signature is accepted (HTTP 200). |
| **Required headers** | `content-type: application/json`, `Agw-Js-Conv: str`, `cookie: <session>` |
| **Auth cookies** | `oauth_token`, `oauth_token_v2`, `flow_cur_user_sec_id`, `passport_csrf_token` |
| **Conversation** | A request either targets an existing `conversation_id` or **creates a fresh one**: send `client_meta.conversation_id: ""` + a `local_conversation_id` + `option.need_create_conversation: true`. The new id comes back in `SSE_ACK.ack_client_meta.conversation_id`. |
| **Response** | Server-Sent Events. Sequence: `SSE_HEARTBEAT → SSE_ACK → FULL_MSG_NOTIFY → STREAM_MSG_NOTIFY* → STREAM_CHUNK → SSE_REPLY_END`. |

### Stateless behaviour (fresh chat per request)

This proxy runs **stateless**: every API call creates a brand-new Dola conversation, sends
the message, waits for the assistant to finish, and returns the result — just like a normal
API, with no shared history between calls. Two things make this clean:

- **API-created conversations do NOT appear in the dola.com chat-history sidebar.** Verified by
  creating several via the API and reloading — only real UI chats show. So throwaway chats
  don't clutter your account, while their messages still persist server-side (user/assistant rows).
- **No conversation id to configure.** You only need your session cookie.

#### About auto-delete

Deleting the throwaway conversation would be the tidy finish, but Dola's delete endpoint
(`POST /im/conversation/batch_del_user_conv`, cmd `4171`) is served by ByteDance's Agw
**"frontier" gateway**, which requires the browser's **webmssdk** to encode/sign the request
(the `Agw-Js-Conv` transform). A plain cookie-authenticated POST — from a server, *or even
replayed byte-for-byte from inside the authenticated browser* — is rejected with
`status_code 712012002` "不支持编码类型" (unsupported encoding type); the gateway never even
decodes the body (`cmd` comes back `0`). So programmatic delete isn't reliably reproducible
outside the real web app.

Because API chats don't show in history anyway, delete is unnecessary in practice. A
best-effort attempt is available behind `DOLA_DELETE_AFTER=1` (off by default, failures are
logged and ignored).

### Fast vs Pro

Model selection is **not** a model name — it's a "deep think" flag:

| Model | `option.need_deep_think` | `ext.use_deep_think` |
| --- | --- | --- |
| **Fast** ("solves most problems") | `0` | `"0"` |
| **Pro** ("advanced Pro model") | `3` | `"3"` |

Pro streams an extra reasoning block (`block_type: 10040`, a `thinking_block`) before the answer.
Answer text streams in `STREAM_MSG_NOTIFY` frames as `content.content_block[]` where
`block_type == 10000` and `content.text_block.text` is the incremental piece (`patch_type: 1` = append).

### Vision — sending images to the model

Images are uploaded via ByteDance **ImageX** and then referenced in the completion:

1. `POST /alice/resource/prepare_upload` `{tenant_id:"5",scene_id:"4",resource_type:2}` → short-lived
   Volcengine STS creds + `service_id` + upload host.
2. **ApplyImageUpload** — AWS-SigV4-signed GET (`x-amz-*` headers, service `imagex`, region `us-east-1`)
   → `StoreUri` + upload node + `SessionKey` + store `Auth`.
3. `POST https://<node>/upload/v1/<StoreUri>` with `Authorization: <Auth>` + `Content-CRC32` + raw bytes.
4. **CommitImageUpload** — SigV4 POST `{SessionKey}` → confirmed `Uri`.

The image is then sent as its own message (before the text) with an `attachment_block` (block_type
**10052**) referencing that `Uri`:

```json
{ "block_type": 10052, "content": { "attachment_block": { "attachments": [
  { "type": 1, "identifier": "<uuid>", "image": { "name": "x.png", "uri": "tos-mya-i-.../x.png",
    "image_ori": { "url": "", "width": 64, "height": 64 } }, "upload_status": 1, "progress": 100 } ] } } }
```

All of this works from Node with just the cookie (SigV4 reimplemented in `src/dola.js`).

### Image generation (free)

Add a `chat_ability` to the same completion body:

```json
"chat_ability": { "ability_type": 3, "ability_param": "{\"ability_param\":{},\"ability_type\":1}" }
```

Produces **4 images**, **in-stream** as block_type **2074** `creation_block.creations[].image.image_ori.url`.
Did **not** consume points in testing. Ratio/Style options populate the inner `ability_param`.

### Video generation (costs points)

```json
"chat_ability": { "ability_type": 17, "ability_param": "{\"model\":\"ic_mini\",\"duration\":10}" }
```

| Video model (UI) | `model` string | Notes |
| --- | --- | --- |
| **Dreamina Seedance 1.0** | **`ic_mini`** | ✅ used by this proxy — "good for simple videos" |
| Dreamina Seedance 2.0 Fast | *(other)* | ❌ **not enabled** — the proxy refuses it by design |

Video costs **2 points** per clip and completes **asynchronously** (~1–3 min). The initial stream
only returns a "Generating video…" acknowledgement — the finished clip is **not** in the stream.

⚠️ **Retrieving the finished video isn't possible from a standalone proxy.** Conversations sync
their messages (including the finished-video notification) via `POST /im/chain/single`, a ByteDance
**frontier IM** endpoint that needs the browser's webmssdk signing — the same wall as delete
(`712012002 "unsupported encoding type"`). So `/v1/videos/generations` submits the render and
returns a "processing" note; it can't hand back the final MP4. Image generation is unaffected
(it streams in-band).

## Setup

```bash
cp .env.example .env
# edit .env: paste your DOLA_COOKIE (that's the only required value)
npm start
```

- **`DOLA_COOKIE`** — In browser devtools → Network, open any `www.dola.com` request and
  copy the entire `cookie:` request header. No conversation id is needed (stateless).

> Cookies expire; refresh `DOLA_COOKIE` when you start getting auth errors. Never commit `.env`.

### Feature flags

Everything is **on by default except video generation**. Toggle via env vars:

| flag | default | effect |
| --- | --- | --- |
| `ENABLE_PRO` | on | `dola-pro` model |
| `ENABLE_VISION` | on | send images to the model |
| `ENABLE_IMAGE` | on | `/v1/images/generations` |
| `ENABLE_VIDEO` | **off** | `/v1/videos/generations` (can't return finished clips; costs points) |

## Deploy to Vercel (hosted API)

The proxy runs as a single Vercel Function (`api/index.js`; all routes rewritten to it via
`vercel.json`). Your `DOLA_COOKIE` lives as an **environment variable** — every visitor to your
deployed API uses it, but it's never in the repo.

```bash
npm i -g vercel        # if needed
vercel                 # link + deploy a preview
vercel env add DOLA_COOKIE production   # paste your cookie when prompted
vercel --prod          # deploy to production
```

Or via the dashboard: import the GitHub repo → add `DOLA_COOKIE` under Settings → Environment
Variables → deploy.

Notes:
- **Never hard-code the cookie in the source** — it grants full access to your Dola account and
  would live in git history forever. The env var gives the exact same "everyone uses my cookie"
  behaviour without the leak.
- Generated images are served through a stateless streaming proxy (`/media?src=…`), so image
  generation works on Vercel's read-only filesystem. (The local `generated_content/` folder is a
  best-effort convenience when running on your own machine.)
- Video is off by default (and can't return clips anyway). Leave `ENABLE_VIDEO` unset.

## Interactive chat (`chat.js`)

A terminal REPL for chatting directly with Dola — streams replies live, keeps context for the
whole session, and lets you switch models on the fly.

```bash
npm run chat            # start in Fast
node chat.js pro        # start in Pro
node chat.js --model pro
```

In-chat commands:

| command | what it does |
| --- | --- |
| `/model` | show current model + options |
| `/model fast` / `/model pro` | switch model (keeps the conversation) |
| **Ctrl-V** or `/paste` | **attach an image from the clipboard** (vision) |
| `/new` | start a fresh conversation (clears context) |
| `/help` | list commands |
| `/exit` (or Ctrl-C / Ctrl-D) | quit |

**Sending images (vision):** copy an image to your clipboard, press **Ctrl-V** in the chat (macOS),
and the prompt shows `[1 img]`. Type your question and hit Enter — the image goes to the model with
your message ("what's in this image?"). Uses the ImageX upload described above.

Pro mode prints its reasoning dimmed under `[thinking]` before the `assistant›` answer. Unlike
the HTTP proxy (stateless), the REPL keeps one conversation per session so the model remembers
earlier turns.

## API

### Chat — `POST /v1/chat/completions`

```bash
curl localhost:8787/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "dola-pro",
  "messages": [{"role":"user","content":"Explain quicksort in one sentence."}],
  "stream": true
}'
```

- `model`: `dola-fast` (default) or `dola-pro`.
- `stream: true` → OpenAI-style `text/event-stream` chunks. Otherwise a single JSON completion.
- Pro reasoning is returned as `message.reasoning_content` (non-streaming).

**Vision** — use the OpenAI multi-part content format; the proxy uploads the image to Dola:

```bash
curl localhost:8787/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "dola-fast",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "what is in this image?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
  ] }]
}'
```

Both `data:` base64 URIs and `https://` image URLs are accepted.

### Image — `POST /v1/images/generations`

```bash
curl localhost:8787/v1/images/generations -H 'content-type: application/json' \
  -d '{"prompt":"a blue circle on white background"}'
```

Generates 4 images, downloads them into `generated_content/`, and returns **stable proxy links**
(Dola's own URLs are signed and expire):

```json
{ "data": [ { "url": "http://localhost:8787/generated_content/mrhi-abc.png",
              "source_url": "https://p16-flow-image-sign.ibyteimg.com/..." }, ... ] }
```

Fetch any link directly (`GET /generated_content/<file>`) to get the image bytes.

### Video — `POST /v1/videos/generations`

```bash
curl localhost:8787/v1/videos/generations -H 'content-type: application/json' \
  -d '{"prompt":"a cat walking in a garden","duration":10}'
```

Always uses **Dreamina Seedance 1.0**. Passing `model` containing `2` / `2.0` / `fast`
is **rejected**. Video is async and consumes Dola points.

### Other

- `GET /health` — liveness + whether the cookie is configured.
- `GET /v1/models` — lists `dola-fast`, `dola-pro`, `dola-image`, `dreamina-seedance-1.0`.

## Notes & limitations

- **Stateless, no shared context.** Each request is its own fresh conversation. OpenAI-style
  clients that send full message history still work — the proxy flattens the turns into the
  single prompt it sends to the new chat.
- **Delete needs the web app's signing.** See "About auto-delete" above — throwaway chats are
  left server-side (they don't appear in history). `DOLA_DELETE_AFTER=1` enables a best-effort,
  usually-failing attempt.
- **Async media.** Image/video URLs are not guaranteed in the initial response. A
  polling helper for finished media is a natural next addition.
- This proxy relies on an authenticated personal session and is intended for personal
  use with your own account.

## Dev

```bash
npm run smoke   # offline checks: body/ability descriptors + SSE frame parsing
```
