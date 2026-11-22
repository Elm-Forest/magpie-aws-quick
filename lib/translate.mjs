// OpenAI ⇄ Quick message rendering + model/mode mapping.
//
// Quick's user_message carries a single `text` field for the conversation;
// the client's system prompt goes through the dedicated
// `user_message.payload.system_prompt` field instead (verified live — the
// server honors it as a per-turn system override). History and tool results
// are still rendered into the text itself, the same approach magpie-comate
// takes.

/** Text content of one content-part object (OpenAI/Anthropic/Responses shapes). */
function partText(p) {
  if (typeof p === 'string') return p
  const t = p?.type
  if (t === 'text' || t === 'input_text' || t === 'output_text') return p.text ?? ''
  if (t === 'image_url' || t === 'input_image' || t === 'image') return '[image]'
  if (t === 'file' || t === 'input_file') return '[file omitted]'
  if (t === 'tool_result') return textOf(p.content) // string or nested parts
  if (t === 'tool_use') {
    const args = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {})
    return `[called tool ${p.name ?? 'tool'}(${args})]`
  }
  return '' // thinking/redacted_thinking/audio/etc carry no user-visible text
}

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join('\n')
  }
  return String(content)
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s

/** One image part as {mimeType, data(base64)} or {url} when it isn't inline data. */
function partImage(p) {
  const t = p?.type
  if (t !== 'image_url' && t !== 'input_image' && t !== 'image') return null
  const src = p.source
  if (src?.type === 'base64' && typeof src.data === 'string') return { mimeType: src.media_type || 'image/png', data: src.data }
  const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? p.url ?? (typeof p.data === 'string' && p.mimeType ? `data:${p.mimeType};base64,${p.data}` : '')
  const m = DATA_URL.exec(String(url ?? ''))
  return m ? { mimeType: m[1], data: m[2].replace(/\s+/g, '') } : { url: String(url ?? '') }
}

/** Images in a message's content, including those nested in tool_result parts. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.flatMap((p) => (p?.type === 'tool_result' ? imagesOf(p.content) : [partImage(p)].filter(Boolean)))
}

const IMAGE_ENTRY_OVERHEAD = 256

// Cloud-upload caps for images too big for the inline frame (per turn).
export const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024
export const MAX_UPLOADS = 4
export const MAX_UPLOAD_TOTAL_BYTES = 5 * 1024 * 1024

const imageExt = (mimeType) => mimeType?.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'img'
const decodedSize = (data) => {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - pad
}

/**
 * Pick images from `messages` for user_message.attachments. Quick counts
 * inline attachment data against the same ~64 KB frame as the text, so only
 * images whose base64 fits `maxBytes` go inline; the rest (and non-inline
 * URLs) are counted in `skipped`. With `{upload:true}` (direct/cloud
 * sessions), inline-data images that don't fit instead queue in `toUpload`
 * for lib/attach.mjs, subject to the upload caps — anything beyond them
 * still lands in `skipped`. Names are numbered across inline + upload.
 */
export function pickImages(messages, maxBytes, { upload = false } = {}) {
  const attachments = []
  const toUpload = []
  let bytes = 0
  let skipped = 0
  let seq = 0
  let uploadCount = 0
  let uploadBytes = 0
  for (const m of messages) {
    for (const img of imagesOf(m.content)) {
      const cost = (img.data?.length ?? Infinity) + IMAGE_ENTRY_OVERHEAD
      if (img.data && bytes + cost <= maxBytes) {
        attachments.push({ type: 'image', name: `image-${++seq}.${imageExt(img.mimeType)}`, size: decodedSize(img.data), mimeType: img.mimeType, data: img.data })
        bytes += cost
        continue
      }
      const decoded = img.data ? decodedSize(img.data) : Infinity
      if (upload && img.data && decoded <= MAX_UPLOAD_IMAGE_BYTES && uploadCount < MAX_UPLOADS && uploadBytes + decoded <= MAX_UPLOAD_TOTAL_BYTES) {
        toUpload.push({ mimeType: img.mimeType, data: img.data, name: `image-${++seq}.${imageExt(img.mimeType)}` })
        uploadCount++
        uploadBytes += decoded
        continue
      }
      skipped++
    }
  }
  return { attachments, bytes, skipped, toUpload }
}

/**
 * Canonical role across client dialects: some agents/gateways emit 'ai',
 * 'human', 'observation' etc. instead of the OpenAI names. Thread-reuse
 * prefix matching and transcript rendering both key off this.
 */
