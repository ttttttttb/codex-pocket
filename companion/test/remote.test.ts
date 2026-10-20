import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {CodexDesktop,domSnapshot} from '../src/desktop.js';
import {operationSchema} from '../src/types.js';
import {Transfers} from '../src/transfers.js';
import {Journal} from '../src/journal.js';
import {RemoteUi} from '../src/remote-ui.js';
import {dismissFloatingMenus} from '../src/ui-action.js';
import {emptySnapshot} from '../src/types.js';

test('closing a custom + menu and pointer-driven chat menu is bounded, idempotent and preserves a busy composer',async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const p=await b.newPage();await p.setContent('<body data-current-thread="one"><div data-codex-composer contenteditable="true" style="height:40px;width:300px">PC private draft</div><button data-composer-navigation-target="add-context" aria-expanded="false">+</button><button aria-label="聊天操作" aria-expanded="false">...</button><button aria-label="停止">stop</button></body>');
  await p.evaluate(()=>{
   (window as any).stops=0;document.addEventListener('keydown',e=>{if(e.key==='Escape')(window as any).stops++});document.querySelector<HTMLButtonElement>('[aria-label="停止"]')!.onclick=()=>(window as any).stops++;
   const plus=document.querySelector<HTMLButtonElement>('[data-composer-navigation-target]')!;
   const open=()=>{if(plus.getAttribute('aria-expanded')==='true')return;plus.setAttribute('aria-expanded','true');const m=document.createElement('section');m.id='plus';m.innerHTML='<button data-list-navigation-item>计划模式</button>';document.body.append(m)};
   plus.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();open()}};
   plus.onclick=()=>{if(plus.getAttribute('aria-expanded')==='true'){document.getElementById('plus')?.remove();plus.setAttribute('aria-expanded','false')}else open()};
   const chat=document.querySelector<HTMLButtonElement>('[aria-label="聊天操作"]')!;
   chat.onpointerdown=()=>{if(chat.getAttribute('aria-expanded')==='true'){document.getElementById('chat')?.remove();chat.setAttribute('aria-expanded','false')}else{const m=document.createElement('div');m.id='chat';m.role='menu';m.innerHTML='<button role="menuitem">复制</button>';document.body.append(m);chat.setAttribute('aria-expanded','true')}};
  });
  const ui=new RemoteUi(),state={...emptySnapshot(''),contextId:'one',busy:true,draftPresent:true};
  await ui.open(p,'plus',state);const first=(await ui.read(p)).surfaces[0].id;
  await ui.open(p,'plus',state);assert.equal((await ui.read(p)).surfaces[0].id,first,'reopening the phone sheet must reuse the same desktop menu');
  await ui.close(p);assert.equal((await ui.read(p)).surfaces.length,0);await ui.close(p);
  await p.locator('[aria-label="聊天操作"]').dispatchEvent('pointerdown');assert.equal(await dismissFloatingMenus(p),true);
  await p.evaluate(()=>{const d=document.createElement('div');d.role='dialog';d.setAttribute('aria-modal','true');d.textContent='Do not dismiss a confirmation';document.body.append(d)});
  assert.equal(await dismissFloatingMenus(p),false);assert.equal(await p.locator('[role="dialog"]').count(),1);await p.locator('[role="dialog"]').evaluate(e=>e.remove());
  await p.evaluate(()=>{const m=document.createElement('div');m.role='menu';m.style.cssText='position:fixed;inset:0;background:white;z-index:9999';m.textContent='unknown modal menu';document.body.append(m)});
  const start=Date.now();assert.equal(await dismissFloatingMenus(p),false);assert.ok(Date.now()-start<2200,'intercepted clicks must not stall the queue');
  assert.equal(await p.locator('[data-codex-composer]').innerText(),'PC private draft');assert.equal(await p.evaluate(()=>(window as any).stops),0);
 }finally{await b.close()}
});

