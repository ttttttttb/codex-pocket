import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright-core';
import {CodexDesktop,domSnapshot,mergeMessages} from '../src/desktop.js';

const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
const op=(s:any,type:string,extra:any={})=>({id:crypto.randomUUID(),type,threadId:s.contextId,expectedRevision:s.settingsRevision,...extra} as any);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('phone-created chat transitions to a real thread with a replacement question, survives cold attach, navigation and custom answers',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19344']});const p=await b.newPage();
 await p.setContent(`<body data-current-thread="old"><button aria-label="新聊天">new</button><main></main><section data-codex-composer-root><div data-codex-composer contenteditable="true" style="height:45px;width:400px"></div><button aria-label="Send message">send</button></section></body>`);
 await p.evaluate(()=>{
  const input=document.querySelector<HTMLElement>('[data-codex-composer]')!;
  document.querySelector<HTMLButtonElement>('[aria-label="新聊天"]')!.onclick=()=>document.body.removeAttribute('data-current-thread');
  (window as any).stops=0;document.addEventListener('keydown',e=>{if(e.key==='Escape')(window as any).stops++});
  const render=(n:number)=>{document.querySelector('form')?.remove();const f=document.createElement('form');f.className='@container/request-card';f.setAttribute('data-codex-character-input-boundary','');f.setAttribute('data-codex-escape-boundary','');
   f.innerHTML=`<span class="whitespace-pre-wrap">问题 ${n}</span><button type="button" role="radio" aria-label="选项 A" aria-checked="false"><span aria-hidden="true">1.</span>选项 A <span>说明</span></button><div class="tiptap" contenteditable="true" role="textbox" aria-label="或自行撰写回复" style="width:400px;height:60px"></div><button type="button" aria-label="上一题">prev</button><button type="button" aria-label="下一题">next</button><button type="button" disabled aria-label="发送">发送</button>`;
   f.querySelector<HTMLButtonElement>('[role="radio"]')!.onclick=e=>{(e.currentTarget as Element).setAttribute('aria-checked','true')};
   const field=f.querySelector<HTMLElement>('[contenteditable]')!,send=f.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
   field.oninput=()=>{send.disabled=!field.innerText.trim()};send.onclick=()=>{document.body.dataset.answer=field.innerText;f.remove();input.style.display=''};
   f.querySelector<HTMLButtonElement>('[aria-label="下一题"]')!.onclick=()=>render(n+1);f.querySelector<HTMLButtonElement>('[aria-label="上一题"]')!.onclick=()=>render(Math.max(1,n-1));document.querySelector('[data-codex-composer-root]')!.append(f);
  };
  document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.onclick=()=>{document.body.dataset.currentThread='phone-created';document.querySelector('main')!.innerHTML='<div data-turn-key="first"><div data-user-message-bubble></div></div>';document.querySelector('[data-user-message-bubble]')!.textContent=input.innerText;input.innerText='';input.style.display='none';render(1)};
 });
 let d=new CodexDesktop('http://127.0.0.1:19344',true);
 try{
  let s=await d.snapshot();await d.operate(op(s,'create',{projectId:null}));s=await d.snapshot();const temporary=s.contextId!;assert.match(temporary,/^new:/);
  assert.equal((await d.operate(op(s,'send',{text:'ask me'}))).status,'sent');s=await d.snapshot();assert.equal(s.contextId,'phone-created');assert.ok(s.connected&&s.compatible);assert.equal(s.sendEnabled,false);assert.equal(s.messages.length,1);
  let q=s.surfaces!.find(x=>x.kind==='question')!;assert.equal(q.title,'问题 1');assert.equal(q.fields.length,1);assert.equal(q.actions[0].description,'说明');
  await assert.rejects(()=>d.operate({...op(s,'ui-action',{surfaceId:q.id,revision:q.revision,actionId:q.actions[0].id}),threadId:temporary}),/切换聊天/);
  await d.close();d=new CodexDesktop('http://127.0.0.1:19344',true);s=await d.snapshot();assert.ok(s.compatible);assert.equal(s.contextId,'phone-created');
  await d.operate(op(s,'ui-action',{surfaceId:q.id,revision:q.revision,actionId:q.actions.find(x=>x.label==='下一题')!.id}));s=await d.snapshot();assert.equal(s.surfaces!.find(x=>x.kind==='question')!.title,'问题 2');
  await assert.rejects(()=>d.operate(op(s,'ui-action',{surfaceId:q.id,revision:q.revision,actionId:q.actions[0].id})),/变化/);
  q=s.surfaces!.find(x=>x.kind==='question')!;await d.operate(op(s,'ui-action',{surfaceId:q.id,revision:q.revision,actionId:q.actions.find(x=>x.label==='上一题')!.id}));s=await d.snapshot();q=s.surfaces!.find(x=>x.kind==='question')!;
  await d.operate(op(s,'ui-action',{surfaceId:q.id,revision:q.revision,actionId:q.actions.find(x=>x.label==='发送')!.id,fields:{[q.fields[0].id]:'手机输入的答案'}}));assert.equal(await p.getAttribute('body','data-answer'),'手机输入的答案');assert.ok((await d.snapshot()).compatible);assert.equal(await p.evaluate(()=>(window as any).stops),0);
 }finally{await d.close();await b.close()}
});