export function canonRole(role) {
  const r = String(role ?? '').toLowerCase()
  if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model' || r === 'assistant_message') return 'assistant'
  if (r === 'user' || r === 'human' || r === 'input') return 'user'
  if (r === 'tool' || r === 'tool_result' || r === 'observation' || r === 'tool_output') return 'tool'
  return r
}

/** Agent modes the desktop client can send as `agent_mode`. */
export const AGENT_MODES = Object.freeze(['fast', 'balanced', 'smart', 'advanced'])

export const MODELS = Object.freeze(
  AGENT_MODES.map((mode) => ({
    id: mode,
    object: 'model',
    created: 0,
    owned_by: 'aws-quick',
    name: { fast: 'Quick Fast', balanced: 'Quick Balanced', smart: 'Quick Smart', advanced: 'Quick Advanced' }[mode],
  })),
)

/** Map a requested model id to an agent_mode; unknown → 'smart'. */
export function modeFor(model) {
  const m = String(model ?? '').trim().toLowerCase()
  const bare = m.includes('/') ? m.split('/').pop() : m
  return AGENT_MODES.includes(bare) ? bare : 'smart'
}

/** thinking_effort levels the client understands (off/low/medium/high/max). */
export const EFFORT_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max'])

/**
 * thinking_effort from the X-Magpie-Effort header or body.reasoning_effort.
 * Returns undefined when unset/invalid (server then uses its default).
 */
export function effortFor(effortHeader, body) {
  const raw = effortHeader ?? body?.reasoning_effort ?? body?.thinking_effort
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (EFFORT_LEVELS.includes(v)) return v
  // magpie/OpenAI spellings → quick levels
  const map = { none: 'off', minimal: 'low', low: 'low', medium: 'medium', med: 'medium', high: 'high', xhigh: 'max', max: 'max' }
  return map[v] ?? (v === 'enabled' || v === 'true' ? 'high' : v === 'disabled' || v === 'false' ? 'off' : undefined)
}

function renderToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return ''
  return calls
    .map((c) => {
      const name = c?.function?.name ?? c?.name ?? 'tool'
      const args = c?.function?.arguments ?? c?.arguments ?? ''
      return `[called tool ${name}(${typeof args === 'string' ? args : JSON.stringify(args)})]`
    })
    .join('\n')
}

const te = new TextEncoder()
export const byteLen = (s) => te.encode(String(s ?? '')).length

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024
const SYSTEM_CAP = 24 * 1024
const USER_TURN_CAP = 20 * 1024
const TOOL_RESULT_CAP = 16 * 1024
const TRUNC_MARK = '\n…[truncated]'

