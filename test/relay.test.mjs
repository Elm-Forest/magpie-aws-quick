import {test} from 'node:test'
import assert from 'node:assert/strict'
import {planToolRelay,deliverToolRelay,RELAY_FRAME_LIMIT} from '../lib/relay.mjs'
import {byteLen} from '../lib/translate.mjs'
import {startFakeQuick,defaultScript} from './helpers/fake-quick.mjs'
import {QuickSocket} from '../lib/quickws.mjs'

test('a pair of small tool results is not needlessly relayed',()=>{
  const results=[
    {role:'tool',tool_call_id:'one',content:'A'.repeat(537)},
    {role:'tool',tool_call_id:'two',content:'B'.repeat(802)},
  ]
  assert.equal(planToolRelay(results,23000),null)
})

test('relays oversized tool outputs in exact bounded Unicode-safe parts',()=>{
  const a='中文论文😀'.repeat(11000)
  const b='IMPORTANT_HEADER_'+'C'.repeat(75000)+'_TRAILER'
  const tools=[
    {role:'tool',tool_call_id:'call_a',name:'Read',content:a},
    {role:'tool',tool_call_id:'call_b',name:'Bash',content:b},
    {role:'tool',tool_call_id:'call_small',name:'Bash',content:'RESULT_OK_163'},
  ]
  const plan=planToolRelay(tools,23500)
  assert.ok(plan)
  assert.ok(plan.frames.length>=6)
  assert.ok(plan.frames.every(x=>byteLen(x)<=RELAY_FRAME_LIMIT))
  assert.equal(plan.replacements.has(tools[2]),false,'short result should stay inline')
  const getParts=(id)=>{
    const parts=[]
    for(const frame of plan.frames) {
      const re=/\[tool_result ([^\]\n]+)\]\n([\s\S]*?)\n\[\/tool_result\]/g
      for(const match of frame.matchAll(re)) {
        if(match[1].includes(' '+id+' part '))parts.push(match[2])
      }
    }
    return parts.join('')
  }
  assert.equal(getParts('call_a'),a)
  assert.equal(getParts('call_b'),b)
  assert.ok(plan.replacements.get(tools[0]).includes('preceding Quick'))
})

test('large outputs beyond the guarded relay cap get an explicit error',()=>{
  const tooBig=[{role:'tool',tool_call_id:'huge',content:'X'.repeat(2*1024*1024+1)}]
  assert.throws(()=>planToolRelay(tooBig,23500),e=>e.status===413)
})

test('transfer frames require upstream ACK and never pass silent failures',async()=>{
  const fake=await startFakeQuick({script:(p)=>{
    if(!String(p.text).startsWith('[CLIENT TOOL DATA TRANSFER'))return defaultScript(p)
    return [
      {type:'text_delta',payload:{delta:'NO'}},
      {type:'message_complete',payload:{text:'NO',message_id:p.message_id}},
    ]
  }})
  const ws=new QuickSocket({
    getSession:async()=>({ws_host:fake.wsHost,id_token:'test-jwt',usable_until:Math.floor(Date.now()/1000)+600}),
    outpostId:'test-device',extra:{surfaceType:'QUICK_WORK_DESKTOP_WINDOWS',appVersion:'1.2.4660'},
  })
  try{
    await assert.rejects(
      deliverToolRelay(ws,crypto.randomUUID(),['[CLIENT TOOL DATA TRANSFER 1/1]\nDATA'],{mode:'smart'}),
      /did not acknowledge/)
  }finally{await ws.close();await fake.close()}
})


test('a superficially positive but non-ACK response fails closed',async()=>{
  const fake=await startFakeQuick({script:(p)=>[
    {type:'text_delta',payload:{delta:'ACK but I did not read the data'}},
    {type:'message_complete',payload:{text:'ACK but I did not read the data',message_id:p.message_id}},
  ]})
  const ws=new QuickSocket({
    getSession:async()=>({ws_host:fake.wsHost,id_token:'test-jwt',usable_until:Math.floor(Date.now()/1000)+600}),
    outpostId:'test-device',extra:{surfaceType:'QUICK_WORK_DESKTOP_WINDOWS',appVersion:'1.2.4660'},
  })
  try {
    await assert.rejects(deliverToolRelay(ws,crypto.randomUUID(),[
      '[CLIENT TOOL DATA TRANSFER 1/1]\nDATA',
    ],{mode:'smart'}),/did not acknowledge/)
  }finally{await ws.close();await fake.close()}
})


test('packs 100 medium-size tool results into a handful of Quick turns',()=>{
  const tools=Array.from({length:100},(_,i)=>({
    role:'tool',name:'Bash',tool_call_id:'many_'+i,content:'ROW_'+i+'_'+String(i).padStart(3,'0')+'X'.repeat(540),
  }))
  const plan=planToolRelay(tools,23000)
  assert.ok(plan)
  assert.ok(plan.frames.length<=5,'packing failed: '+plan.frames.length+' turns')
  assert.ok(plan.frames.every(x=>byteLen(x)<=RELAY_FRAME_LIMIT))
  const packed=plan.frames.join('\n')
  for(const tool of tools) {
    if(plan.replacements.has(tool))
      assert.ok(packed.includes(tool.content),'lost packed result '+tool.tool_call_id)
  }
  assert.ok(plan.replacements.size>=70)
})
