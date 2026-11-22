import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createProxyServer } from '../bin/serve.mjs'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.mjs'
import { toOpenAIRequest } from '../lib/anthropic.mjs'

const baseHeaders = { 'content-type':'application/json', 'x-api-key':'local-test', 'anthropic-version':'2023-06-01' }
async function withServer(run, script) {
  const fake=await startFakeQuick({script:script || ((payload)=>{
    if (!String(payload.text||'').startsWith('[CLIENT TOOL DATA TRANSFER')) return defaultScript(payload)
    return [
      {type:'message_start',payload:{message_id:payload.message_id}},
      {type:'text_delta',payload:{delta:'ACK'}},
      {type:'message_complete',payload:{text:'ACK',message_id:payload.message_id}},
    ]
  })})
  const mgr={ensure:async()=>({
    outpostId:async()=> 'test-device',
    session:async()=>({ws_host:fake.wsHost,id_token:'test-jwt',actor_arn:'arn:test',provider:'social',aws_account_id:'123',usable_until:Math.floor(Date.now()/1000)+600}),
  })}
  const server=createProxyServer({token:'local-test',outpostMgr:mgr,oauthStore:{list:()=>[]},options:{}})
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const url='http://127.0.0.1:'+server.address().port
  try {await run(url,fake)} finally {await new Promise(done=>server.close(done));await fake.close()}
}
test('Anthropic models response and unauthorized rejection',async()=>{
  await withServer(async url=>{
    let res=await fetch(url+'/v1/models',{headers:{'anthropic-version':'2023-06-01'}})
    assert.equal(res.status,401)
    res=await fetch(url+'/v1/models',{headers:baseHeaders})
    const models=await res.json()
    assert.equal(res.status,200)
    assert.equal(models.has_more,false)
    assert.equal(models.data.length,4)
    assert.equal(models.data[0].type,'model')
    res=await fetch(url+'/v1/models',{headers:{authorization:'Bearer local-test'}})
    assert.equal((await res.json()).object,'list')
  })
})
test('Anthropic non-stream, stream, and local tool bridge',async()=>{
  await withServer(async(url)=>{
    const question={model:'claude-opus-4-5',max_tokens:100,messages:[{role:'user',content:'test'}]}
    const res=await fetch(url+'/v1/messages',{method:'POST',headers:baseHeaders,body:JSON.stringify(question)})
    const data=await res.json()
    assert.equal(res.status,200)
    assert.equal(data.type,'message')
    assert.equal(data.role,'assistant')
    assert.ok(data.content.some(x=>x.type==='text'))
    const streaming=await fetch(url+'/v1/messages',{method:'POST',headers:baseHeaders,body:JSON.stringify({...question,stream:true})})
    const events=await streaming.text()
    assert.equal(streaming.status,200)
    for(const name of ['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']){
      assert.ok(events.includes('event: '+name), 'missing '+name)
    }
  })
})
test('tool_use and tool_result conversion preserve local tool calls',()=>{
  const output=toOpenAIRequest({
    model:'claude-3-7-sonnet-latest',max_tokens:512,
    tools:[{name:'read_file',input_schema:{type:'object',properties:{path:{type:'string'}}}}],
    messages:[
      {role:'user',content:'read /tmp/sample.txt'},
      {role:'assistant',content:[{type:'tool_use',id:'toolu_1',name:'read_file',input:{path:'/tmp/sample.txt'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_1',content:'file contents'}]},
    ],
  })
  assert.equal(output.model,'balanced')
  assert.equal(output.messages[1].role,'assistant')
  assert.equal(output.messages[1].tool_calls[0].function.name,'read_file')
  assert.equal(output.messages[2].role,'tool')
  assert.equal(output.messages[2].tool_call_id,'toolu_1')
  assert.equal(output.messages[2].name,'read_file')
})
test('token count and bad message JSON',async()=>{
  await withServer(async url=>{
    let res=await fetch(url+'/v1/messages/count_tokens',{method:'POST',headers:baseHeaders,body:JSON.stringify({messages:[]})})
    assert.equal(res.status,200)
    assert.ok((await res.json()).estimated)
    res=await fetch(url+'/v1/messages',{method:'POST',headers:baseHeaders,body:'{invalid'})
    assert.equal(res.status,400)
  })
})

test('Claude Code-injected system messages are accepted',()=>{
  const result=toOpenAIRequest({
    model:'claude-opus-4-5',
    messages:[
      {role:'user',content:[{type:'text',text:'hello'}]},
      {role:'system',content:[{type:'text',text:'You are an assistant with local tools'}]},
    ],
  })
  assert.equal(result.messages.length,2)
  assert.equal(result.messages[1].role,'system')
  assert.match(result.messages[1].content,/local tools/)
})


test('OAuth account route uses direct Quick websocket backend', async () => {
  const fake = await startFakeQuick()
  const record = {
    jwt: 'fake-session-jwt',
    ws_host: fake.wsHost,
    actor_arn: 'arn:test',
    provider: 'social',
    usable_until: Math.floor(Date.now() / 1000) + 3600,
  }
  const store = {
    list: () => ['oauth-test'],
    get: () => record,
    set: (_key, session) => Object.assign(record, session),
  }
  const server = createProxyServer({ oauthStore: store, token: 'oauth-test-key' })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const url = 'http://127.0.0.1:' + server.address().port
    const res = await fetch(url + '/v1/messages', {
      method: 'POST',
      headers: {'content-type':'application/json', 'x-api-key':'oauth-test-key'},
      body: JSON.stringify({model:'smart',messages:[{role:'user',content:'hello'}]}),
    })
    const answer = await res.json()
    assert.equal(res.status, 200)
    assert.equal(answer.type, 'message')
    assert.ok(answer.content.length > 0)
  } finally {
    await new Promise(done => server.close(done))
    await fake.close()
  }
})


test('112 tools + long system prompt + parallel results keep short output and high effort', async () => {
  await withServer(async (url, fake) => {
    const names = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'ListAgents']
    const tools = Array.from({ length: 112 }, (_, i) => {
      const name = names[i] || 'integration_tool_' + i
      return {
        name,
        description: 'Task-related tool ' + i + ' ' + 'schema documentation '.repeat(15),
        input_schema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {type:'string',description:'local target path'},
            command: {type:'string'},
            content: {type:'string'},
            parameter1: {type:'string'},
          },
        },
      }
    })
    const small = 'SHORT-163-' + 'x'.repeat(153)
    assert.equal(small.length, 163)
    const body = {
      model: 'claude-opus-5',
      max_tokens: 500,
      output_config: {effort:'high'},
      system: [{type:'text',text:'You are working on a research paper. ' + 'S'.repeat(31000)}],
      tools,
      messages: [
        {role:'user',content:'Review the paper and check all tool results.'},
        {role:'assistant',content: [
          {type:'tool_use',id:'tool_1',name:'Bash',input:{command:'a'}},
          {type:'tool_use',id:'tool_2',name:'Read',input:{path:'b'}},
          {type:'tool_use',id:'tool_3',name:'Bash',input:{command:'c'}},
          {type:'tool_use',id:'tool_4',name:'Bash',input:{command:'d'}},
        ]},
        {role:'user',content: [
          {type:'tool_result',tool_use_id:'tool_1',content:'HEAD1:'+'A'.repeat(23120)+':TAIL1'},
          {type:'tool_result',tool_use_id:'tool_2',content:'HEAD2:'+'B'.repeat(18455)+':TAIL2'},
          {type:'tool_result',tool_use_id:'tool_3',content:'HEAD3:'+'C'.repeat(29391)+':TAIL3'},
          {type:'tool_result',tool_use_id:'tool_4',content:small},
        ]},
      ],
    }
    const res = await fetch(url+'/v1/messages', {
      method:'POST',headers:baseHeaders,body:JSON.stringify(body),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).type, 'message')
    const frame = fake.state.userMessages.at(-1).payload
    assert.equal(frame.agent_mode,'smart')
    assert.equal(frame.thinking_effort,'high')
    assert.ok(frame.text.includes(small),'short tool output lost during parallel compression')
    assert.ok(frame.text.includes('Review the paper'))
    assert.ok(frame.text.includes('Bash') && frame.text.includes('Read') && frame.text.includes('args {'))
    const transfer=fake.state.userMessages.slice(0,-1)
      .filter(x=>x.payload.text.startsWith('[CLIENT TOOL DATA TRANSFER'))
    assert.ok(transfer.length>=3,'large results should use upstream staged delivery')
    const chunks=transfer.map(x=>x.payload.text).join('\n')
    for(const proof of ['HEAD1:',':TAIL1','HEAD2:',':TAIL2','HEAD3:',':TAIL3'])
      assert.ok(chunks.includes(proof),proof)
    assert.ok(frame.text.includes('preceding Quick message'), 'final turn must reference staged results')
    assert.equal(new Set([...transfer,fake.state.userMessages.at(-1)].map(x=>x.threadId)).size,1,
      'all frames must share one upstream Quick thread')
    assert.ok(transfer.every(x=>new TextEncoder().encode(x.payload.text).length<=24*1024))
    assert.ok(new TextEncoder().encode(frame.text).length + new TextEncoder().encode(frame.system_prompt).length <= 62*1024)
  })
})


