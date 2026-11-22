#!/usr/bin/env node
// Standalone fallback: an OpenAI-compatible proxy on 127.0.0.1 for the same
// adapter, for when you would rather add Amazon Quick to magpie as a custom
// provider (magpie provider add … --base-url http://127.0.0.1:PORT/v1) than
// load the plugin, or use it from any other OpenAI-compatible client.
//
//   node bin/serve.mjs                  # boots the Quick outpost lazily on first request
//   PORT=3426  HOST=127.0.0.1
//   PROXY_TOKEN=…                       # require "Authorization: Bearer <PROXY_TOKEN>" (recommended)
//   QUICK_AGENT_PATH=…                  # explicit quickwork-agent(.exe)
//   QUICK_AGENT_ZIP=…                   # explicit resources/agent.zip to extract
//   QUICK_SESSION_REUSE=0               # send every request on a fresh Quick thread
//   QUICK_SESSION_TTL_MS=1800000  QUICK_SESSION_MAX=200
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createOutpostManager } from '../lib/outpost.mjs'
import { createSessionStore, SESSION_DEFAULTS } from '../lib/sessions.mjs'
import { createSessionStore as createOAuthStore, createDirectBackend, defaultStoreDir } from '../lib/oauth.mjs'
import { toOpenAIRequest, toAnthropicResponse, toAnthropicStream, anthropicModelList, anthropicErrorResponse, approximateTokens } from '../lib/anthropic.mjs'

export function createProxyServer({ options = {}, token = '', outpostMgr, sessions, oauthStore, log = () => {} } = {}) {
  const store = oauthStore ?? createOAuthStore({ dir: options.sessionDir || defaultStoreDir() })
  const fallback = outpostMgr ?? createOutpostManager(options)
  let nextAccount = 0
  const managers = new Map()
  // Choose one account per turn; identity isolates persisted Quick threads.
  function chooseBackend() {
    const accounts = store.list()
    if (!accounts.length) return { mgr: fallback, identity: 'local-outpost' }
    const key = accounts[(nextAccount++) % accounts.length]
    if (!managers.has(key)) {
      managers.set(key, { ensure: () => createDirectBackend({
        load: () => store.get(key),
        persist: (session) => store.set(key, session),
        log,
      }).ensure() })
    }
    return { mgr: managers.get(key), identity: 'oauth:' + key }
  }
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      if (req.method === 'GET' && (path === '/health' || path === '/healthz' || path === '/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, service: 'magpie-quick-mac' }))
      }
      if (token) {
        const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
        if (got !== token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ type: 'error', error: { message: 'Invalid API Key', type: 'authentication_error' } }))
        }
      }
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      let out
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const models = handleModels()
        out = req.headers['anthropic-version']
          ? new Response(JSON.stringify(anthropicModelList(await models.json())), { headers: { 'content-type': 'application/json' } })
          : models
      } else if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        const id = decodeURIComponent(path.slice('/v1/models/'.length))
        const models = anthropicModelList(await handleModels().json()).data
        const entry = models.find((x) => x.id === id)
        out = entry ? Response.json(entry) : anthropicErrorResponse(404, 'not_found_error', 'Model not found')
      } else if (req.method === 'POST' && (path === '/v1/messages/count_tokens' || path === '/messages/count_tokens')) {
        let body
        try { body = JSON.parse(await requestBody(req)) } catch { return send(res, anthropicErrorResponse(400, 'invalid_request_error', 'Invalid JSON')) }
        out = Response.json({ input_tokens: approximateTokens(body), estimated: true })
      } else if (req.method === 'POST' && ['/v1/chat/completions', '/chat/completions', '/v1/messages', '/messages'].includes(path)) {
        let body
        try { body = JSON.parse(await requestBody(req)) } catch {
          return send(res, anthropicErrorResponse(400, 'invalid_request_error', 'Invalid JSON'))
        }
        const isAnthropic = path === '/v1/messages' || path === '/messages'
        if (isAnthropic) {
          try { body = toOpenAIRequest(body) } catch (e) {
            return send(res, anthropicErrorResponse(400, 'invalid_request_error', String(e?.message || e)))
          }
        }
        const { mgr, identity } = chooseBackend()
        const sessionKey = ['x-magpie-session', 'x-session-id', 'x-session-affinity', 'x-client-request-id', 'x-thread-id', 'x-conversation-id']
          .map((h) => req.headers[h]).find((x) => typeof x === 'string' && x.trim())
        const opts = { ...options, identity, sessionKey }
        const openai = await handleChatCompletions({
          body, outpostMgr: mgr, options: opts, sessions,
          effortHeader: req.headers['x-magpie-effort'], signal: ac.signal,
        })
        out = isAnthropic
          ? (body.stream ? toAnthropicStream(openai, body.originalModel) : await toAnthropicResponse(openai, body.originalModel))
          : openai
      } else {
        out = anthropicErrorResponse(404, 'not_found_error', 'Unsupported endpoint')
      }
      return await send(res, out)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { message: String(e?.message || e), type: 'api_error' } }))
    }
  })
}

async function requestBody(req) {
  let total = 0
  const parts = []
  for await (const chunk of req) {
    total += chunk.length
    if (total > 8 * 1024 * 1024) throw new Error('Request too large')
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

async function send(res, reply) {
  res.writeHead(reply.status, Object.fromEntries(reply.headers))
  if (!reply.body) return res.end()
  try {
    for await (const chunk of reply.body) {
      if (res.destroyed) break
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
    }
  } finally { res.end() }
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const port = Number(process.env.PORT || 3426)
  const host = process.env.HOST || '127.0.0.1'
  const options = {}
  if (process.env.QUICK_AGENT_PATH) options.agentPath = process.env.QUICK_AGENT_PATH
  if (process.env.QUICK_AGENT_ZIP) options.agentZip = process.env.QUICK_AGENT_ZIP
  if (process.env.QUICK_USER_DATA_DIR) options.userDataDir = process.env.QUICK_USER_DATA_DIR
  if (process.env.QUICK_CACHE_DIR) options.cacheDir = process.env.QUICK_CACHE_DIR
  if (process.env.QUICK_OUTPOST_PORT) options.port = Number(process.env.QUICK_OUTPOST_PORT)
  if (process.env.QUICK_BUILD_STAGE) options.buildStage = process.env.QUICK_BUILD_STAGE
  const reuse = !/^(0|false|off|no)$/i.test(process.env.QUICK_SESSION_REUSE ?? '')
  const dataDir = process.env.MAGPIE_QUICK_DATA_DIR || defaultStoreDir()
  const sessions = reuse
    ? createSessionStore({
        ttlMs: Number(process.env.QUICK_SESSION_TTL_MS) > 0 ? Number(process.env.QUICK_SESSION_TTL_MS) : SESSION_DEFAULTS.ttlMs,
        max: Number(process.env.QUICK_SESSION_MAX) > 0 ? Number(process.env.QUICK_SESSION_MAX) : SESSION_DEFAULTS.max,
        file: join(dataDir, 'thread-sessions.json'),
      })
    : undefined
  const outpostMgr = createOutpostManager({ ...options, log: (l) => console.error('[outpost]', l) })
  createProxyServer({ options: { ...options, sessionDir: dataDir }, token: process.env.PROXY_TOKEN || '', outpostMgr, sessions, log: (line) => console.error(line) }).listen(port, host, () => {
    console.error(`aws-quick proxy listening on http://${host}:${port}/v1 (outpost starts on first request)`)
  })
}
