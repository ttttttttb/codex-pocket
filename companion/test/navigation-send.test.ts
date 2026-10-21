import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright-core';
import {CodexDesktop,domSnapshot,mergeMessages} from '../src/desktop.js';
import {readRemoteUi} from '../src/remote-ui.js';
import {loadCatalog,addFolderProject} from '../src/navigation.js';
import {Transfers} from '../src/transfers.js';
import {operationSchema} from '../src/types.js';
const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';

test('phone drafts can start from a disabled empty Send or a busy Stop, but requests and read-only fields block them',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19348']});const p=await b.newPage();const d=new CodexDesktop('http://127.0.0.1:19348',true);
 try{
  await p.setContent('<body data-current-thread="one"><main></main><section data-codex-composer-root><div data-codex-composer contenteditable="true" style="height:40px;width:300px"></div><button aria-label="Send" disabled></button></section></body>');
  await p.evaluate(()=>{const e=document.querySelector<HTMLElement>('[contenteditable]')!,b=document.querySelector<HTMLButtonElement>('button')!;e.oninput=()=>{b.disabled=!e.innerText.trim();b.setAttribute('aria-label',document.body.dataset.busy?'Queue':'Send')};b.onclick=()=>{const turn=document.createElement('div');turn.setAttribute('data-turn-key','turn-'+document.querySelectorAll('[data-turn-key]').length);turn.innerHTML='<div data-user-message-bubble></div>';turn.firstElementChild!.textContent=e.innerText;document.querySelector('main')!.append(turn);e.innerText='';b.disabled=true}});
  let s=await d.snapshot();assert.equal(s.sendEnabled,true);
  assert.equal((await d.operate({id:crypto.randomUUID(),type:'send',threadId:'one',text:'phone idle'})).status,'sent');
  await p.evaluate(()=>{document.body.dataset.busy='1';const b=document.querySelector<HTMLButtonElement>('button')!;b.disabled=false;b.setAttribute('aria-label','Stop')});
  s=await d.snapshot();assert.equal(s.busy,true);assert.equal(s.sendEnabled,true);assert.equal((await d.operate({id:crypto.randomUUID(),type:'send',threadId:'one',text:'busy phone'})).status,'sent');
  await p.evaluate(()=>{const x=document.createElement('div');x.setAttribute('data-codex-question','');x.innerHTML='<button role="radio">choose</button>';document.body.append(x)});assert.equal((await p.evaluate(readRemoteUi)).sendEnabled,false);
  await p.locator('[data-codex-question]').evaluate(e=>e.remove());await p.locator('[contenteditable]').evaluate(e=>{e.setAttribute('contenteditable','false')});assert.equal((await p.evaluate(readRemoteUi)).sendEnabled,false);
 }finally{await d.close();await b.close()}
});

test('same stable user IDs survive turn regrouping; two distinct identical messages remain two',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true});
 try{const p=await b.newPage();await p.setContent('<div data-turn-key="tail"><div data-content-search-turn-key="draft-group"><div data-content-search-unit-key="draft-group:11111111-1111-4111-8111-111111111111"><div data-user-message-bubble>same</div></div><div data-content-search-unit-key="draft-group:22222222-2222-4222-8222-222222222222"><div data-user-message-bubble>same</div></div></div></div>');
  const old=(await p.evaluate(domSnapshot)).messages;
  await p.evaluate(()=>{document.querySelector('[data-turn-key]')!.setAttribute('data-turn-key','formal');document.querySelector('[data-content-search-turn-key]')!.setAttribute('data-content-search-turn-key','formal-group');document.querySelectorAll('[data-content-search-unit-key]').forEach(e=>e.setAttribute('data-content-search-unit-key',e.getAttribute('data-content-search-unit-key')!.replace('draft-group','formal-group')))});
  const next=(await p.evaluate(domSnapshot)).messages;assert.deepEqual(next.map(m=>m.id),old.map(m=>m.id));assert.equal(mergeMessages(old,next).length,2);
  const weak={...old[0],id:'formal-group:user:0',turnId:'formal-group',slot:0};assert.equal(mergeMessages([weak],next).length,2);
 }finally{await b.close()}
});

test('catalog loads hidden projects and collapsed chats using sidebar controls without changing the conversation or draft',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true});
 try{const p=await b.newPage();await p.setContent('<body data-current-thread="one"><section data-app-action-sidebar-section><button id="more">Show more</button></section><div data-codex-composer contenteditable="true" style="width:200px;height:50px">desktop draft</div></body>');
  await p.evaluate(()=>{
   (window as any).escapes=0;
   document.addEventListener('keydown',e=>{if(e.key==='Escape')(window as any).escapes++});
   document.querySelector<HTMLButtonElement>('#more')!.onclick=e=>{
    (e.currentTarget as Element).remove();
    document.querySelector('section')!.insertAdjacentHTML('beforeend','<div role="button" data-app-action-sidebar-project-row data-app-action-sidebar-project-id="hidden" data-app-action-sidebar-project-label="Hidden" data-app-action-sidebar-project-collapsed="true">hidden</div>');
    document.querySelector<HTMLElement>('[data-app-action-sidebar-project-row]')!.onclick=e=>{
     (e.currentTarget as Element).setAttribute('data-app-action-sidebar-project-collapsed','false');
     document.querySelector('section')!.insertAdjacentHTML('beforeend','<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="older" data-app-action-sidebar-thread-title="Older"></div>');
    };
   };
  });
  await loadCatalog(p,'one');assert.ok((await p.evaluate(domSnapshot)).chats.some(c=>c.id==='older'));assert.equal(await p.locator('[contenteditable]').innerText(),'desktop draft');assert.equal(await p.evaluate(()=>(window as any).escapes),0);
  await p.evaluate(()=>{document.body.dataset.currentThread='other';document.querySelector('section')!.insertAdjacentHTML('beforeend','<button>Show more</button>')});await assert.rejects(()=>loadCatalog(p,'one'),/变化/);
 }finally{await b.close()}
});