test('512 KiB client output survives Anthropic HTTP -> bounded Quick relay unmodified',async()=>{
  await withServer(async(url,fake)=>{
    const header='LARGE-512KB-START\n'
    const tail='\nLARGE-512KB-END'
    const payload=header+'汉字'.repeat(20000)+'Y'.repeat(512*1024-Buffer.byteLength(header+'汉字'.repeat(20000)+tail,'utf8'))+tail
    assert.equal(Buffer.byteLength(payload,'utf8'),512*1024)
    const question={
      model:'claude-opus-5',max_tokens:300,
      system:'Check file contents',
      messages:[
        {role:'user',content:'Read the following tool result fully'},
        {role:'assistant',content:[{type:'tool_use',id:'large_result',name:'Read',input:{file_path:'large'}}]},
        {role:'user',content:[{type:'tool_result',tool_use_id:'large_result',content:payload}]},
      ],
    }
    const response=await fetch(url+'/v1/messages',{
      method:'POST',headers:baseHeaders,body:JSON.stringify(question),
    })
    assert.equal(response.status,200)
    const data=await response.json()
    assert.equal(data.type,'message')
    const frames=fake.state.userMessages
      .filter(x=>x.payload.text.startsWith('[CLIENT TOOL DATA TRANSFER'))
    assert.ok(frames.length>=25)
    assert.equal(new Set(fake.state.userMessages.map(x=>x.threadId)).size,1)
    const recovered=[]
    for(const frame of frames) {
      assert.ok(Buffer.byteLength(frame.payload.text,'utf8')<=24*1024)
      const parts=frame.payload.text.matchAll(
        /\[tool_result Read large_result part \d+\/\d+\]\n([\s\S]*?)\n\[\/tool_result\]/g)
      for(const part of parts)recovered.push(part[1])
    }
    assert.equal(recovered.join(''),payload)
    assert.ok(fake.state.userMessages.at(-1).payload.text.includes('preceding Quick message'))
    assert.ok(!fake.state.userMessages.at(-1).payload.text.includes('TRUNCATED 524288'))
  })
})

