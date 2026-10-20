import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright-core';
import {CodexDesktop,domSnapshot,mergeMessages} from '../src/desktop.js';

test('stable message identity survives wrapper changes, duplicate nodes, streaming and repeated user text',async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const p=await b.newPage();
  await p.setContent(`<div data-turn-key="one"><div data-message-role="user"><div data-content-search-unit-key="temporary"><div data-user-message-bubble>same</div></div></div><div data-markdown-text-style="assistant-message"><div class="markdown"><div class="prose">stream</div></div></div></div>`);
  const a=(await p.evaluate(domSnapshot)).messages;assert.equal(a.length,2);assert.equal(a[0].role,'user');assert.equal(a[1].role,'assistant');
  await p.evaluate(()=>{document.querySelector('[data-content-search-unit-key]')!.setAttribute('data-content-search-unit-key','permanent');document.querySelector('.prose')!.textContent='stream completed';const hidden=document.createElement('div');hidden.setAttribute('aria-hidden','true');hidden.innerHTML='<div data-message-role="user">same</div>';document.body.append(hidden)});
  const next=(await p.evaluate(domSnapshot)).messages;assert.equal(next.length,2);assert.equal(next[0].id,a[0].id);assert.equal(mergeMessages(a,next).length,2);assert.equal(mergeMessages(a,next)[1].markdown,'stream completed');
  await p.evaluate(()=>{const t=document.createElement('div');t.dataset.turnKey='two';t.innerHTML='<div data-user-message-bubble>same</div>';document.body.append(t)});
  const repeated=(await p.evaluate(domSnapshot)).messages;assert.equal(repeated.filter(m=>m.role==='user').length,2);assert.notEqual(repeated[0].id,repeated[2].id);
  await p.evaluate(()=>document.querySelector('[data-turn-key="one"]')!.remove());
  assert.equal(mergeMessages(repeated,(await p.evaluate(domSnapshot)).messages).length,3);
 }finally{await b.close()}
});

