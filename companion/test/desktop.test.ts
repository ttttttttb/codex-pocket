import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright-core';
import {CodexDesktop,mergeMessages} from '../src/desktop.js';
import {SafeError} from '../src/types.js';

test('message ordering retains virtualized history while replacing streamed text',()=>{
  const a={id:'a',role:'user' as const,markdown:'a'},b={id:'b',role:'assistant' as const,markdown:'b'},c={id:'c',role:'assistant' as const,markdown:'c'};
  assert.deepEqual(mergeMessages([b,c],[a,{...b,markdown:'updated'}]),[a,{...b,markdown:'updated'},c]);
});
test('CDP UI integration: same page, drafts, concurrent chat switch, approvals and streaming',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--remote-debugging-port=19322','--remote-debugging-address=127.0.0.1']});
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><html><head><title>Fixture</title></head><body data-current-thread="one"><nav><a href="/local/one">First</a><a href="/local/two">Second</a></nav><main style="height:300px;overflow-y:auto"><div data-turn-key="turn-1"><div data-user-message-bubble>Hello</div><div class="markdown">Existing reply<pre><code>const n = 1</code></pre></div></div><div id="messages"></div></main><div data-codex-composer-root><div data-codex-composer contenteditable="true" style="min-height:40px;width:600px;border:1px solid black"></div><button aria-label="Send message">Send</button><button aria-label="Stop task">Stop</button></div><script>let n=1;const input=document.querySelector('[contenteditable]');document.querySelector('button').onclick=()=>{const t=document.createElement('div');t.dataset.turnKey='turn-'+(++n);const u=document.createElement('div');u.dataset.userMessageBubble='';u.textContent=input.innerText;const a=document.createElement('div');a.className='markdown';a.textContent='Streaming';t.append(u,a);document.querySelector('#messages').append(t);input.innerText='';setTimeout(()=>a.textContent='Completed streamed reply',60)};document.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();document.body.dataset.currentThread=a.getAttribute('href').split('/').pop()});document.querySelector('[aria-label="Stop task"]').onclick=e=>e.target.remove();</script></body></html>`);
  const desktop=new CodexDesktop('http://127.0.0.1:19322',true);
  try{
    const before=await desktop.snapshot();assert.ok(before.compatible);assert.equal(before.threadId,'one');assert.ok(before.messages.some(m=>m.markdown.includes('```')));
    const second=await browser.newPage();await second.setContent('<body data-current-thread="other"><div data-codex-composer contenteditable="true" style="width:200px;height:50px"></div></body>');
    assert.equal((await desktop.snapshot()).compatible,false);
    await assert.rejects(()=>desktop.operate({id:crypto.randomUUID(),type:'send',threadId:'one',text:'must not send'}),/多个/);
    await second.close();
    // A different CDP client receives the target-closed event asynchronously.
    let recovered=await desktop.snapshot();const recoveryDeadline=Date.now()+2000;
    while(!recovered.compatible&&Date.now()<recoveryDeadline){await new Promise(r=>setTimeout(r,25));recovered=await desktop.snapshot();}
    assert.ok(recovered.compatible,recovered.error||'multiple-window recovery failed');
    await page.locator('[contenteditable]').fill('desktop draft');
    await assert.rejects(()=>desktop.operate({id:crypto.randomUUID(),type:'send',threadId:'one',text:'remote message'}),(e:any)=>e instanceof SafeError&&e.code==='DRAFT');
    assert.equal(await page.locator('[contenteditable]').innerText(),'desktop draft');await page.locator('[contenteditable]').fill('');
    const result=await desktop.operate({id:crypto.randomUUID(),type:'send',threadId:'one',text:'remote message'});assert.equal(result.status,'sent');
    const after=await desktop.snapshot();assert.ok(after.messages.some(m=>m.markdown==='remote message'));assert.ok(after.messages.some(m=>m.markdown==='Completed streamed reply'));
    await assert.rejects(()=>desktop.operate({id:crypto.randomUUID(),type:'send',threadId:'two',text:'wrong thread'}),/切换聊天/);
    await desktop.operate({id:crypto.randomUUID(),type:'select',threadId:'two'});assert.equal((await desktop.snapshot()).threadId,'two');
    await page.evaluate(()=>{const el=document.createElement('div');el.setAttribute('data-codex-composer-request-navigation','');el.innerHTML='<p>Run fixture command?</p><button>Approve</button><button>Deny</button>';el.querySelectorAll('button').forEach(b=>b.onclick=()=>el.remove());document.body.append(el)});
    const approval=(await desktop.snapshot()).approvals[0];assert.ok(approval);await desktop.operate({id:crypto.randomUUID(),type:'approve',threadId:'two',approvalId:approval.id,decision:'decline'});assert.equal((await desktop.snapshot()).approvals.length,0);
    await assert.rejects(()=>desktop.operate({id:crypto.randomUUID(),type:'approve',threadId:'two',approvalId:approval.id,decision:'accept'}),/审批/);
    await desktop.operate({id:crypto.randomUUID(),type:'stop',threadId:'two'});assert.equal((await desktop.snapshot()).busy,false);
    // Some desktop versions use a textarea and an internal router instead of a rich editor.
    await page.evaluate(()=>{document.body.removeAttribute('data-current-thread');const old=document.querySelector('[contenteditable]')!;const t=document.createElement('textarea');t.setAttribute('data-conversation-id','three');t.style.cssText='width:600px;height:60px';old.replaceWith(t);document.querySelector('button')!.onclick=()=>{const el=document.createElement('div');el.dataset.turnKey='textarea-turn';const u=document.createElement('div');u.dataset.userMessageBubble='';u.textContent=t.value;el.append(u);document.querySelector('#messages')!.append(el);t.value='';};});
    const textAreaState=await desktop.snapshot();assert.ok(textAreaState.compatible);assert.equal(textAreaState.threadId,'three');
    assert.equal((await desktop.operate({id:crypto.randomUUID(),type:'send',threadId:'three',text:'textarea message'})).status,'sent');
  }finally{await desktop.close();await browser.close()}
});