test('remote menus and questions; distinct same-text queued messages; stale actions; no Escape or stop during polling',async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--remote-debugging-port=19326']});
 const p=await b.newPage();
 await p.route('http://pocket.test/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));await p.goto('http://pocket.test');
 await p.evaluate(()=>{if(!crypto.randomUUID)crypto.randomUUID=(()=>Array.from(crypto.getRandomValues(new Uint8Array(16))).map(n=>n.toString(16).padStart(2,'0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5')) as any});
 await p.setContent('<body data-current-thread="one"><div data-codex-composer-root><div data-codex-composer contenteditable="true" style="height:40px;width:300px"></div><button aria-label="停止">stop</button><button data-composer-navigation-target="add-context">+</button><button aria-label="聊天操作">...</button></div></body>');
 await p.evaluate(()=>{
  (window as any).stops=0;(window as any).escapes=0;document.addEventListener('keydown',e=>{if(e.key==='Escape'){(window as any).stops++;(window as any).escapes++}});
  document.querySelector<HTMLButtonElement>('[aria-label="停止"]')!.onclick=()=>(window as any).stops++;
  document.querySelector<HTMLButtonElement>('[data-composer-navigation-target]')!.onclick=()=>{const menu=document.createElement('section');menu.innerHTML='<button data-list-navigation-item>计划模式</button><button data-list-navigation-item>Documents</button>';document.body.append(menu);menu.querySelector('button')!.onclick=()=>{menu.remove();document.body.dataset.plan='yes'}};
  document.querySelector<HTMLButtonElement>('[aria-label="聊天操作"]')!.onclick=()=>{const m=document.createElement('div');m.role='menu';m.innerHTML='<button role="menuitem">置顶</button><button role="menuitem">在新窗口中打开</button>';m.querySelector('button')!.onclick=()=>{document.body.dataset.pinned='yes';m.remove()};document.body.append(m)};
 });
 const d=new CodexDesktop('http://127.0.0.1:19326',true);
 const op=(type:string,s:any,x:any={})=>({id:crypto.randomUUID(),type,threadId:s.contextId,...x} as any);
 try{
  let s=await d.snapshot();assert.ok(s.compatible,s.error||'fixture');for(let i=0;i<15;i++)await d.snapshot();assert.equal(await p.evaluate(()=>(window as any).stops),0);
  await d.operate(op('ui-open',s,{menu:'plus'}));s=await d.snapshot();const menu=s.surfaces!.find(m=>m.kind==='menu')!;assert.ok(menu.actions.some(a=>a.label==='Documents'));
  await d.operate(op('ui-action',s,{surfaceId:menu.id,revision:menu.revision,actionId:menu.actions[0].id}));assert.equal(await p.getAttribute('body','data-plan'),'yes');
  await d.operate(op('ui-open',s,{menu:'chat'}));s=await d.snapshot();const chat=s.surfaces!.find(m=>m.kind==='menu')!;assert.ok(!chat.actions.some(a=>a.label.includes('窗口')));await d.operate(op('ui-action',s,{surfaceId:chat.id,revision:chat.revision,actionId:chat.actions[0].id}));assert.equal(await p.getAttribute('body','data-pinned'),'yes');
  await p.evaluate(()=>{
   for(let i=0;i<2;i++){const row=document.createElement('section');row.innerHTML='<span>same message</span><div><button>引导</button><button aria-label="删除">trash</button><button aria-label="更多操作">...</button></div>';row.querySelector('button')!.onclick=()=>row.remove();document.body.append(row)}
   const q=document.createElement('section');q.setAttribute('data-codex-composer-request-navigation','');q.innerHTML='<h3>Choose a target</h3><button role="radio" aria-checked="false">Android</button><button role="radio" aria-checked="false">Computer</button><div contenteditable="true" aria-label="自行填写" style="height:40px;width:300px"></div><button disabled>提交</button>';q.querySelectorAll('button[role]').forEach(b=>(b as HTMLElement).onclick=()=>b.setAttribute('aria-checked','true'));q.querySelector('[contenteditable]')!.addEventListener('input',()=>{q.querySelector<HTMLButtonElement>('button:last-child')!.disabled=false});q.querySelector('button:last-child')!.addEventListener('click',()=>{document.body.dataset.answer=(q.querySelector('[contenteditable]') as HTMLElement).innerText;q.remove()});document.body.append(q);
  });
  s=await d.snapshot();assert.equal(s.queue!.length,2);assert.notEqual(s.queue![0].id,s.queue![1].id);const queued=s.queue![0];await d.operate(op('ui-action',s,{surfaceId:queued.id,revision:queued.revision,actionId:queued.actions[0].id}));assert.equal((await d.snapshot()).queue!.length,1);
  await assert.rejects(()=>d.operate(op('ui-action',s,{surfaceId:queued.id,revision:queued.revision,actionId:queued.actions[0].id})),/变化/);
  s=await d.snapshot();let question=s.surfaces!.find(x=>x.kind==='question')!;assert.equal(question.fields.length,1);
  await d.operate(op('ui-action',s,{surfaceId:question.id,revision:question.revision,actionId:question.actions[0].id}));s=await d.snapshot();question=s.surfaces!.find(x=>x.kind==='question')!;assert.equal(question.actions[0].selected,true);
  const submit=question.actions.find(x=>x.label==='提交')!;assert.equal(submit.disabled,true);await d.operate(op('ui-action',s,{surfaceId:question.id,revision:question.revision,actionId:submit.id,fields:{[question.fields[0].id]:'My answer'}}));assert.equal(await p.getAttribute('body','data-answer'),'My answer');
  assert.deepEqual(await p.evaluate(()=>({escapes:(window as any).escapes,stops:(window as any).stops})),{escapes:0,stops:0});
 }finally{await d.close();await b.close()}
});

test('pure image message identity survives polling without embedding image bytes',async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const p=await b.newPage();await p.route('https://pocket.test/**',r=>r.fulfill({body:'<body></body>',contentType:'text/html'}));await p.goto('https://pocket.test');await p.setContent('<div data-turn-key="one"><div data-user-message-bubble><img alt="test" src="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"></div></div>');const s=await p.evaluate(domSnapshot);assert.equal(s.messages.length,1);assert.equal(s.messages[0].markdown,'');assert.ok(s.messages[0].images?.[0].id);assert.ok(!JSON.stringify(s).includes('base64'));assert.equal((await p.evaluate(domSnapshot)).messages[0].images?.[0].id,s.messages[0].images?.[0].id)}finally{await b.close()}
});