test('new chat context, settings, confirmation, stale revisions and first send use the desktop UI',async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--remote-debugging-port=19324','--remote-debugging-address=127.0.0.1']});
 const p=await b.newPage();
 await p.setContent(`<body data-current-thread="one"><button aria-label="新聊天" id="new">New</button><main><div data-turn-key="old"><div data-user-message-bubble>existing</div></div></main>
 <div data-codex-composer-root><div data-codex-composer contenteditable="true" style="width:500px;height:60px"></div><button data-composer-navigation-target="permissions">请求批准</button><button data-composer-navigation-target="reasoning" data-selected-reasoning-effort="high"><span data-current-model>Model A</span></button><button data-composer-navigation-target="add-context">+</button><button aria-label="Send message">Send</button></div>
 <script>
 const root=document.querySelector('[data-codex-composer-root]'),input=document.querySelector('[contenteditable]');
 const clear=()=>document.querySelector('[role=menu]')?.remove();document.addEventListener('pointerdown',e=>{if(e.target===input)clear()});document.addEventListener('keydown',e=>{if(e.key==='Escape'){window.escapeCount=(window.escapeCount||0)+1;throw Error('Unexpected Escape')}});
 function menu(items){clear();const m=document.createElement('div');m.role='menu';for(const [label,action] of items){const x=document.createElement('div');x.role='menuitem';x.tabIndex=0;x.textContent=label;x.onclick=()=>{clear();action()};m.append(x)}document.body.append(m)}
 document.querySelector('[data-composer-navigation-target=permissions]').onclick=()=>menu([['请求批准',()=>document.querySelector('[data-composer-navigation-target=permissions]').textContent='请求批准'],['完全访问权限',()=>{const d=document.createElement('div');d.role='dialog';d.innerHTML='<p>允许完全访问？</p><button>允许</button><button>取消</button>';d.querySelector('button').onclick=()=>{document.querySelector('[data-composer-navigation-target=permissions]').textContent='完全访问';d.remove()};d.querySelectorAll('button')[1].onclick=()=>d.remove();document.body.append(d)}]]);
 document.querySelector('[data-composer-navigation-target=reasoning]').onclick=()=>menu([['Model A',()=>document.querySelector('[data-current-model]').textContent='Model A'],['Model B',()=>document.querySelector('[data-current-model]').textContent='Model B']]);
 document.querySelector('[data-composer-navigation-target=add-context]').onclick=()=>menu([['计划',()=>{const x=document.createElement('button');x.textContent='计划';x.onclick=()=>x.remove();root.append(x)}]]);
 document.querySelector('#new').onclick=()=>{document.body.removeAttribute('data-current-thread');document.querySelector('main').innerHTML=''};
 document.querySelector('[aria-label="Send message"]').onclick=()=>{document.body.dataset.currentThread='created';const t=document.createElement('div');t.dataset.turnKey='sent';const u=document.createElement('div');u.dataset.userMessageBubble='';u.textContent=input.innerText;t.append(u);document.querySelector('main').append(t);input.innerText=''};
 </script></body>`);
 const d=new CodexDesktop('http://127.0.0.1:19324',true);
 const operation=(type:string,s:any,extra:any={})=>({id:crypto.randomUUID(),type,threadId:s.contextId,expectedRevision:s.settingsRevision,...extra} as any);
 try{
  let s=await d.snapshot();assert.ok(s.compatible);assert.equal(s.protocolVersion,3);
  await d.operate(operation('options',s,{setting:'model'}));s=await d.snapshot();const model=s.menu!.options.find(o=>o.label==='Model B')!;assert.ok(model);
  await d.operate(operation('setting',s,{setting:'model',optionId:model.id}));s=await d.snapshot();assert.equal(s.settings!.find(v=>v.key==='model')!.value,'Model B');
  await assert.rejects(()=>d.operate(operation('options',s,{setting:'permission',expectedRevision:'stale'})),/变化/);
  await d.operate(operation('options',s,{setting:'permission'}));s=await d.snapshot();const permission=s.menu!.options.find(o=>o.label==='完全访问权限')!;
  await d.operate(operation('setting',s,{setting:'permission',optionId:permission.id}));s=await d.snapshot();assert.ok(s.confirmation);assert.equal(s.settings!.find(v=>v.key==='permission')!.value,'请求批准');
  await d.operate({id:crypto.randomUUID(),type:'confirm',threadId:s.contextId!,confirmationId:s.confirmation!.id,decision:'accept'});s=await d.snapshot();assert.equal(s.settings!.find(v=>v.key==='permission')!.value,'完全访问');
  await d.operate(operation('options',s,{setting:'plan'}));s=await d.snapshot();await d.operate(operation('setting',s,{setting:'plan',optionId:s.menu!.options.find(o=>o.label==='计划')!.id}));s=await d.snapshot();assert.equal(s.settings!.find(v=>v.key==='plan')!.value,'计划');
  await p.locator('[contenteditable]').fill('desktop draft');s=await d.snapshot();await assert.rejects(()=>d.operate(operation('create',s,{projectId:null})),/草稿/);await p.locator('[contenteditable]').fill('');
  s=await d.snapshot();await d.operate(operation('create',s,{projectId:null}));s=await d.snapshot();assert.equal(s.screen,'new');assert.equal(s.threadId,null);assert.ok(s.contextId!.startsWith('new:'));
  const reconnected=new CodexDesktop('http://127.0.0.1:19324',true);
  try{assert.equal((await reconnected.snapshot()).contextId,s.contextId)}finally{await reconnected.close()}
  assert.equal((await d.operate({id:crypto.randomUUID(),type:'send',threadId:s.contextId!,text:'first message'})).status,'sent');
  s=await d.snapshot();assert.equal(s.threadId,'created');assert.equal(s.messages.filter(m=>m.role==='user').length,1);assert.equal(await p.evaluate(()=>(window as any).escapeCount||0),0);
 }finally{await d.close();await b.close()}
});
