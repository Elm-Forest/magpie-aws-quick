import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textOf, modeFor, effortFor, renderTranscript, renderDelta, byteLen, capText, UPSTREAM_TEXT_LIMIT, imagesOf, pickImages, MAX_UPLOAD_IMAGE_BYTES, MAX_UPLOADS, MAX_UPLOAD_TOTAL_BYTES } from '../lib/translate.mjs'

test('textOf handles strings, parts arrays, and junk', () => {
  assert.equal(textOf('hi'), 'hi')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf(null), '')
  assert.equal(textOf([{ type: 'image_url', image_url: { url: 'x' } }]), '[image]')
  assert.equal(textOf(42), '42')
})

test('textOf understands Anthropic/Responses-style content parts', () => {
  // Responses API spellings
  assert.equal(textOf([{ type: 'input_text', text: 'hello' }]), 'hello')
  assert.equal(textOf([{ type: 'output_text', text: 'world' }]), 'world')
  // Anthropic tool blocks inside content arrays
  assert.equal(textOf([{ type: 'tool_result', content: 'tool output' }]), 'tool output')
  assert.equal(
    textOf([{ type: 'tool_result', content: [{ type: 'text', text: 'nested' }] }]),
    'nested',
  )
  assert.equal(
    textOf([{ type: 'tool_use', name: 'Read', input: { path: '/a' } }]),
    '[called tool Read({"path":"/a"})]',
  )
  // reasoning blocks contribute nothing
  assert.equal(
    textOf([{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }]),
    'answer',
  )
})

test('modeFor maps model ids to agent modes', () => {
  assert.equal(modeFor('fast'), 'fast')
  assert.equal(modeFor('balanced'), 'balanced')
  assert.equal(modeFor('smart'), 'smart')
  assert.equal(modeFor('advanced'), 'advanced')
  assert.equal(modeFor('provider/fast'), 'fast')
  assert.equal(modeFor('AWS Quick Smart'), 'smart')
  assert.equal(modeFor('gpt-5'), 'smart') // unknown → default
  assert.equal(modeFor(undefined), 'smart')
  assert.equal(modeFor(''), 'smart')
})

test('effortFor maps header/body spellings to quick levels', () => {
  assert.equal(effortFor('high', {}), 'high')
  assert.equal(effortFor(undefined, { reasoning_effort: 'low' }), 'low')
  assert.equal(effortFor(undefined, { thinking_effort: 'max' }), 'max')
  assert.equal(effortFor('xhigh', {}), 'max')
  assert.equal(effortFor('none', {}), 'off')
  assert.equal(effortFor('bogus', {}), undefined)
  assert.equal(effortFor(undefined, {}), undefined)
})

test('renderTranscript: system + history + raw final user turn', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply one' },
    { role: 'user', content: 'second' },
  ]
  const out = renderTranscript(messages, 'be terse')
  assert.ok(out.includes('[system instructions]\nbe terse'))
  assert.ok(out.includes('[conversation so far]'))
  assert.ok(out.includes('user: first'))
  assert.ok(out.includes('assistant: reply one'))
  // last user message goes in raw, no role prefix
  assert.ok(out.endsWith('\n\nsecond'))
  assert.ok(!out.includes('user: second'))
})

test('renderTranscript without system/history is just the user text', () => {
  assert.equal(renderTranscript([{ role: 'user', content: 'hello' }], ''), 'hello')
})

test('renderDelta renders only new user/tool content', () => {
  const delta = [
    { role: 'user', content: 'next question' },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'file body' },
  ]
  const out = renderDelta(delta)
  assert.ok(out.includes('next question'))
  assert.ok(out.includes('[tool_result read c1]'))
  assert.ok(out.includes('file body'))
})

test('capText truncates by bytes with marker and respects budget', () => {
  const s = 'x'.repeat(10 * 1024)
  const out = capText(s, 4096)
  assert.ok(byteLen(out) <= 4096)
  assert.ok(out.endsWith('[truncated]'))
  assert.equal(capText('short', 4096), 'short')
  // multi-byte chars: byte budget must hold even for CJK
  const cjk = capText('汉'.repeat(5000), 4096)
  assert.ok(byteLen(cjk) <= 4096)
  assert.ok(cjk.includes('truncated'))
})

