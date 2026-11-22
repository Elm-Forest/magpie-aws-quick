// Anthropic Messages compatibility over the Quick OpenAI tool bridge.
// Only client tool calls can reach the caller's local filesystem/terminal.
const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } })
export function anthropicErrorResponse(status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } })
}
const textOf = (parts) => typeof parts === 'string' ? parts : (Array.isArray(parts) ? parts.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : '')
const routeModel = (id) => {
  const s = String(id || '').toLowerCase()
  if (['fast','balanced','smart','advanced'].includes(s)) return s
  if (s.includes('haiku')) return 'fast'
  if (s.includes('sonnet')) return 'balanced'
  if (s.includes('opus')) return 'smart'
  return 'smart'
}
export function toOpenAIRequest(body) {
  if (!body || typeof body !== 'object' || !body.model || !Array.isArray(body.messages) || !body.messages.length) throw Error('model and messages are required')
  const messages = []
  const system = textOf(body.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const entry of body.messages) {
    const role = entry.role
    // Claude Code may put additional system turns inside messages when a
    // provider overrides the API endpoint. Preserve these instructions.
    if (role === 'system' || role === 'developer') {
      messages.push({ role: 'system', content: textOf(entry.content) })
      continue
    }
    if (role === 'tool') {
      if (!entry.tool_use_id) throw Error('tool_use_id is required')
      messages.push({role:'tool',tool_call_id:entry.tool_use_id,content:textOf(entry.content)})
      continue
    }
    if (!['user','assistant'].includes(role)) throw Error('Unsupported message role: ' + String(role))
    if (typeof entry.content === 'string') {
      messages.push({ role, content: entry.content })
      continue
    }
    if (!Array.isArray(entry.content)) throw Error('Content must be text or an array')
    const parts = []
    const calls = []
    const flush = () => {
      if (parts.length) messages.push({ role: 'user', content: parts.splice(0).join('\n') })
    }
    for (const b of entry.content) {
      if (!b || typeof b !== 'object') throw Error('Invalid content block')
      switch (b.type) {
        case 'text': parts.push(b.text || ''); break
        case 'thinking':
        case 'redacted_thinking': break
        case 'tool_use': {
          if (role !== 'assistant' || !b.name) throw Error('Invalid tool_use block')
          calls.push({ id: b.id || 'call_' + crypto.randomUUID().replaceAll('-', ''), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })
          break
        }
        case 'tool_result': {
          if (role !== 'user' || !b.tool_use_id) throw Error('Invalid tool_result block')
          flush()
          const content = textOf(b.content) || (typeof b.content === 'string' ? b.content : '')
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? '[tool error] ' + content : content })
          break
        }
        default: throw Error('Unsupported content block: ' + String(b.type))
      }
    }
    if (role === 'assistant') messages.push({ role, content: parts.join('\n'), ...(calls.length ? { tool_calls: calls } : {}) })
    else flush()
  }
  if (!messages.length || !messages.some(m => m.role === 'user' || m.role === 'tool')) throw Error('No user message')
  const tools = (body.tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || {type:'object',properties:{}} } }))
  const choice = body.tool_choice?.type
  let tool_choice
  if (choice === 'none') tool_choice = 'none'
  else if (choice === 'any') tool_choice = 'required'
  else if (choice === 'tool') tool_choice = { type: 'function', function: { name: body.tool_choice.name } }
  else if (tools.length) tool_choice = 'auto'
  const effort = body.output_config?.effort ?? body.reasoning_effort ?? body.thinking_effort
  return {
    model: routeModel(body.model), originalModel: body.model, messages,
    ...(typeof effort === 'string' ? { reasoning_effort: effort } : {}),
    stream: !!body.stream,
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length ? { tools, tool_choice } : {}),
    ...(body.tool_choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
  }
}
export function anthropicModelList(list) {
  const data = (list?.data || []).map(m => ({
    id: m.id, type: 'model', display_name: m.id, created_at: new Date().toISOString(),
  }))
  return { data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: false }
}
export function approximateTokens(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body || {}).length / 4))
}
function translateError(response, body) {
  const message = body?.error?.message || body?.message || response.statusText || 'Upstream error'
  const type = response.status === 401 ? 'authentication_error' : response.status === 429 ? 'rate_limit_error' : response.status === 400 ? 'invalid_request_error' : 'api_error'
  return anthropicErrorResponse(response.status, type, message)
}
export async function toAnthropicResponse(response, originalModel) {
  if (!response.ok) {
    let parsed = {}
    try { parsed = await response.json() } catch {}
    return translateError(response, parsed)
  }
  const value = await response.json()
  const first = value?.choices?.[0]
  if (!first) return anthropicErrorResponse(502, 'api_error', 'Missing chat completion')
  const blocks = []
  const text = first.message?.content
  if (text) blocks.push({ type: 'text', text })
  for (const call of first.message?.tool_calls || []) {
    let input = {}
    try { input = JSON.parse(call.function?.arguments || '{}') } catch {}
    blocks.push({ type: 'tool_use', id: call.id || 'toolu_' + crypto.randomUUID().replaceAll('-',''), name: call.function?.name || 'unknown', input })
  }
  const reason = blocks.some(x=>x.type==='tool_use') ? 'tool_use' : first.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
  return json({
    id: 'msg_' + crypto.randomUUID().replaceAll('-',''), type: 'message', role: 'assistant', model: originalModel,
    content: blocks, stop_reason: reason, stop_sequence: null,
    usage: { input_tokens: value.usage?.prompt_tokens || 0, output_tokens: value.usage?.completion_tokens || 0 },
  })
}
export function toAnthropicStream(response, model) {
  if (!response.ok) return response
  const encoder = new TextEncoder()
  const source = response.body
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event, body) => controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(body) + '\n\n'))
      let block = -1, active = -1, stop = 'end_turn', count = {input_tokens:0,output_tokens:0}, failed = false
      const close = () => { if (active >= 0) {emit('content_block_stop',{type:'content_block_stop',index:active});active=-1} }
      emit('message_start',{ type:'message_start',message:{id:'msg_'+crypto.randomUUID().replaceAll('-',''),type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:count}})
      const writeText = (value) => {
        if (!value) return
        if (active < 0) {block++;active=block;emit('content_block_start',{type:'content_block_start',index:active,content_block:{type:'text',text:''}})}
        emit('content_block_delta',{type:'content_block_delta',index:active,delta:{type:'text_delta',text:value}})
      }
      try {
        let pending = ''
        const decoder = new TextDecoder()
        for await (const bytes of source) {
          pending += decoder.decode(bytes,{stream:true})
          let end
          while ((end=pending.indexOf('\n\n'))>=0) {
            const frame=pending.slice(0,end);pending=pending.slice(end+2)
            const line=frame.split('\n').find(x=>x.startsWith('data:'))
            if (!line) continue
            const raw=line.slice(5).trim()
            if (raw==='[DONE]') continue
            let chunk
            try {chunk=JSON.parse(raw)} catch {continue}
            if (chunk.error) {
              emit('error',{type:'error',error:{type:'api_error',message:chunk.error.message||'Upstream error'}})
              failed=true;break
            }
            if (chunk.usage) {count={input_tokens:chunk.usage.prompt_tokens||0,output_tokens:chunk.usage.completion_tokens||0}}
            for (const choice of chunk.choices || []) {
              const delta=choice.delta || {}
              if (delta.content) writeText(delta.content)
              if (delta.tool_calls?.length) {
                close()
                for (const call of delta.tool_calls) {
                  block++
                  const index=block
                  emit('content_block_start',{type:'content_block_start',index,content_block:{type:'tool_use',id:call.id||'toolu_'+crypto.randomUUID().replaceAll('-',''),name:call.function?.name||'unknown',input:{}}})
                  const arg=call.function?.arguments||'{}'
                  emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:arg}})
                  emit('content_block_stop',{type:'content_block_stop',index})
                  stop='tool_use'
                }
              }
              if (choice.finish_reason==='tool_calls') stop='tool_use'
              if (choice.finish_reason==='length') stop='max_tokens'
            }
          }
          if (failed) break
        }
        if (!failed) {
          close()
          emit('message_delta',{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:count.output_tokens}})
          emit('message_stop',{type:'message_stop'})
        }
      } catch(e) {
        emit('error',{type:'error',error:{type:'api_error',message:String(e?.message||e)}})
      } finally {controller.close()}
    },
  })
  return new Response(stream, { status:200, headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'} })
}
