import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createProxyServer } from '../bin/serve.mjs'
import { startFakeQuick } from './helpers/fake-quick.mjs'
import { toOpenAIRequest } from '../lib/anthropic.mjs'

const baseHeaders = { 'content-type':'application/json', 'x-api-key':'local-test', 'anthropic-version':'2023-06-01' }
async function withServer(run) {
  const fake=await startFakeQuick()
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
