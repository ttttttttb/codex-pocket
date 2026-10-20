import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright-core';
import {CodexDesktop} from '../src/desktop.js';

test('memory-router sidebar identity and semantic assistant Markdown support the same safe UI operations',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--remote-debugging-port=19323','--remote-debugging-address=127.0.0.1']});
 const page=await browser.newPage();
 await page.setContent(`<body><nav>
 <div role="button" data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:one" data-app-action-sidebar-thread-title="First" data-app-action-sidebar-thread-active="true" aria-current="page">First</div>
 <div role="button" data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:two" data-app-action-sidebar-thread-title="Second" data-app-action-sidebar-thread-active="false">Second</div>
 </nav><main><div data-turn-key="first"><div data-content-search-unit-key="first:user"><div data-user-message-bubble>Hello</div></div><div data-content-search-unit-key="first:assistant"><div data-markdown-text-style="assistant-message"><p>Reply</p><pre><code class="language-js">const n=1</code></pre></div></div></div></main>
 <div data-codex-composer-root><div data-codex-composer data-composer-markdown contenteditable="true" style="width:400px;min-height:40px"></div><button aria-label="Send message">Send</button></div>
 <script>document.querySelectorAll('nav div').forEach(row=>row.onclick=()=>{document.querySelectorAll('nav div').forEach(r=>{r.setAttribute('data-app-action-sidebar-thread-active','false');r.removeAttribute('aria-current')});row.setAttribute('data-app-action-sidebar-thread-active','true');row.setAttribute('aria-current','page')});document.querySelector('button').onclick=()=>{const editor=document.querySelector('[contenteditable]');const turn=document.createElement('div');turn.dataset.turnKey='sent-'+Date.now();const user=document.createElement('div');user.dataset.userMessageBubble='';user.textContent=editor.innerText;turn.append(user);document.querySelector('main').append(turn);editor.innerText=''}</script>`);
 const d=new CodexDesktop('http://127.0.0.1:19323',true);
 try{
  const s=await d.snapshot();assert.ok(s.compatible);assert.equal(s.threadId,'local:one');assert.equal(s.title,'First');assert.equal(s.chats.length,2);assert.equal(s.messages.length,2);assert.ok(s.messages.find(m=>m.role==='assistant')?.markdown.includes('```js'));
  const sent=await d.operate({id:crypto.randomUUID(),type:'send',threadId:'local:one',text:'sidebar message'});assert.equal(sent.status,'sent');
  await d.operate({id:crypto.randomUUID(),type:'select',threadId:'local:two'});assert.equal((await d.snapshot()).threadId,'local:two');
  await assert.rejects(()=>d.operate({id:crypto.randomUUID(),type:'send',threadId:'local:one',text:'wrong chat'}),/切换聊天/);
  await page.locator('nav div').first().evaluate(el=>{el.setAttribute('data-app-action-sidebar-thread-active','true');el.setAttribute('aria-current','page')});
  assert.equal((await d.snapshot()).compatible,false);
 }finally{await d.close();await browser.close()}
});
