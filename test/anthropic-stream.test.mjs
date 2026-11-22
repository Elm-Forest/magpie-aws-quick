import {test} from 'node:test'
import assert from 'node:assert/strict'
import {toAnthropicStream} from '../lib/anthropic.mjs'

function makeOpenAiStream(chunks, chunkSize=7) {
  const raw=chunks.map(x=>'data: '+JSON.stringify(x)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n'
  const bytes=new TextEncoder().encode(raw)
  let offset=0
  return new Response(new ReadableStream({
    pull(controller) {
      if(offset>=bytes.length){controller.close();return}
      controller.enqueue(bytes.slice(offset,offset+chunkSize))
      offset+=chunkSize
    },
  }),{headers:{'content-type':'text/event-stream'}})
}
async function events(response) {
  const text=await response.text()
  return text.split('\n\n').filter(Boolean).map(frame=>{
    const e=frame.match(/^event: ([^\n]+)/m)
    const d=frame.match(/^data: (.+)$/m)
    return {event:e?.[1],data:d?JSON.parse(d[1]):null}
  })
}
test('split tool arguments open one Anthropic tool_use block with exact JSON fragments',async()=>{
  const chunks=[
    {choices:[{delta:{role:'assistant',content:'Checking files.'},finish_reason:null}]},
    {choices:[{delta:{tool_calls:[{index:0,id:'call_1',function:{name:'Read',arguments:'{"file_'}}]},finish_reason:null}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'path":"/tmp/'}}]},finish_reason:null}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'research.txt"}'}}]},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:79,completion_tokens:12}},
  ]
  const parsed=await events(toAnthropicStream(makeOpenAiStream(chunks,3),'claude-opus-5'))
  const starts=parsed.filter(x=>x.event==='content_block_start')
  assert.equal(starts.length,2)
  assert.equal(starts[0].data.content_block.type,'text')
  assert.equal(starts[1].data.content_block.type,'tool_use')
  assert.equal(starts[1].data.content_block.name,'Read')
  assert.equal(starts[1].data.content_block.id,'call_1')
  const json=parsed.filter(x=>x.data?.delta?.type==='input_json_delta').map(x=>x.data.delta.partial_json).join('')
  assert.deepEqual(JSON.parse(json),{file_path:'/tmp/research.txt'})
  assert.equal(parsed.filter(x=>x.event==='content_block_stop').length,2)
  assert.equal(parsed.find(x=>x.event==='message_delta').data.delta.stop_reason,'tool_use')
  assert.equal(parsed.at(-1).event,'message_stop')
  assert.equal(parsed.find(x=>x.event==='message_delta').data.usage.output_tokens,12)
})
test('two streamed tools retain distinct ids and sorted block indices',async()=>{
  const chunks=[
    {choices:[{delta:{tool_calls:[{index:0,id:'c0',function:{name:'Read',arguments:'{"path":"a"}'}}]},finish_reason:null}]},
    {choices:[{delta:{tool_calls:[{index:1,id:'c1',function:{name:'Bash',arguments:'{"command":"pwd"}'}}]},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'tool_calls'}]},
  ]
  const parsed=await events(toAnthropicStream(makeOpenAiStream(chunks,11),'claude-opus-5'))
  const starts=parsed.filter(x=>x.event==='content_block_start')
  assert.deepEqual(starts.map(x=>x.data.content_block.name),['Read','Bash'])
  assert.deepEqual(starts.map(x=>x.data.index),[0,1])
  assert.deepEqual(parsed.filter(x=>x.event==='content_block_stop').map(x=>x.data.index),[0,1])
})
test('upstream streaming error is sent as Anthropic error without a successful stop',async()=>{
  const chunks=[
    {choices:[{delta:{content:'working'},finish_reason:null}]},
    {error:{message:'upstream cancelled'}},
  ]
  const parsed=await events(toAnthropicStream(makeOpenAiStream(chunks,7),'claude-opus-5'))
  assert.equal(parsed.at(-1).event,'error')
  assert.match(parsed.at(-1).data.error.message,/upstream cancelled/)
  assert.ok(!parsed.some(x=>x.event==='message_stop'))
})