test('Desktop CC Switch OpenAI route: long session keeps both latest results without PARTIAL',async()=>{
  await withServer(async (url,fake)=>{
    const old=[]
    for(let i=0;i<45;i++) {
      old.push({role:'user',content:'Research note '+i})
      old.push({role:'assistant',content:null,tool_calls:[{
        type:'function',id:'old_'+i,function:{name:'Bash',arguments:'{}'},
      }]})
      old.push({role:'tool',tool_call_id:'old_'+i,content:JSON.stringify([
        {type:'text',text:'OLD_LOG_'+i+' '+('x'.repeat(1700))},
      ])})
      old.push({role:'assistant',content:'Historical result handled'})
    }
    const long='CURRENT_300_LINE_PROOF_START\n'+Array.from({length:300},(_,i)=>
      'N'+String(i+1).padStart(3,'0')+':'+'L'.repeat(49)).join('\n')+'\nCURRENT_300_LINE_PROOF_END'
    const short='CURRENT_60_LINE_PROOF_START\n'+Array.from({length:60},(_,i)=>
      'M'+String(i+1).padStart(3,'0')+':'+'S'.repeat(49)).join('\n')+'\nCURRENT_60_LINE_PROOF_END'
    const longSerialized=JSON.stringify([{type:'text',text:long}])
    const shortSerialized=JSON.stringify([{type:'text',text:short}])
    const tools=Array.from({length:112},(_,i)=>({
      type:'function',
      function:{name:'tool_'+i,description:'Local research tool '+i,
        parameters:{type:'object',properties:{command:{type:'string'}}}},
    }))
    const body={
      model:'smart',stream:false,max_tokens:256,reasoning_effort:'high',
      tools, messages:[
        {role:'system',content:'Paper writing assistant '+('Q'.repeat(31000))},
        ...old,
        {role:'user',content:'Inspect both current command outputs, retaining all lines.'},
        {role:'assistant',content:null,tool_calls:[
          {type:'function',id:'current_300',function:{name:'Bash',arguments:'{}'}},
          {type:'function',id:'current_60',function:{name:'Bash',arguments:'{}'}},
        ]},
        {role:'tool',tool_call_id:'current_300',content:longSerialized},
        {role:'tool',tool_call_id:'current_60',content:shortSerialized},
      ],
    }
    const response=await fetch(url+'/v1/chat/completions',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':'Bearer local-test'},
      body:JSON.stringify(body),
    })
    const json=await response.json()
    assert.equal(response.status,200,JSON.stringify(json).slice(0,300))
    const msgs=fake.state.userMessages
    const final=msgs.at(-1).payload.text
    const relays=msgs.filter(x=>x.payload.text.startsWith('[CLIENT TOOL DATA TRANSFER'))
    const upstream=[final,...relays.map(x=>x.payload.text)].join('\n')
    assert.ok(!upstream.includes('OLD_LOG_'),'stale output replayed')
    assert.ok(!upstream.includes('[PARTIAL TOOL RESULT:'),'partial injected')
    assert.ok(!upstream.includes('[TRUNCATED '),'truncated marker injected')
    assert.ok(!upstream.includes('[tool_result old_'),'old output leaked')
    for(const [id,content] of [['current_300',longSerialized],['current_60',shortSerialized]]) {
      const found=final.includes(content)||relays.some(x=>x.payload.text.includes(content))
        || relays.some(x=>x.payload.text.includes(id)&&x.payload.text.includes(id==='current_300'?'CURRENT_300_LINE_PROOF_START':'CURRENT_60_LINE_PROOF_START'))
      assert.ok(found,'current result '+id+' was lost')
    }
    assert.ok(relays.length>=1)
    assert.equal(new Set(msgs.map(x=>x.threadId)).size,1)
  })
})