test('sibling attachments belong to each user message, pure files and images survive virtual wrapper replacement without duplicates',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const p=await b.newPage();await p.setContent(`<div data-turn-key="tail:temporary"><div data-content-search-turn-key="real-turn"><div data-content-search-unit-key="u1"><img alt="用户附件" src="${png}" width="20" height="20"><div data-user-message-bubble>same</div><button data-composer-attachment-pill>报告.pdf</button></div><div data-content-search-unit-key="u2"><img alt="User attachment" src="${png}" width="20" height="20"><div data-user-message-bubble>same</div></div><div data-content-search-unit-key="u3" data-local-conversation-user-anchor><button data-composer-attachment-pill>只有文件.xlsx</button></div><div class="markdown">response</div></div></div>`);
  const a=(await p.evaluate(domSnapshot)).messages;assert.equal(a.length,4);assert.equal(a[0].images!.length,1);assert.equal(a[1].images!.length,1);assert.notEqual(a[0].images![0].id,a[1].images![0].id);assert.equal(a[0].attachedFiles![0].name,'报告.pdf');assert.equal(a[2].attachedFiles![0].name,'只有文件.xlsx');assert.equal(a[2].markdown,'');assert.equal(a[3].images!.length,0);
  await p.locator('[data-turn-key]').evaluate(e=>e.setAttribute('data-turn-key','history:formal'));const next=(await p.evaluate(domSnapshot)).messages;assert.equal(mergeMessages(a,next).length,4);assert.deepEqual(next.map(m=>m.id),a.map(m=>m.id));assert.equal(next.filter(m=>m.role==='user').length,3);
  assert.ok(!JSON.stringify(next).includes('base64'));
  await p.locator('[data-content-search-unit-key="u1"]').evaluate(e=>{const a=document.createElement("div");a.className="markdown";a.textContent="interleaved response";e.after(a)});assert.deepEqual((await p.evaluate(domSnapshot)).messages.map(m=>m.role),["user","assistant","user","user","assistant"]);
 }finally{await b.close()}
});

test('a cold connection with no main composer keeps question photos readable and permits explicit dialog cancellation',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19345']});const p=await b.newPage();
 await p.setContent(`<body data-current-thread="one"><div data-turn-key="t"><div data-content-search-unit-key="u"><img alt="用户附件" src="${png}" width="20" height="20"></div></div><div data-codex-composer-request-navigation><h2>等待回答</h2><button role="radio">允许</button><button role="radio">拒绝</button></div><div role="dialog"><h2>确认权限</h2><button>取消</button></div></body>`);
 await p.locator('[role="dialog"] button').evaluate(e=>(e as HTMLButtonElement).onclick=()=>e.parentElement!.remove());
 const d=new CodexDesktop('http://127.0.0.1:19345',true);
 try{let s=await d.snapshot();assert.ok(s.connected&&s.compatible);assert.ok(s.surfaces!.some(x=>x.kind==='question'));assert.equal(s.messages[0].role,'user');assert.ok((await d.image(s.messages[0].images![0].id)).length>10);const dialog=s.surfaces!.find(x=>x.kind==='dialog')!;await d.operate(op(s,'ui-action',{surfaceId:dialog.id,revision:dialog.revision,actionId:dialog.dismissActionId}));assert.equal(await p.locator('[role="dialog"]').count(),0);assert.ok((await d.snapshot()).compatible)}finally{await d.close();await b.close()}
});
