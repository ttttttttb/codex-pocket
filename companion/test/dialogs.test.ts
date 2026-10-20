import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium,type Page} from 'playwright-core';
import {CodexDesktop} from '../src/desktop.js';
import {atomicClick,atomicField} from '../src/ui-action.js';
import {readRemoteUi} from '../src/remote-ui.js';

const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
const operation=(s:any,type:string,extra:any={})=>({id:crypto.randomUUID(),type,threadId:s.contextId,expectedRevision:s.settingsRevision,...extra} as any);
const base=`<body data-current-thread="one"><main data-codex-composer-root>
 <div data-turn-key="t"><div data-user-message-bubble>existing</div></div>
 <div data-codex-composer contenteditable="true" style="width:500px;height:50px"></div>
 <button data-composer-navigation-target="permissions">请求批准</button>
 <button data-composer-navigation-target="reasoning" data-selected-reasoning-effort="high"><span data-current-model>Model A</span></button>
 <button aria-label="Send message">Send</button><button aria-label="停止">Stop</button>
 </main></body>`;
async function installCounters(p:Page){await p.evaluate(()=>{
 (window as any).sends=0;(window as any).stops=0;
 document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.onclick=()=>{
  (window as any).sends++;const editor=document.querySelector<HTMLElement>('main [data-codex-composer]')!;
  const turn=document.createElement('div');turn.dataset.turnKey='sent';turn.innerHTML='<div data-user-message-bubble></div>';turn.firstElementChild!.textContent=editor.innerText;document.querySelector('main')!.append(turn);editor.innerText='';
 };
 document.querySelector<HTMLButtonElement>('[aria-label="停止"]')!.onclick=()=>(window as any).stops++;
 document.addEventListener('keydown',e=>{if(e.key==='Escape')(window as any).stops++});
})}
async function permission(p:Page){await p.evaluate(()=>{
 const d=document.createElement('div');d.role='dialog';d.setAttribute('aria-modal','true');
 d.innerHTML='<h2>要开启完整访问权限吗？</h2><p>读取文件，运行命令，使用互联网。</p><button>取消</button><button>确认</button>';
 d.querySelector<HTMLButtonElement>('button')!.onclick=()=>d.remove();
 d.querySelectorAll<HTMLButtonElement>('button')[1].onclick=()=>{document.querySelector('[data-composer-navigation-target="permissions"]')!.textContent='完全访问';d.remove()};document.body.append(d);
})}

test('permission cancellation is bound to the actual dialog instance; identical replacement and other chat are rejected',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19340']});
 const p=await b.newPage();await p.setContent(base);await installCounters(p);
 const d=new CodexDesktop('http://127.0.0.1:19340',true);
 try{
  await permission(p);const first=await d.snapshot();assert.ok(first.compatible);assert.ok(first.confirmation?.surfaceId);
  assert.equal(first.surfaces!.find(s=>s.kind==='dialog')!.id,first.confirmation!.surfaceId);
  const cancel=operation(first,'confirm',{confirmationId:first.confirmation!.id,decision:'decline'});
  await d.operate(cancel);assert.equal(await p.locator('[role="dialog"]').count(),0);
  await permission(p);const next=await d.snapshot();assert.notEqual(next.confirmation!.id,first.confirmation!.id);
  await assert.rejects(()=>d.operate({...cancel,id:crypto.randomUUID()}),/变化/);
  assert.equal(await p.locator('[role="dialog"]').count(),1);
  await assert.rejects(()=>d.operate({...operation(next,'confirm',{confirmationId:next.confirmation!.id,decision:'accept'}),threadId:'other'}),/聊天/);
  await d.operate(operation(next,'confirm',{confirmationId:next.confirmation!.id,decision:'accept'}));
  assert.equal((await d.snapshot()).settings!.find(s=>s.key==='permission')!.value,'完全访问');
  assert.deepEqual(await p.evaluate(()=>[(window as any).sends,(window as any).stops]),[0,0]);
 }finally{await d.close();await b.close()}
});

