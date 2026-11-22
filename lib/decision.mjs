// Normalize Quick's choice markup for external clients (Claude Desktop).
// The upstream model emits <decision>/<option> that the UI cannot render.
// Convert only complete standalone blocks; keep their options as Markdown.
// Other text (including tool calls) remains unchanged.

const OPEN = '<decision'
const CLOSE = '</decision>'
const WRAP_OPEN = '<decisions>'
const WRAP_CLOSE = '</decisions>'
const BUFFER_LIMIT = 64 * 1024

function decodeEntities(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function attr(text, key) {
  const found = new RegExp('\\b' + key + '\\s*=\\s*(["\\x27])(.*?)\\1', 's').exec(text)
  return found ? decodeEntities(found[2]) : ''
}

export function renderDecisionBlock(block) {
  const open = /^<decision\b([^>]*)>/.exec(block)
  if (!open || !block.endsWith(CLOSE)) return block
  const choiceText = block.slice(open[0].length, -CLOSE.length)
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/g
  const options = [...choiceText.matchAll(optionRe)].map(m => ({
    title: decodeEntities(m[2]).trim(),
    detail: attr(m[1], 'description').trim(),
  })).filter(x => x.title)
  if (!options.length) return block
  const question = attr(open[1], 'question').trim()
  return [
    question ? '**' + question + '**' : '**可选操作**',
    ...options.map(x => '- ' + x.title + (x.detail && x.detail !== x.title ? ' — ' + x.detail : '')),
  ].join('\n')
}

function suffixOfOpen(buffer) {
  let best = 0
  for (const tag of [OPEN, WRAP_OPEN, WRAP_CLOSE]) {
    const max = Math.min(tag.length - 1, buffer.length)
    for (let i = max; i > best; i--) {
      if (buffer.endsWith(tag.slice(0, i))) best = i
    }
  }
  return best
}

export function createDecisionOutputFilter() {
  let buffer = ''
  let atLineStart = true
  let insideCodeFence = false
  let ticks = 0

  function observe(text) {
    for (const c of text) {
      if (c === '\n') {
        atLineStart = true
        ticks = 0
        continue
      }
      if (c === '\r') continue
      if (!/\s/.test(c)) atLineStart = false
      if (c.charCodeAt(0) === 96) {
        ticks++
        if (ticks === 3) {
          insideCodeFence = !insideCodeFence
          ticks = 0
        }
      } else ticks = 0
    }
  }

  function push(text) {
    buffer += String(text || '')
    let output = ''
    const emit = (part) => {
      if (!part) return
      output += part
      observe(part)
    }
    while (buffer) {
      const starts = [OPEN, WRAP_CLOSE].map(tag => buffer.indexOf(tag)).filter(i => i >= 0)
      const found = starts.length ? Math.min(...starts) : -1
      if (found < 0) {
        const hold = suffixOfOpen(buffer)
        emit(buffer.slice(0, buffer.length - hold))
        buffer = buffer.slice(buffer.length - hold)
        break
      }
      emit(buffer.slice(0, found))
      buffer = buffer.slice(found)
      // The multi-question wrapper is a UI container, not user-facing prose.
      // Remove only complete, standalone wrappers. Nested <decision> content
      // is converted normally by the same filter.
      if (buffer.startsWith(WRAP_OPEN) || buffer.startsWith(WRAP_CLOSE)) {
        const tag = buffer.startsWith(WRAP_OPEN) ? WRAP_OPEN : WRAP_CLOSE
        if (atLineStart && !insideCodeFence) buffer = buffer.slice(tag.length)
        else { emit(tag); buffer = buffer.slice(tag.length) }
        continue
      }
      if (!atLineStart || insideCodeFence) {
        emit(buffer.slice(0, 1))
        buffer = buffer.slice(1)
        continue
      }
      const endOfOpen = buffer.indexOf('>')
      if (endOfOpen < 0 || buffer.slice(0, endOfOpen).includes('\n')) {
        if (buffer.length > BUFFER_LIMIT) {
          emit(buffer.slice(0, 1))
          buffer = buffer.slice(1)
          continue
        }
        break
      }
      const opener = buffer.slice(0, endOfOpen + 1)
      if (!/^<decision(?:\s[^>]*)?>$/.test(opener)) {
        emit(buffer.slice(0, 1))
        buffer = buffer.slice(1)
        continue
      }
      const end = buffer.indexOf(CLOSE, endOfOpen + 1)
      if (end === -1) {
        if (buffer.length > BUFFER_LIMIT) {
          emit(buffer.slice(0, 1))
          buffer = buffer.slice(1)
          continue
        }
        break
      }
      const block = buffer.slice(0, end + CLOSE.length)
      emit(renderDecisionBlock(block))
      buffer = buffer.slice(end + CLOSE.length)
    }
    return output
  }

  function end() {
    const tail = buffer
    buffer = ''
    observe(tail)
    return tail
  }

  return {push, end}
}
