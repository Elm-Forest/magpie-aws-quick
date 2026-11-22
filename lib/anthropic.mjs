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
/**
 * Convert OpenAI SSE chunks into Anthropic block events with a persistent
 * tool_call index -> content block mapping.
 *
 * Adapted conceptually from the MIT-licensed copilot-api state machine:
 * streamed function arguments are fragments, not independent tool_use calls.
 * Never reopen an already-finished block or emit one block per fragment.
 */
export function toAnthropicStream(response, model) {
  if (!response.ok) return response
  const encoder=new TextEncoder()
  const stream=new ReadableStream({
    async start(controller) {
      const emit=(event,data)=>controller.enqueue(encoder.encode(
        'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n'))
      let nextBlock=0
      let active=null
      let stopReason='end_turn'
      let usage={input_tokens:0,output_tokens:0}
      const seenTools=new Map()

      const closeBlock=()=>{
        if(active) {
          emit('content_block_stop',{type:'content_block_stop',index:active.index})
          if(active.kind==='tool')seenTools.get(active.toolIndex).closed=true
          active=null
        }
      }
      const ensureText=()=>{
        if(active?.kind==='text')return
        closeBlock()
        active={kind:'text',index:nextBlock++}
        emit('content_block_start',{type:'content_block_start',index:active.index,
          content_block:{type:'text',text:''}})
      }
      const emitText=(value)=>{
        if(!value)return
        ensureText()
        emit('content_block_delta',{type:'content_block_delta',index:active.index,
          delta:{type:'text_delta',text:value}})
      }
      const emitTool=(call)=>{
        const key=Number.isInteger(call.index) ? call.index : seenTools.size
        let state=seenTools.get(key)
        if(!state) {
          // Some OpenAI providers send a name/id in the first delta and only
          // argument fragments thereafter. Retain the original block index.
          state={id:call.id||'toolu_'+crypto.randomUUID().replaceAll('-',''),
            name:call.function?.name||'unknown',
            index:nextBlock++,closed:false}
          if(active)closeBlock()
          active={kind:'tool',index:state.index,toolIndex:key}
          seenTools.set(key,state)
          emit('content_block_start',{type:'content_block_start',index:state.index,
            content_block:{type:'tool_use',id:state.id,name:state.name,input:{}}})
        } else if(state.closed) {
          throw new Error('Tool-call arguments arrived after the tool block was closed')
        } else if(active?.kind!=='tool'||active.toolIndex!==key) {
          closeBlock()
          active={kind:'tool',index:state.index,toolIndex:key}
        }
        if(call.function?.arguments) {
          emit('content_block_delta',{type:'content_block_delta',index:state.index,
            delta:{type:'input_json_delta',partial_json:call.function.arguments}})
        }
        stopReason='tool_use'
      }
      emit('message_start',{type:'message_start',message:{
        id:'msg_'+crypto.randomUUID().replaceAll('-',''),type:'message',
        role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
        usage:{input_tokens:0,output_tokens:0},
      }})
      try {
        let buffer=''
        const decoder=new TextDecoder()
        const parseFrame=(frame)=>{
          const lines=frame.split('\n').filter(x=>x.startsWith('data:'))
          if(!lines.length)return
          const raw=lines.map(line=>line.slice(5).trimStart()).join('\n').trim()
          if(!raw||raw==='[DONE]')return
          let chunk
          try{chunk=JSON.parse(raw)}catch{throw new Error('Invalid OpenAI SSE data')}
          if(chunk.error) {
            throw new Error(chunk.error.message||'Upstream stream error')
          }
          if(chunk.usage)usage={
            input_tokens:chunk.usage.prompt_tokens||0,
            output_tokens:chunk.usage.completion_tokens||0,
          }
          for(const choice of chunk.choices||[]) {
            const delta=choice.delta||{}
            if(delta.content)emitText(delta.content)
            for(const call of delta.tool_calls||[])emitTool(call)
            if(choice.finish_reason==='tool_calls')stopReason='tool_use'
            else if(choice.finish_reason==='length')stopReason='max_tokens'
          }
        }
        for await(const bytes of response.body) {
          buffer+=decoder.decode(bytes,{stream:true})
          buffer=buffer.replace(/\r\n/g,'\n')
          let at
          while((at=buffer.indexOf('\n\n'))>=0) {
            parseFrame(buffer.slice(0,at))
            buffer=buffer.slice(at+2)
          }
        }
        buffer+=decoder.decode()
        if(buffer.trim())parseFrame(buffer.trim())
        closeBlock()
        emit('message_delta',{type:'message_delta',
          delta:{stop_reason:stopReason,stop_sequence:null},
          usage:{output_tokens:usage.output_tokens}})
        emit('message_stop',{type:'message_stop'})
      }catch(e){
        emit('error',{type:'error',error:{
          type:'api_error',message:String(e?.message||e),
        }})
      }finally {
        controller.close()
      }
    },
  })
  return new Response(stream,{status:200,headers:{
    'content-type':'text/event-stream; charset=utf-8',
    'cache-control':'no-cache',
  }})
}