test('renderTranscript drops oldest history first, keeps final user turn', () => {
  const messages = [
    { role: 'user', content: 'OLD-QUESTION-' + 'a'.repeat(3000) },
    { role: 'assistant', content: 'OLD-ANSWER-' + 'b'.repeat(3000) },
    { role: 'user', content: 'RECENT-' + 'c'.repeat(2000) },
    { role: 'assistant', content: 'RECENT-ANSWER-' + 'd'.repeat(2000) },
    { role: 'user', content: 'FINAL-QUESTION' },
  ]
  const stats = {}
  const out = renderTranscript(messages, 'sys', { maxBytes: 8000, stats })
  assert.ok(stats.truncated)
  assert.ok(out.endsWith('FINAL-QUESTION')) // current turn never dropped
  assert.ok(!out.includes('OLD-QUESTION')) // oldest dropped
  assert.ok(out.includes('RECENT-QUESTION') || out.includes('RECENT-ANSWER') || out.includes('recent'))
  assert.ok(out.includes('earlier message(s) omitted'))
  assert.ok(byteLen(out) <= 8000)
})

test('renderTranscript caps oversized system prompt and user turn', () => {
  const messages = [{ role: 'user', content: 'u'.repeat(30 * 1024) }]
  const stats = {}
  const out = renderTranscript(messages, 's'.repeat(40 * 1024), { maxBytes: UPSTREAM_TEXT_LIMIT, stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes('[truncated]'))
  assert.ok(byteLen(out) <= UPSTREAM_TEXT_LIMIT)
  assert.ok(out.endsWith('[truncated]')) // user turn itself was capped
})

test('renderDelta caps oversized tool results per block', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'F'.repeat(30 * 1024) },
    { role: 'user', content: 'next' },
  ]
  const stats = {}
  const out = renderDelta(delta, { stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes('[tool_result read c1]'))
  assert.ok(out.includes('next'))
  assert.ok(byteLen(out) < 20 * 1024) // 16KB cap + small user msg
})

test('renderDelta shares the budget across parallel tool results instead of dropping the oldest', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'a', content: 'A'.repeat(10 * 1024) },
    { role: 'tool', tool_call_id: 'c2', name: 'b', content: 'B'.repeat(10 * 1024) },
    { role: 'tool', tool_call_id: 'c3', name: 'c', content: 'C'.repeat(10 * 1024) },
    { role: 'user', content: 'final question' },
  ]
  const stats = {}
  const out = renderDelta(delta, { maxBytes: 20 * 1024, stats })
  assert.ok(stats.truncated)
  assert.ok(byteLen(out) <= 20 * 1024)
  assert.ok(out.endsWith('final question'))
  for (const h of ['[tool_result a c1]', '[tool_result b c2]', '[tool_result c c3]']) assert.ok(out.includes(h), h)
  assert.ok(!out.includes('earlier message(s) omitted'))
  assert.equal((out.match(/PARTIAL TOOL RESULT/g) || []).length, 3)
})

test('renderDelta keeps small results whole and squeezes only the large one', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'small', content: 'tiny output' },
    { role: 'tool', tool_call_id: 'c2', name: 'big', content: 'HEAD' + 'x'.repeat(40 * 1024) + 'TAIL-ERROR' },
  ]
  const out = renderDelta(delta, { maxBytes: 8 * 1024 })
  assert.ok(byteLen(out) <= 8 * 1024)
  assert.ok(out.includes('tiny output'))
  assert.ok(out.includes('HEAD') && out.includes('TAIL-ERROR')) // head + tail both survive
  assert.ok(out.includes('PARTIAL TOOL RESULT'))
})

test('renderDelta still drops oldest text when conversation text alone overflows', () => {
  const delta = [
    { role: 'user', content: 'OLD-' + 'a'.repeat(6000) },
    { role: 'user', content: 'NEW-QUESTION' },
  ]
  const out = renderDelta(delta, { maxBytes: 4096 })
  assert.ok(byteLen(out) <= 4096)
  assert.ok(!out.includes('OLD-'))
  assert.ok(out.includes('earlier message(s) omitted'))
  assert.ok(out.endsWith('NEW-QUESTION'))
})

test('renderTranscript squeezes stale tool results, keeps fresh ones and all dialogue', () => {
  const messages = [
    { role: 'user', content: 'FIRST-ASK' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'STALE' + 's'.repeat(12 * 1024) },
    { role: 'assistant', content: 'MIDDLE-ANSWER', tool_calls: [{ id: 'c2', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'read', content: 'FRESH' + 'f'.repeat(8 * 1024) },
  ]
  const out = renderTranscript(messages, '', { maxBytes: UPSTREAM_TEXT_LIMIT })
  assert.ok(out.includes('FIRST-ASK') && out.includes('MIDDLE-ANSWER'))
  assert.ok(out.includes('STALE') && out.includes('PARTIAL TOOL RESULT')) // stale result squeezed, not dropped
  assert.ok(out.includes('f'.repeat(8 * 1024))) // fresh result fits whole
  assert.ok(byteLen(out) < 16 * 1024)
})

test('imagesOf reads OpenAI, Responses, Anthropic and nested tool_result image shapes', () => {
  const imgs = imagesOf([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,REVG' },
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'R0hJ' } },
    { type: 'tool_result', content: [{ type: 'image_url', image_url: { url: 'data:image/gif;base64,SktM' } }] },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'text', text: 'not an image' },
  ])
  assert.deepEqual(imgs.slice(0, 4).map((i) => i.mimeType), ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  assert.equal(imgs[0].data, 'QUJD')
  assert.deepEqual(imgs[4], { url: 'https://example.com/a.png' })
  assert.equal(imgs.length, 5)
})

