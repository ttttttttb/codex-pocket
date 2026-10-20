import type {Page} from 'playwright-core';

// Serialized into the renderer: validate the visible chat immediately before a UI click.
export function atomicClick(el:Element,expected:{contextId:string,emptyDraft?:boolean,confirmationSummary?:string,checkOnly?:boolean,clearDraft?:string}){
  const route=location.pathname+' '+location.hash;
  const active=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];
  const id=document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread')||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(active.length===1?active[0]:null)||document.documentElement.getAttribute('data-pocket-context-id');
  if(active.length>1||id!==expected.contextId||!el.isConnected||(el as HTMLButtonElement).disabled||el.getAttribute('aria-disabled')==='true')return false;
  if(expected.emptyDraft){
    const editors=Array.from(document.querySelectorAll<HTMLElement>('[data-codex-composer][contenteditable="true"], [data-codex-composer] [contenteditable="true"], [data-codex-composer-root] .tiptap[contenteditable="true"], [data-composer-markdown][contenteditable="true"], textarea[data-conversation-id]')).filter(e=>e.offsetWidth&&e.offsetHeight&&!e.closest("[data-codex-composer-request-navigation]"));
    if(editors.length!==1||(editors[0] instanceof HTMLTextAreaElement?editors[0].value:editors[0].innerText).trim())return false;
  }
  if(expected.confirmationSummary&&(el.closest<HTMLElement>('[role="dialog"],[role="alertdialog"]')?.innerText.trim()!==expected.confirmationSummary))return false;
  if(expected.checkOnly)return true;
  if(expected.clearDraft!==undefined){
    if(!(el instanceof HTMLElement)||!(el.isContentEditable||el instanceof HTMLTextAreaElement))return false;
    if((el instanceof HTMLTextAreaElement?el.value:el.innerText).trim()!==expected.clearDraft)return false;
    el.focus();
    if(el instanceof HTMLTextAreaElement){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;setter.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));}
    else{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);document.execCommand('delete');}
    return true;
  }
  (el as HTMLElement).click();return true;
}

// One renderer task checks both context and old value before changing a known field.
export function atomicField(el:Element,expected:{contextId:string,oldValue:string,value:string}){
  const route=location.pathname+' '+location.hash;
  const active=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];
  const id=document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread')||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(active.length===1?active[0]:null)||document.documentElement.getAttribute('data-pocket-context-id');
  if(active.length>1||id!==expected.contextId||!(el instanceof HTMLElement)||!el.isConnected||!el.offsetWidth||(el as HTMLInputElement).disabled)return false;
  const editable=el.isContentEditable;
  if((editable?el.innerText:(el as HTMLInputElement).value)!==expected.oldValue)return false;
  if(editable){el.focus();const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);return document.execCommand(expected.value?'insertText':'delete',false,expected.value);}
  const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLInputElement?HTMLInputElement.prototype:null;
  if(!proto||el instanceof HTMLSelectElement&&!Array.from(el.options).some(o=>o.value===expected.value&&!o.disabled))return false;
  Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,expected.value);
  el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;
}

export async function dismissFloatingMenus(p:Page){
  if(await p.locator('[role="alertdialog"],[role="dialog"][aria-modal="true"],[data-codex-composer-request-navigation]').filter({visible:true}).count())return false;
  const dialogs=p.locator('[role="dialog"]').filter({visible:true});
  if(await dialogs.count()&&await dialogs.locator('input,textarea,[contenteditable="true"]').count())return false;
  const floating=p.locator('[role="menu"],[role="dialog"],button[data-list-navigation-item]').filter({visible:true});
  if(!await floating.count())return true;
  // The custom + menu only closes via its trigger's click handler. Enter opens it
  // again; an outside synthetic click does nothing on the current desktop version.
  // Radix menus instead use pointerdown. Only activate observed, expanded triggers,
  // checking between event types so a successful close cannot reopen the menu.
  const triggers=p.locator('[data-composer-navigation-target="add-context"],button[aria-label="聊天操作"],button[aria-label="Chat actions"],[data-composer-navigation-target="permissions"],[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]').filter({visible:true});
  for(let i=0;i<await triggers.count();i++){
    const trigger=triggers.nth(i);
    const expanded=()=>trigger.evaluate(e=>e.isConnected&&(e.getAttribute('aria-expanded')==='true'||e.getAttribute('data-state')==='open'));
    if(!await expanded())continue;
    await trigger.evaluate(e=>{if(e.getAttribute('aria-expanded')==='true'||e.getAttribute('data-state')==='open')(e as HTMLElement).click()});
    await p.waitForTimeout(80);
    if(await expanded()){
      await trigger.evaluate(e=>{if(e.getAttribute('aria-expanded')==='true'||e.getAttribute('data-state')==='open')e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse',button:0,buttons:1}))});
      await p.waitForTimeout(80);
    }
    if(!await floating.count())return true;
  }
  const editor=p.locator('[data-codex-composer][contenteditable="true"],textarea[data-conversation-id]').filter({visible:true});
  if(await editor.count()!==1)return false;
  // Queue previews can close on a genuine outside pointer. Bound the wait: a
  // portal intercepting pointer input must never stall the operation queue.
  try{await editor.click({timeout:800})}catch{return false}
  for(let n=0;n<5;n++){if(!await floating.count())return true;await p.waitForTimeout(80)}
  return false;
}
