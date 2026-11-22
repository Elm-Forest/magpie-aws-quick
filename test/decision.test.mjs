import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createDecisionOutputFilter,renderDecisionBlock} from '../lib/decision.mjs'

const example = [
 '这次是真的好了。两条检查结果都完整.',
 '',
 '<decision question="接下来怎么办？">',
 '<option description="通过自测后继续任务，不要改无关文件">让代理先自测，通过就继续</option>',
 '<option description="只测试并汇报">只让代理自测，先不开工</option>',
 '<option>先等代理汇报</option>',
 '</decision>',
].join('\n')
const expected = [
 '这次是真的好了。两条检查结果都完整.',
 '',
 '**接下来怎么办？**',
 '- 让代理先自测，通过就继续 — 通过自测后继续任务，不要改无关文件',
 '- 只让代理自测，先不开工 — 只测试并汇报',
 '- 先等代理汇报',
].join('\n')

test('render a complete decision block as readable Markdown options',()=>{
  const raw=example.slice(example.indexOf('<decision'))
  assert.equal(renderDecisionBlock(raw),expected.slice(expected.indexOf('**接下来')))
})

test('streaming filter handles decision tags split at every character',()=>{
  const f=createDecisionOutputFilter()
  let got=''
  for(const char of example)got+=f.push(char)
  got+=f.end()
  assert.equal(got,expected)
  assert.ok(!got.includes('<decision'))
  assert.ok(!got.includes('<option'))
})

test('streaming filter keeps normal prose and unrelated angle-bracket syntax',()=>{
  const input='Keep <tool_call>{"name":"Read"}</tool_call> and XML <sources>text</sources> untouched.\n'
  const f=createDecisionOutputFilter()
  let actual=''
  for(const part of [input.slice(0,12),input.slice(12,28),input.slice(28)])actual+=f.push(part)
  assert.equal(actual+f.end(),input)
})

test('do not rewrite inline XML examples or code-fenced examples',()=>{
  const fence=String.fromCharCode(96).repeat(3)
  const content = [
    'Inline <decision question="Q"><option>Yes</option></decision> stays as a sample.',
    fence+'xml',
    '<decision question="Code?">',
    '<option>Code option</option>',
    '</decision>',
    fence,
    'After the code block.',
  ].join('\n')
  const f=createDecisionOutputFilter()
  let got=''
  for(let i=0;i<content.length;i+=7)got+=f.push(content.slice(i,i+7))
  got+=f.end()
  assert.equal(got,content)
})

test('malformed block is preserved, not lost',()=>{
  const raw='before\n<decision question="broken"><option>unfinished'
  const f=createDecisionOutputFilter()
  assert.equal(f.push(raw)+f.end(),raw)
})

test('block following a decision remains visible, including source text',()=>{
  const source=example+'\n\n<sources>\nDoc\n</sources>'
  const f=createDecisionOutputFilter()
  let out=''
  for(let i=0;i<source.length;i+=3)out+=f.push(source.slice(i,i+3))
  out+=f.end()
  assert.equal(out,expected+'\n\n<sources>\nDoc\n</sources>')
})

test('multi-question wrapper renders all groups, without leaking decisions tags',()=>{
  const input=[
    '检验结束。',
    '<decisions>',
    '<decision question="怎么继续？">',
    '<option description="检查论文">继续</option>',
    '</decision>',
    '<decision question="论文图怎么处理？">',
    '<option>放附录</option>',
    '<option>不引用</option>',
    '</decision>',
    '</decisions>',
    '后续报告。',
  ].join('\n')
  const f=createDecisionOutputFilter()
  let result=''
  for(const ch of input)result+=f.push(ch)
  result+=f.end()
  assert.ok(result.includes('检验结束。'))
  assert.ok(result.includes('**怎么继续？**'))
  assert.ok(result.includes('- 继续 — 检查论文'))
  assert.ok(result.includes('**论文图怎么处理？**'))
  assert.ok(result.includes('- 放附录'))
  assert.ok(result.includes('- 不引用'))
  assert.ok(result.includes('后续报告。'))
  assert.ok(!result.includes('<decisions'))
  assert.ok(!result.includes('</decisions'))
  assert.ok(!result.includes('<decision'))
  assert.ok(!result.includes('<option'))
})