function fitBytes(s, max) {
  if (byteLen(s) <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (byteLen(s.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}

/** Truncate to a byte budget, appending a marker. */
export function capText(s, maxBytes) {
  const str = String(s ?? '')
  if (byteLen(str) <= maxBytes) return str
  const room = maxBytes - byteLen(TRUNC_MARK)
  if (room <= 0) return fitBytes(str, maxBytes)
  return fitBytes(str, room) + TRUNC_MARK
}

const STALE_TOOL_CAP = 2 * 1024

/** Longest suffix of `s` within `max` bytes. */
function tailBytes(s, max) {
  if (max <= 0) return ''
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (byteLen(s.slice(mid)) <= max) hi = mid
    else lo = mid + 1
  }
  return s.slice(lo)
}

/**
 * Keep both ends of a partial tool output, while respecting a byte budget.
 */
function shrinkTool(body, maxBytes) {
  const total = byteLen(body)
  if (total <= maxBytes) return body
  if (maxBytes <= 0) return ''
  const mark = '[PARTIAL TOOL RESULT: ' + total + ' bytes total; use a narrower range to read more]'
  if (maxBytes < byteLen(mark) + 8) return fitBytes('[TRUNCATED ' + total + ' bytes]', maxBytes)
  const room = maxBytes - byteLen(mark) - 2
  if (room < 96) return mark + '\n' + fitBytes(body, room)
  const head = fitBytes(body, Math.floor(room * 0.68))
  return head + '\n' + mark + '\n' + tailBytes(body, room - byteLen(head))
}
const toolHead = (m) => '[tool_result ' + [m.name, m.tool_call_id].filter(Boolean).join(' ') + ']'
const isTool = (m) => canonRole(m.role) === 'tool' || m.role === 'function'
const renderBlock = (b) => b.tool ? b.head + '\n' + b.body : b.body

/**
 * Fit a Quick user_message without starving the *latest* tool results.
 *
 * The previous allocator subtracted all historical dialogue before giving
 * even one byte to recent tool results. A long Claude Code session therefore
 * delivered "[TRUNCATED 537" for a perfectly small 537-byte result.
 *
 * Priority order:
 *   1. latest user request and latest assistant tool-call context
 *   2. recent tool results (after the latest assistant)
 *   3. older conversation text and stale tool results
 *
 * The latest results receive their full bytes whenever they fit within
 * their reserved share. Other results receive explicit PARTIAL markers.
 */
function fitBlocks(blocks, maxBytes, cut) {
  if (!Number.isFinite(maxBytes)) return {kept: blocks.map(renderBlock), dropped: 0}
  if (maxBytes < 4) {cut('droppedHistory');return {kept: [], dropped: blocks.length}}
  const list = blocks.map((b) => ({...b}))
  let dropped = 0
  const partialReserve = byteLen(' PARTIAL')
  const overhead = (b) => 2 + (b.tool ? byteLen(b.head) + 1 + partialReserve : byteLen(b.body))
  const fixedCost = () => list.reduce((n,b)=>n+overhead(b),0)

  // Keep the newest client question even when it preceded a batch of tools.
  // The newest assistant's tool-call message also helps interpret results.
  let oldQuestion = list.findLastIndex((b)=>b.user)
  let lastAssistant = list.findLastIndex((b)=>b.assistant)
  if (oldQuestion >= 0) list[oldQuestion].pinned = true
  if (lastAssistant >= 0) list[lastAssistant].pinned = true
  // All new tool outputs are protected from competing with old history.
  const freshTarget = () => {
    const sum = list.filter((b)=>b.tool && b.fresh).reduce((n,b)=>n+byteLen(b.body),0)
    return Math.min(sum, Math.floor(maxBytes*0.70))
  }

  const remove = (index) => {
    list.splice(index,1)
    dropped++
    cut('droppedHistory')
  }
  // First reclaim space from historical context before shaving current tools.
  while (fixedCost()+freshTarget()>maxBytes && list.length>1) {
    let i=list.findIndex((b)=>!b.pinned && !b.fresh)
    if(i<0) break
    remove(i)
  }
  // If a single pinned historical block is huge, shorten it before current
  // tool outputs. A final user question remains present, visibly truncated.
  if (fixedCost()+freshTarget()>maxBytes) {
    for(const b of list.filter(b=>b.pinned && !b.tool)) {
      const desired=Math.max(256,Math.floor(maxBytes*(b.user?0.22:0.12)))
      if(byteLen(b.body)>desired) {
        b.body=capText(b.body,desired)
        cut('truncatedPinnedText')
      }
    }
  }
  while(fixedCost()>maxBytes && list.length>1) {
    let i=list.findIndex(b=>!b.pinned && !b.fresh)
    if(i<0) i=list.findIndex(b=>!b.pinned)
    if(i<0) break
    remove(i)
  }
  if(fixedCost()>maxBytes) {
    for(const b of list.filter(b=>!b.tool)) {
      if(fixedCost()<=maxBytes)break
      b.body=capText(b.body,Math.max(0,maxBytes-(fixedCost()-byteLen(b.body))-2))
      cut('truncatedPinnedText')
    }
  }

  // Water fill the *recent* results before allocating any space to stale
  // outputs. Small results are accepted in their entirety before splitting
  // large results.
  let bytes=Math.max(0,maxBytes-fixedCost())
  function allocate(group) {
    const lengths=group.map(b=>byteLen(b.body))
    const allowed=lengths.map(()=>0)
    const pending=lengths.map((_,i)=>i)
    while(pending.length) {
      const share=Math.floor(bytes/pending.length)
      const small=pending.filter(i=>lengths[i]<=share)
      if(small.length) {
        for(const i of small) {
          allowed[i]=lengths[i]
          bytes-=lengths[i]
          pending.splice(pending.indexOf(i),1)
        }
      } else {
        for(const i of pending) {allowed[i]=share;bytes-=share}
        for(let j=pending.length-1;j>=0 && bytes>0;j--,bytes--)allowed[pending[j]]++
        break
      }
    }
    group.forEach((b,i)=>{
      if(lengths[i]>allowed[i]) {
        b.body=shrinkTool(b.body,allowed[i])
        if(!b.partial)cut('partialToolResults');else cut()
        b.partial=true
      }
    })
  }
  allocate(list.filter(b=>b.tool && b.fresh))
  allocate(list.filter(b=>b.tool && !b.fresh))
  for(const b of list) if(b.tool && b.partial)b.head+=' PARTIAL'
  const kept=list.map(renderBlock)
  if(kept.reduce((n,t)=>n+byteLen(t)+2,0)>maxBytes)
    throw new Error('Quick message allocation exceeded frame budget')
  return {kept,dropped}
}

function toolBlock(m, cap, cut) {
  let body = textOf(m.content)
  const partial = byteLen(body) > cap
  if (partial) { body = shrinkTool(body, cap); cut('partialToolResults') }
  return { tool: true, head: toolHead(m), body, partial, fresh: false }
}

/** One transcript line for a non-tool message in the rendered history. */
function transcriptLine(m) {
  const text = textOf(m.content)
  const role = canonRole(m.role)
  if (role === 'assistant') {
    const calls = renderToolCalls(m.tool_calls)
    return `assistant: ${[text, calls].filter(Boolean).join('\n')}`
  }
  return `${role}: ${text}`
}

const HISTORY_HEAD_RESERVE = 96

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final turn. Everything the model needs in one user_message.
 * Tool results answered before the latest assistant turn are stale and
 * squeezed to STALE_TOOL_CAP; the rest share the budget via fitBlocks.
 * `stats` is mutated with {truncated:true} when anything was cut.
 */
export function renderTranscript(messages, systemText, { maxBytes = Infinity, stats } = {}) {
  const cut = (reason) => { if (stats) { stats.truncated = true; if (reason) stats[reason] = (stats[reason] || 0) + 1 } }
  const parts = []
  if (systemText) {
    if (byteLen(systemText) > SYSTEM_CAP) { systemText = capText(systemText, SYSTEM_CAP); cut() }
    parts.push(`[system instructions]\n${systemText}`)
  }
  let lastAsst = -1
  messages.forEach((m, i) => { if (canonRole(m.role) === 'assistant') lastAsst = i })
  const blocks = messages.map((m, i) => {
    if (isTool(m)) {
      const result=toolBlock(m, i < lastAsst ? STALE_TOOL_CAP : TOOL_RESULT_CAP, cut)
      result.fresh=i > lastAsst
      return result
    }
    if (i === messages.length - 1 && canonRole(m.role) === 'user') {
      let t = textOf(m.content)
      if (byteLen(t) > USER_TURN_CAP) { t = capText(t, USER_TURN_CAP); cut() }
      return { tool: false, user: true, body: t || '(empty)' }
    }
    return { tool: false, user: canonRole(m.role)==='user', assistant:canonRole(m.role)==='assistant', body: transcriptLine(m) }
  })
  if (!blocks.length) blocks.push({ tool: false, body: '(empty)' })
  const sysBytes = parts.reduce((n, s) => n + byteLen(s) + 2, 0)
  const { kept, dropped } = fitBlocks(blocks, maxBytes - sysBytes - (blocks.length > 1 ? HISTORY_HEAD_RESERVE : 0), cut)
  const last = kept.pop()
  if (kept.length || dropped) {
    const head = dropped
      ? `[conversation so far — ${dropped} earlier message(s) omitted]\n`
      : '[conversation so far]\n'
    parts.push(head + kept.join('\n\n'))
  }
  parts.push(last)
  return parts.join('\n\n')
}

/**
 * Delta text for a REUSED thread: only the new user/tool content.
 * Per-block caps apply first (TOOL_RESULT_CAP / USER_TURN_CAP); then tool
 * results share the remaining budget (fitBlocks) — the current turn's
 * question is never sacrificed for tool output.
 */
export function renderDelta(delta, { maxBytes = Infinity, stats } = {}) {
  const cut = (reason) => { if (stats) { stats.truncated = true; if (reason) stats[reason] = (stats[reason] || 0) + 1 } }
  const blocks = []
  for (const m of delta) {
    if (isTool(m)) { const b=toolBlock(m, TOOL_RESULT_CAP, cut); b.fresh=true; blocks.push(b); continue }
    // assistant messages never appear in a valid delta (findContinuation rejects them)
    if (canonRole(m.role) !== 'user') continue
    let t = textOf(m.content)
    if (!t) continue
    if (byteLen(t) > USER_TURN_CAP) { t = capText(t, USER_TURN_CAP); cut() }
    blocks.push({ tool: false, body: t, user: true })
  }
  if (!blocks.length) return ''
  const { kept, dropped } = fitBlocks(blocks, maxBytes - 48, cut)
  return dropped ? `[${dropped} earlier message(s) omitted]\n` + kept.join('\n\n') : kept.join('\n\n')
}
