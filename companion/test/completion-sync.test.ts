import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {domSnapshot,mergeMessages} from '../src/desktop.js';

test('completion folding keeps the final answer after cached commentary, across history remounts and reconnect',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const p=await browser.newPage();
  await p.setContent(`<div data-turn-key="tail:temporary"><div data-content-search-turn-key="logical-turn"><div data-content-search-unit-key="logical-turn:msg_progress1"><div data-markdown-text-style="assistant-message">progress one</div></div><div data-content-search-unit-key="logical-turn:msg_progress2"><div data-markdown-text-style="assistant-message">progress two</div></div></div></div>`);
  let cached=(await p.evaluate(domSnapshot)).messages;const firstId=cached[0].id;
  await p.evaluate(()=>{const root=document.querySelector('[data-content-search-turn-key]')!;root.innerHTML='<div data-local-conversation-final-assistant><div data-content-search-unit-key="logical-turn:msg_final"><div data-response-annotation-target="msg_final"><div data-markdown-text-style="assistant-message">final streaming</div></div></div></div>';const next=document.createElement('div');next.setAttribute('data-turn-key','next');next.innerHTML='<div data-user-message-bubble>why is it missing?</div>';document.body.append(next)});
  let snapshot=(await p.evaluate(domSnapshot)).messages;
  assert.notEqual(snapshot[0].id,firstId,'final must not reuse the first commentary ID');
  cached=mergeMessages(cached,snapshot);
  assert.deepEqual(cached.map(m=>m.markdown),['progress one','progress two','final streaming','why is it missing?']);
  await p.evaluate(()=>{document.querySelector('[data-turn-key]')!.setAttribute('data-turn-key','history:permanent');document.querySelector('[data-markdown-text-style]')!.textContent='final complete'});
  snapshot=(await p.evaluate(domSnapshot)).messages;cached=mergeMessages(cached,snapshot);
  assert.deepEqual(cached.map(m=>m.markdown),['progress one','progress two','final complete','why is it missing?']);
  assert.equal(cached.filter(m=>m.markdown.startsWith('final')).length,1);
  assert.equal(snapshot[0].id,cached[2].id,'cold reads use the same identity');
  // Loading intermediate history must restore its order without duplicating it.
  await p.evaluate(()=>{const root=document.querySelector('[data-content-search-turn-key]')!;root.insertAdjacentHTML('afterbegin','<div data-content-search-unit-key="logical-turn:msg_progress1"><div data-markdown-text-style="assistant-message">progress one</div></div><div data-content-search-unit-key="logical-turn:msg_progress2"><div data-markdown-text-style="assistant-message">progress two</div></div>')});
  assert.deepEqual(mergeMessages(cached,(await p.evaluate(domSnapshot)).messages).map(m=>m.markdown),cached.map(m=>m.markdown));
 }finally{await browser.close()}
});