test('OpenAI Chat / Claude Desktop: choice markup becomes readable Markdown in stream and nonstream',async()=>{
  const raw=[
    '论文已核查。',
    '',
    '<decision question="接下来怎么办？">',
    '<option description="先确认数据再继续">继续修改论文</option>',
    '<option>仅汇报结果</option>',
    '</decision>',
  ].join('\n')
  const script=(payload)=>{
    const parts=[]
    for(let i=0;i<raw.length;i+=2)parts.push({type:'text_delta',payload:{delta:raw.slice(i,i+2)}})
    return [
      {type:'message_start',payload:{message_id:payload.message_id}},
      ...parts,
      {type:'message_complete',payload:{text:raw,message_id:payload.message_id}},
    ]
  }
  await withServer(async(url,fake)=>{
    const headers={authorization:'Bearer local-test','content-type':'application/json'}
    for(const stream of [false,true]) {
      const response=await fetch(url+'/v1/chat/completions',{
        method:'POST',headers,
        body:JSON.stringify({model:'smart',stream,messages:[{role:'user',content:'继续论文任务'}]}),
      })
      assert.equal(response.status,200)
      let visible
      if(stream){
        const sse=await response.text()
        visible=sse.split('\n').filter(x=>x.startsWith('data: ') && x!=='data: [DONE]')
          .map(x=>JSON.parse(x.slice(6)).choices?.[0]?.delta?.content??'').join('')
      }else visible=(await response.json()).choices[0].message.content
      assert.ok(visible.includes('论文已核查。'))
      assert.ok(visible.includes('**接下来怎么办？**'))
      assert.ok(visible.includes('- 继续修改论文 — 先确认数据再继续'))
      assert.ok(visible.includes('- 仅汇报结果'))
      assert.ok(!visible.includes('<decision'))
      assert.ok(!visible.includes('<option'))
      assert.ok(!visible.includes('</decision>'))
      assert.ok(fake.state.userMessages.at(-1).payload.custom_prompt.includes('NEVER emit XML-like interface tags'))
    }
  },script)
})

