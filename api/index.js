// Vercel serverless entrypoint. All routes are rewritten to this function (see vercel.json),
// which delegates to the same request handler used by the local server.
import { handleRequest } from '../server.js';

export default function handler(req, res) {
  // Depending on how Vercel maps the rewrite, req.url may be prefixed with /api — normalize it
  // so the path-based router in server.js sees the original path (e.g. /v1/chat/completions).
  if (req.url === '/api') req.url = '/';
  else if (req.url && req.url.startsWith('/api/')) req.url = req.url.slice(4) || '/';
  return handleRequest(req, res);
}