test('a topmost dialog blocks underlying clicks, fields, send, stop, settings and stale lower dialogs',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19341']});
 const p=await b.newPage();await p.setContent(base);await installCounters(p);
 const d=new CodexDesktop('http://127.0.0.1:19341',true);
 try{
  await p.evaluate(()=>{const m=document.createElement('div');m.role='menu';m.innerHTML='<input aria-label="搜索"><button role="menuitem">底层操作</button>';document.body.append(m)});
  const initial=await d.snapshot(),menu=initial.surfaces!.find(x=>x.kind==='menu')!;
  await permission(p);const lower=await d.snapshot();
  await p.evaluate(()=>{const top=document.createElement('div');top.role='alertdialog';top.innerHTML='<h2>切换设置需要确认</h2><button>暂不</button><button>继续</button>';top.querySelector<HTMLButtonElement>('button')!.onclick=()=>top.remove();document.body.append(top)});
  const s=await d.snapshot();assert.equal(s.confirmation,null);
  for(const type of ['send','stop','ui-close','options'])await assert.rejects(()=>d.operate(operation(s,type,{...(type==='send'?{text:'should not send'}:{}),...(type==='options'?{setting:'effort'}:{})})),/弹窗/);
  await assert.rejects(()=>d.operate(operation(s,'ui-action',{surfaceId:menu.id,revision:menu.revision,actionId:menu.actions[0].id})),/弹窗/);
  await assert.rejects(()=>d.operate(operation(s,'ui-input',{surfaceId:menu.id,revision:menu.revision,fields:{[menu.fields[0].id]:'unsafe'}})),/弹窗/);
  await assert.rejects(()=>d.operate(operation(s,'confirm',{confirmationId:lower.confirmation!.id,decision:'accept'})),/变化/);
  assert.equal(await p.locator('[aria-label="停止"]').evaluate(atomicClick,{contextId:'one'}),false);
  assert.equal(await p.locator('[role="menu"] input').evaluate(atomicField,{contextId:'one',oldValue:'',value:'unsafe'}),false);
  const top=s.surfaces!.filter(x=>x.kind==='dialog').at(-1)!;assert.ok(top.dismissActionId);
  await d.operate(operation(s,'ui-action',{surfaceId:top.id,revision:top.revision,actionId:top.dismissActionId}));
  const restored=await d.snapshot();assert.ok(restored.confirmation);
  await d.operate(operation(restored,'confirm',{confirmationId:restored.confirmation!.id,decision:'decline'}));
  assert.equal(await p.locator('[data-codex-composer]').innerText(),'');
  assert.deepEqual(await p.evaluate(()=>[(window as any).sends,(window as any).stops]),[0,0]);
 }finally{await d.close();await b.close()}
});

test('unclosable dialogs do not invent cancel or accept actions, and stale cancel controls are rejected',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const p=await b.newPage();await p.setContent(base+'<div role="dialog"><h2>只提供确认的窗口</h2><button>确认</button></div>');
  let ui=await p.evaluate(readRemoteUi);assert.equal(ui.surfaces.find(x=>x.kind==='dialog')!.dismissActionId,undefined);
  await p.locator('[role="dialog"]').evaluate(e=>{e.innerHTML='<h2>只有隐藏的取消</h2><button style="display:none">取消</button><button disabled>关闭</button><button>确认</button>'});
  ui=await p.evaluate(readRemoteUi);const s=ui.surfaces.find(x=>x.kind==='dialog')!;assert.ok(s.dismissActionId);assert.ok(s.actions.find(x=>x.id===s.dismissActionId)!.disabled);
  assert.equal(await p.locator('[role="dialog"] button').last().evaluate(atomicClick,{contextId:'one',surfaceId:s.id,actionLabel:'取消'}),false);
  assert.equal(await p.locator('[role="dialog"] button').nth(1).evaluate(atomicClick,{contextId:'one'}),false);
 }finally{await b.close()}
});