test('Anthropic Messages streaming: decision filter preserves protocol events',async()=>{
  const raw='Done.\n<decision question="下一步？"><option>继续</option></decision>'
  const script=(payload)=>[
    {type:'message_start',payload:{message_id:payload.message_id}},
    {type:'text_delta',payload:{delta:raw.slice(0,12)}},
    {type:'text_delta',payload:{delta:raw.slice(12,25)}},
    {type:'text_delta',payload:{delta:raw.slice(25)}},
    {type:'message_complete',payload:{text:raw,message_id:payload.message_id}},
  ]
  await withServer(async(url)=>{
    const response=await fetch(url+'/v1/messages',{
      method:'POST',headers:baseHeaders,
      body:JSON.stringify({model:'claude-opus-5',max_tokens:150,stream:true,
        messages:[{role:'user',content:'下一步'}]}),
    })
    assert.equal(response.status,200)
    const content=await response.text()
    for(const tag of ['event: message_start','event: content_block_delta','event: message_stop'])assert.ok(content.includes(tag))
    assert.ok(content.includes('**下一步？**'))
    assert.ok(!content.includes('<decision'))
  },script)
})

test('client function-call markers remain proper OpenAI tool_calls while decision markup is normalized',async()=>{
  const raw=[
    '<tool_call>{"name":"Read","arguments":{"file_path":"main.tex"}}</tool_call>',
    '<decision question="修改？"><option>继续检查</option></decision>',
  ].join('\n')
  const script=(payload)=>[
    {type:'message_start',payload:{message_id:payload.message_id}},
    {type:'text_delta',payload:{delta:raw.slice(0,14)}},
    {type:'text_delta',payload:{delta:raw.slice(14,61)}},
    {type:'text_delta',payload:{delta:raw.slice(61)}},
    {type:'message_complete',payload:{text:raw,message_id:payload.message_id}},
  ]
  await withServer(async(url)=>{
    const response=await fetch(url+'/v1/chat/completions',{
      method:'POST',headers:{authorization:'Bearer local-test','content-type':'application/json'},
      body:JSON.stringify({model:'smart',max_tokens:200,
        tools:[{type:'function',function:{name:'Read',parameters:{type:'object',properties:{file_path:{type:'string'}}}}}],
        messages:[{role:'user',content:'Read my paper'}]}),
    })
    assert.equal(response.status,200)
    const answer=await response.json()
    const choice=answer.choices[0]
    assert.equal(choice.finish_reason,'tool_calls')
    assert.equal(choice.message.tool_calls[0].function.name,'Read')
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments),{file_path:'main.tex'})
    assert.ok(choice.message.content.includes('**修改？**'))
    assert.ok(!choice.message.content.includes('<decision'))
  },script)
})