test('menu input and phone-owned context are guarded against stale controls and desktop drafts',async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--remote-debugging-port=19329']});
 const p=await b.newPage();await p.setContent('<body data-current-thread="one"><div data-codex-composer-root><div data-codex-composer contenteditable="true" style="height:40px;width:300px"></div><button aria-label="停止">stop</button><button data-composer-navigation-target="add-context">+</button></div></body>');
 await p.evaluate(()=>{document.querySelector<HTMLButtonElement>('[data-composer-navigation-target]')!.onclick=()=>{const m=document.createElement('div');m.role='menu';m.innerHTML='<input aria-label="搜索"><select aria-label="周期"><option value="daily">每天</option><option value="weekly">每周</option></select><button role="menuitem">Documents</button>';m.querySelector('button')!.onclick=()=>{document.querySelector<HTMLElement>('[data-codex-composer]')!.innerText='$documents';m.remove()};document.body.append(m)}});
 const d=new CodexDesktop('http://127.0.0.1:19329',true),op=(s:any,type:string,fields:any={})=>({id:crypto.randomUUID(),threadId:s.contextId,type,...fields} as any);
 try{
  let s=await d.snapshot();await d.operate(op(s,'ui-open',{menu:'plus'}));s=await d.snapshot();let m=s.surfaces!.find(x=>x.kind==='menu')!;assert.equal(m.fields[1].options?.[1].label,'每周');
  const input=op(s,'ui-input',{surfaceId:m.id,revision:m.revision,fields:{[m.fields[0].id]:'doc',[m.fields[1].id]:'weekly'}});await d.operate(input);await assert.rejects(()=>d.operate({...input,id:crypto.randomUUID()}),/变化/);
  s=await d.snapshot();m=s.surfaces!.find(x=>x.kind==='menu')!;await d.operate(op(s,'ui-action',{surfaceId:m.id,revision:m.revision,actionId:m.actions[0].id}));s=await d.snapshot();assert.equal(s.composerContext,'$documents');assert.equal(s.draftPresent,false);
  await d.operate(op(s,'context-clear'));assert.equal((await p.locator('[data-codex-composer]').innerText()).trim(),'');
  await p.evaluate(()=>{const m=document.createElement('div');m.role='menu';m.innerHTML='<button role="menuitem">编辑消息</button>';m.querySelector('button')!.onclick=()=>{document.querySelector<HTMLElement>('[data-codex-composer]')!.innerText='Original queued text';m.remove()};document.body.append(m)});
  s=await d.snapshot();m=s.surfaces!.find(x=>x.kind==='menu')!;await d.operate(op(s,'ui-action',{surfaceId:m.id,revision:m.revision,actionId:m.actions[0].id}));s=await d.snapshot();assert.equal(s.composerContext,'Original queued text');assert.equal(s.composerContextEditable,true);await d.operate(op(s,'context-clear'));
  await p.locator('[data-codex-composer]').fill('PC private draft');s=await d.snapshot();await assert.rejects(()=>d.operate(op(s,'context-clear')),/归属/);assert.equal(await p.locator('[data-codex-composer]').innerText(),'PC private draft');
 }finally{await d.close();await b.close()}
});

test('file staging checks context, size, opaque selections; protocol rejects selectors; receipts omit clipboard contents',async()=>{
 const t=new Transfers();const staged=await t.stage('one','../safe.txt',Buffer.from('test'));assert.equal(staged.name,'safe.txt');assert.equal(t.get('one',[staged.id]).length,1);assert.throws(()=>t.get('other',[staged.id]));await assert.rejects(()=>t.stage('one','big',Buffer.alloc(20*1024*1024+1)));await assert.rejects(()=>t.files('C:\\Windows'));t.consume([staged.id]);assert.throws(()=>t.get('one',[staged.id]));
 const bad={id:crypto.randomUUID(),type:'ui-action',threadId:'one',surfaceId:crypto.randomUUID(),revision:'a'.repeat(64),actionId:crypto.randomUUID(),selector:'body'};assert.equal(operationSchema.safeParse(bad).success,false);
 const dir=fs.mkdtempSync(path.join(process.cwd(),'.test-'));const journal=new Journal(path.join(dir,'j.json'));const op={id:crypto.randomUUID(),type:'send',threadId:'one',text:'x'} as const;journal.begin(op);journal.complete(op,{id:op.id,status:'sent',message:'copied',clipboard:'private conversation'});assert.ok(!fs.readFileSync(path.join(dir,'j.json'),'utf8').includes('private conversation'));
});