test('a confirmation appearing mid-way to Ultra pauses slider adjustments and leaves the task running',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19342']});
 const p=await b.newPage();await p.setContent(base);await installCounters(p);
 await p.evaluate(()=>{
  (window as any).steps=0;const trigger=document.querySelector<HTMLButtonElement>('[data-composer-navigation-target="reasoning"]')!;
  trigger.onclick=()=>{const m=document.createElement('div');m.role='menu';m.innerHTML='<div tabindex="0" data-reasoning-slider><span role="slider" aria-valuemin="0" aria-valuemax="3" aria-valuenow="0">high</span></div>';
   m.firstElementChild!.addEventListener('keydown',(event:Event)=>{if((event as KeyboardEvent).key!=='ArrowRight')return;(window as any).steps++;m.querySelector('[role="slider"]')!.setAttribute('aria-valuenow','1');m.remove();
    const dialog=document.createElement('div');dialog.role='dialog';dialog.innerHTML='<h2>Ultra 与完整访问权限</h2><p>组合设置需要确认</p><button>取消</button><button>继续</button>';dialog.querySelector<HTMLButtonElement>('button')!.onclick=()=>dialog.remove();document.body.append(dialog);
   });document.body.append(m)};
  document.addEventListener('pointerdown',e=>{if((e.target as Element).matches('[data-codex-composer]'))document.querySelector('[role="menu"]')?.remove()});
 });
 const d=new CodexDesktop('http://127.0.0.1:19342',true);
 try{
  let s=await d.snapshot();await d.operate(operation(s,'options',{setting:'effort'}));s=await d.snapshot();
  const result=await d.operate(operation(s,'setting',{setting:'effort',optionId:s.menu!.options.at(-1)!.id}));assert.equal(result.status,'sent');assert.match(result.message,/确认/);
  assert.equal(await p.evaluate(()=>(window as any).steps),1);s=await d.snapshot();assert.equal(s.menu,null);assert.ok(s.surfaces!.some(x=>x.kind==='dialog'));
  const dialog=s.surfaces!.find(x=>x.kind==='dialog')!;await d.operate(operation(s,'ui-action',{surfaceId:dialog.id,revision:dialog.revision,actionId:dialog.dismissActionId}));
  assert.ok((await d.snapshot()).compatible);assert.equal(await p.evaluate(()=>(window as any).stops),0);
 }finally{await d.close();await b.close()}
});

test('right file/browser previews cannot become chat editors; temporary layout hiding recovers without reconnecting',async()=>{
 const b=await chromium.launch({executablePath:chrome,headless:true,args:['--remote-debugging-port=19343']});
 const p=await b.newPage();await p.setContent(base);await installCounters(p);
 await p.evaluate(()=>{const panel=document.createElement('aside');panel.setAttribute('data-app-shell-tab-panel-controller','right');panel.innerHTML='<div data-codex-composer-root><div data-codex-composer contenteditable="true" style="width:300px;height:50px">preview draft</div><button data-composer-navigation-target="permissions">preview permission</button><button aria-label="Send message">preview Send</button></div><div data-turn-key="preview"><div data-user-message-bubble>preview text</div></div>';document.body.prepend(panel)});
 const d=new CodexDesktop('http://127.0.0.1:19343',true);
 try{
  let s=await d.snapshot();assert.ok(s.compatible);assert.equal(s.sendEnabled,true);assert.equal(s.messages.length,1);assert.equal(s.settings!.find(x=>x.key==='permission')!.value,'请求批准');assert.equal(s.draftPresent,false);
  await p.locator('main').evaluate(e=>(e as HTMLElement).style.display='none');
  const start=Date.now();s=await d.snapshot();assert.equal(s.connected,true);assert.equal(s.compatible,false);assert.equal(s.contextId,'one');assert.match(s.error!,/右侧/);assert.ok(Date.now()-start<1500);assert.equal(s.messages.length,1);
  await p.locator('main').evaluate(e=>(e as HTMLElement).style.display='');s=await d.snapshot();assert.ok(s.compatible);
  await d.operate(operation(s,'send',{text:'main chat only'}));assert.equal(await p.locator('aside [data-codex-composer]').innerText(),'preview draft');assert.equal(await p.evaluate(()=>(window as any).sends),1);
  for(let i=0;i<3;i++){await p.locator('aside').evaluate(e=>(e as HTMLElement).hidden=true);assert.ok((await d.snapshot()).compatible);await p.locator('aside').evaluate(e=>(e as HTMLElement).hidden=false);assert.ok((await d.snapshot()).compatible)}
 }finally{await d.close();await b.close()}
});