test('pickImages keeps images that fit the byte budget and counts the rest as skipped', () => {
  const small = 'A'.repeat(1000)
  const big = 'B'.repeat(50 * 1024)
  const msgs = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${small}` } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] },
  ]
  const r = pickImages(msgs, 10 * 1024)
  assert.equal(r.attachments.length, 1)
  assert.deepEqual(r.attachments[0], { type: 'image', name: 'image-1.jpg', size: 750, mimeType: 'image/jpeg', data: small })
  assert.equal(r.skipped, 2)
  assert.ok(r.bytes >= small.length && r.bytes <= 10 * 1024)
  assert.deepEqual(r.toUpload, [])
})

const b64 = (bytes, fill = 7) => Buffer.alloc(bytes, fill).toString('base64')
const imgPart = (data, mime = 'image/png') => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } })

test('pickImages queues oversized inline images for upload when enabled', () => {
  const big = b64(100 * 1024)   // ~100 KB decoded — far over any inline budget
  const small = b64(400)
  const msgs = [{
    role: 'user',
    content: [imgPart(big), imgPart(small, 'image/jpeg'), { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
  }]
  const r = pickImages(msgs, 4 * 1024, { upload: true })
  // the small one still goes inline; numbering continues across both lists
  assert.equal(r.attachments.length, 1)
  assert.equal(r.attachments[0].name, 'image-2.jpg')
  assert.equal(r.attachments[0].data, small)
  assert.equal(r.toUpload.length, 1)
  assert.deepEqual(r.toUpload[0], { mimeType: 'image/png', data: big, name: 'image-1.png' })
  assert.equal(r.skipped, 1) // the remote URL
  assert.equal(r.bytes, small.length + 256)

  // same input without upload → the big image is skipped, not queued
  const r2 = pickImages(msgs, 4 * 1024)
  assert.equal(r2.attachments.length, 1)
  assert.equal(r2.attachments[0].name, 'image-1.jpg')
  assert.deepEqual(r2.toUpload, [])
  assert.equal(r2.skipped, 2)
})

test('pickImages upload caps: count, per-image size and total bytes', () => {
  const oneMiB = b64(1024 * 1024)
  const five = Array.from({ length: MAX_UPLOADS + 1 }, () => imgPart(oneMiB))
  const r = pickImages([{ role: 'user', content: five }], 1024, { upload: true })
  assert.equal(r.toUpload.length, MAX_UPLOADS)
  assert.equal(r.skipped, 1) // the 5th upload is over the per-turn cap

  // a single image over 3 MiB decoded never uploads
  const huge = b64(MAX_UPLOAD_IMAGE_BYTES + 1)
  const r2 = pickImages([{ role: 'user', content: [imgPart(huge)] }], 1024, { upload: true })
  assert.equal(r2.toUpload.length, 0)
  assert.equal(r2.skipped, 1)
  // exactly at the cap is allowed
  const atCap = b64(MAX_UPLOAD_IMAGE_BYTES)
  const r3 = pickImages([{ role: 'user', content: [imgPart(atCap)] }], 1024, { upload: true })
  assert.equal(r3.toUpload.length, 1)

  // total decoded budget: two ~2.6 MiB images exceed 5 MiB together
  const two = b64(Math.floor(MAX_UPLOAD_TOTAL_BYTES / 2) + 1024)
  const r4 = pickImages([{ role: 'user', content: [imgPart(two), imgPart(two)] }], 1024, { upload: true })
  assert.equal(r4.toUpload.length, 1)
  assert.equal(r4.skipped, 1)
})


test('parallel results: preserve a 163-byte result alongside three oversized outputs', () => {
  const brief = 'SHORT-RESULT-MARKER-' + 'z'.repeat(143)
  assert.equal(byteLen(brief), 163)
  const delta = [
    { role: 'tool', name: 'Bash', tool_call_id: 'large1', content: 'HEAD1:' + 'A'.repeat(23120) + ':TAIL1' },
    { role: 'tool', name: 'Read', tool_call_id: 'large2', content: 'HEAD2:' + 'B'.repeat(18455) + ':TAIL2' },
    { role: 'tool', name: 'Bash', tool_call_id: 'large3', content: 'HEAD3:' + 'C'.repeat(29391) + ':TAIL3' },
    { role: 'tool', name: 'Bash', tool_call_id: 'small', content: brief },
    { role: 'user', content: 'NEXT QUESTION' },
  ]
  const stats = {}
  const out = renderDelta(delta, { maxBytes: 9 * 1024, stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes(brief), 'the 163-byte result must survive exactly')
  assert.ok(out.includes('NEXT QUESTION'))
  for (const id of ['large1', 'large2', 'large3', 'small']) assert.ok(out.includes(id))
  assert.equal((out.match(/PARTIAL TOOL RESULT/g) || []).length, 3)
  assert.ok(byteLen(out) <= 9 * 1024)
})

test('UTF-8 output budgets never overflow or erase last user instruction', () => {
  // Regression for multibyte text, near-empty budgets, and concurrent results.
  for (const budget of [128, 256, 512, 1024, 4096, 8192, 16384]) {
    const delta = [
      { role: 'tool', name: 'Read', tool_call_id: 'c1', content: '数据'.repeat(2000) },
      { role: 'tool', name: 'Bash', tool_call_id: 'c2', content: 'ERROR ' + '错'.repeat(3000) },
      { role: 'user', content: 'NOW' },
    ]
    const out = renderDelta(delta, { maxBytes: budget })
    assert.ok(byteLen(out) <= budget, 'exceeded budget ' + budget)
    assert.ok(out.includes('NOW'), 'lost current user instruction at ' + budget)
  }
})


test('byte-budget allocation is invariant across many tool result shapes', () => {
  // Fixed deterministic PRNG for reproducible stress tests.
  let seed = 20261123
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  for (let trial = 0; trial < 250; trial++) {
    const tools = Array.from({length: 1 + (rand() % 14)}, (_, i) => ({
      role:'tool',name:'Read',tool_call_id:'c'+i,
      content: ('中文' + i + 'X').repeat(rand() % 2600),
    }))
    const delta = [{role:'user',content:'QUESTION-PROOF'},...tools]
    const budget = 128 + (rand() % 22000)
    const out = renderDelta(delta, {maxBytes:budget})
    assert.ok(byteLen(out) <= budget, 'budget overrun in trial '+trial)
    assert.ok(out.includes('QUESTION-PROOF'), 'current question missing in trial '+trial)
  }
})


test('tool output with zero available body is explicitly labelled PARTIAL', () => {
  const delta = [
    {role:'user',content:'CURRENT'},
    ...Array.from({length:12},(_,i)=>({
      role:'tool',name:'Read',tool_call_id:'tool'+i,content:'DATA'.repeat(500),
    })),
  ]
  const out=renderDelta(delta,{maxBytes:180})
  assert.ok(byteLen(out)<=180)
  assert.ok(out.includes('CURRENT'))
  assert.ok(out.includes('PARTIAL'), 'missing partial label for an empty or truncated tool output')
})


test('regression: long Claude Code session retains latest 537- and 802-byte tool results', () => {
  const history = []
  for (let i=0;i<28;i++) {
    history.push({role:'user',content:'Historical request '+i+' '+'Q'.repeat(700)})
    history.push({role:'assistant',content:'Historical answer '+i+' '+'A'.repeat(1000)})
    history.push({role:'tool',tool_call_id:'old'+i,content:'old_result '+i+' '+'r'.repeat(180)})
  }
  const first='FIRST_OUTPUT_537_'+'1'.repeat(520)
  const second='SECOND_OUTPUT_802_'+'2'.repeat(784)
  history.push({role:'assistant',content:'Check project files',tool_calls:[
    {id:'call_1',function:{name:'Bash',arguments:'{}'}},
    {id:'call_2',function:{name:'Bash',arguments:'{}'}},
  ]})
  history.push({role:'tool',tool_call_id:'call_1',content:first})
  history.push({role:'tool',tool_call_id:'call_2',content:second})
  const stats={}
  const out=renderTranscript(history,'',{maxBytes:23092,stats})
  assert.ok(out.includes(first),'537-byte output lost amid old transcript')
  assert.ok(out.includes(second),'802-byte output lost amid old transcript')
  assert.ok(out.includes('Check project files'))
  assert.ok(byteLen(out)<=23092)
  assert.ok(stats.droppedHistory>0)
})