test('directory choices use expiring opaque IDs and reject files or arbitrary paths',async()=>{
 const t=new Transfers();const roots=await t.files(null,true);const drive=roots.entries[0];assert.ok(drive?.directory);const listing=await t.files(drive.id,true);assert.ok(listing.path);assert.equal(listing.id,drive.id);assert.ok(listing.entries.every(e=>e.directory));assert.equal(await t.directory(drive.id),listing.path);
 await assert.rejects(()=>t.directory(crypto.randomUUID()),/过期/);await assert.rejects(()=>t.directory('C:\\Windows'),/过期/);
 const base={id:crypto.randomUUID(),type:'create',threadId:'one',projectId:null,expectedRevision:'r'};assert.ok(operationSchema.safeParse({...base,folderId:drive.id}).success);assert.equal(operationSchema.safeParse({...base,folderPath:'C:\\Windows'}).success,false);
});

test('multi-item question history and duplicate virtual copies retain distinct item identities',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const p=await b.newPage();
  await p.setContent('<div data-turn-key="old"></div>');
  await p.evaluate(()=>{
   const root=document.querySelector('[data-turn-key]')!;
   for(const index of [0,1,1]){
    const unit=document.createElement('div');
    unit.setAttribute('data-content-search-unit-key','old:'+JSON.stringify(['request_user_input_async','call_question',index]));
    unit.setAttribute('data-response-annotation-target','call_question');
    unit.innerHTML='<div data-markdown-text-style="assistant-message">question '+index+'</div>';
    root.append(unit);
   }
  });
  const before=(await p.evaluate(domSnapshot)).messages;
  assert.equal(before.length,2);assert.notEqual(before[0].id,before[1].id);
  await p.evaluate(()=>document.querySelectorAll('[data-content-search-unit-key]').forEach(e=>e.setAttribute('data-content-search-unit-key',e.getAttribute('data-content-search-unit-key')!.replace('old:','new:'))));
  assert.equal(mergeMessages(before,(await p.evaluate(domSnapshot)).messages).length,2);
 }finally{await b.close()}
});

test('folder project uses desktop drag and actual form controls, cancels only its own failed dialog',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-folder-'));const b=await chromium.launch({executablePath:chrome,headless:true});
 try{const p=await b.newPage();await p.setContent('<body data-current-thread="one"><button aria-label="Add new project">add</button><div data-codex-composer contenteditable="true" style="width:200px;height:50px"></div></body>');
  await p.evaluate(()=>{document.querySelector<HTMLButtonElement>('button')!.onclick=()=>{const d=document.createElement('div');d.role='dialog';d.innerHTML='<input aria-label="Project name"><div id="source"><button>Add</button></div><button id="cancel">Cancel</button><button id="create">Create project</button>';d.querySelector('#source')!.addEventListener('dragover',e=>e.preventDefault());d.querySelector('#source')!.addEventListener('drop',(e:any)=>{e.preventDefault();const f=e.dataTransfer.files[0];const button=document.createElement('button');button.setAttribute('aria-label','Remove '+f.name);button.textContent=f.name;d.querySelector('#source')!.replaceChildren(button)});d.querySelector<HTMLButtonElement>('#cancel')!.onclick=()=>d.remove();d.querySelector<HTMLButtonElement>('#create')!.onclick=()=>{const row=document.createElement('div');row.setAttribute('data-app-action-sidebar-project-row','');row.setAttribute('data-app-action-sidebar-project-label',d.querySelector<HTMLInputElement>('input')!.value);row.setAttribute('data-app-action-sidebar-project-id','created');document.body.append(row);d.remove()};document.body.append(d)}});
  assert.equal(await addFolderProject(p,'one',dir,[],async()=>{}),'created');assert.equal(await p.getByRole('dialog').count(),0);
  await assert.rejects(()=>addFolderProject(p,'one',dir,[],async()=>{if(await p.getByRole('dialog').count())throw Error('concurrent change')}),/concurrent/);assert.equal(await p.getByRole('dialog').count(),0);
  await p.evaluate(()=>{
   const add=document.querySelector<HTMLButtonElement>('button[aria-label="Add new project"]')!;
   const open=add.onclick!;
   add.onclick=function(e){
    open.call(this,e);
    const create=document.querySelector<HTMLButtonElement>('#create')!;
    create.onclick=()=>{const trust=document.createElement('div');trust.role='dialog';trust.innerHTML='<h2>Trust this folder?</h2><button>Trust folder</button><button>Cancel</button>';document.body.append(trust)};
   };
  });
  await assert.rejects(()=>addFolderProject(p,'one',dir,[],async()=>{}),/需要桌面确认/);
  assert.equal(await p.getByRole('dialog').count(),2,'trust confirmation and underlying form must remain for explicit user handling');
 }finally{await b.close();fs.rmdirSync(dir)}
});
