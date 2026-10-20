import crypto from 'node:crypto';
import type {Page} from 'playwright-core';
import {SafeError,type Snapshot} from './types.js';
import {atomicClick,atomicField,dismissFloatingMenus} from './ui-action.js';

export type UiAction={id:string,label:string,disabled:boolean,selected:boolean,submenu:boolean,confirm:boolean,description?:string,images?:ImageRef[]};
export type UiField={id:string,label:string,value:string,type:string,options?:{value:string,label:string}[]};
export type UiSurface={id:string,revision:string,kind:'menu'|'question'|'dialog'|'composer'|'goal',title:string,actions:UiAction[],fields:UiField[],body?:string,dismissActionId?:string};
export type Queued={id:string,revision:string,text:string,actions:UiAction[],images:ImageRef[]};
export type ImageRef={id:string,alt:string};
export const uiHash=(v:unknown)=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// Read only semantic desktop controls. The phone never chooses a selector or a script.
export function readRemoteUi(){
 const uuid=()=>crypto.randomUUID?.()||'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));
 const visible=(e:Element)=>!!(e as HTMLElement).offsetWidth&&!e.closest('[inert],[aria-hidden="true"]');
 const inChat=(e:Element)=>visible(e)&&!e.closest('[data-app-shell-tab-panel-controller="right"]');
 const mark=(e:Element)=>{let id=e.getAttribute('data-pocket-ui-id');if(!id){id=uuid();e.setAttribute('data-pocket-ui-id',id)}return id};
 const label=(e:Element)=>(e.getAttribute('aria-label')||(e as HTMLElement).innerText||e.getAttribute('title')||'').trim();
 const images=(root:Element)=>Array.from(root.querySelectorAll<HTMLImageElement>('img')).map(e=>{const img=e as HTMLImageElement&{__pocketSrc?:string};const src=e.currentSrc||e.src;if(!e.getAttribute('data-pocket-image-id')||img.__pocketSrc!==src){e.setAttribute('data-pocket-image-id',uuid());img.__pocketSrc=src}return{id:e.getAttribute('data-pocket-image-id')!,alt:e.alt||'图片'}});
 const action=(e:Element)=>{
  const copy=e.cloneNode(true) as HTMLElement;copy.querySelectorAll('[aria-hidden="true"]').forEach(e=>e.remove());
  const text=copy.textContent?.trim()||'',name=label(e),description=text.startsWith(name)?text.slice(name.length).trim():'';
  return {id:mark(e),label:name,disabled:!!(e as HTMLButtonElement).disabled||e.getAttribute('aria-disabled')==='true',selected:e.getAttribute('aria-checked')==='true'||e.getAttribute('aria-selected')==='true'||e.getAttribute('aria-pressed')==='true'||!!e.querySelector<HTMLInputElement>('input:checked'),submenu:e.getAttribute('aria-haspopup')==='menu',confirm:/^(?:归档|删除|移除|清除目标|Archive|Delete|Remove|Clear goal)/i.test(name),...(description?{description}:{})};
 };
 const actions=(root:Element)=>Array.from(root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="radio"],[role="checkbox"],[role="option"],label:has(input[type="radio"]),label:has(input[type="checkbox"])')).filter(e=>visible(e)&&label(e)&&!e.closest('[role="menubar"]')).filter((e,_,a)=>!a.some(o=>o!==e&&o.contains(e))).map(action);
 const fields=(root:Element)=>Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="password"]),textarea,select,[contenteditable="true"]')).filter(visible).map(e=>({id:mark(e),label:e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.placeholder||'填写回答',value:e.isContentEditable?e.innerText.trimEnd():e.value,type:e.isContentEditable?'textarea':e.tagName==='SELECT'?'select':e.type,...(e.tagName==='SELECT'?{options:Array.from((e as unknown as HTMLSelectElement).options).filter(o=>!o.disabled).map(o=>({label:o.label,value:o.value}))}:{})}));
 const surface=(root:HTMLElement,kind:UiSurface['kind']):Omit<UiSurface,'revision'>=>{
   const as=actions(root);
   // Closing is an explicit desktop cancel/close control, never Escape, an
   // arbitrary outside click, or the first available (possibly affirmative) button.
   const cancel=as.filter(a=>/^(?:取消|关闭(?:对话框|弹窗)?|返回|暂不|以后再说|Cancel|Close(?: dialog)?|Go back|Not now|Maybe later)$/i.test(a.label));
   const dismiss=cancel.length===1?cancel[0]:cancel.find(a=>/^(?:取消|Cancel)$/i.test(a.label));
   return {id:mark(root),kind,title:root.querySelector('h1,h2,h3,[role="heading"],[data-question-title],span.whitespace-pre-wrap')?.textContent?.trim()||(kind==='menu'?'聊天操作':root.innerText.slice(0,1500)),actions:as,fields:fields(root),...(kind==='dialog'?{body:root.innerText.slice(0,50000),...(dismiss?{dismissActionId:dismiss.id}:{})}:{})};
 };
 const roots=Array.from(document.querySelectorAll<HTMLElement>('[data-codex-composer-request-navigation],[data-codex-question],[role="dialog"],[role="alertdialog"],[class~="@container/request-card"],form[data-codex-character-input-boundary][data-codex-escape-boundary]')).filter(visible).filter(e=>!e.closest('[data-app-shell-tab-panel-controller="right"]')||!!e.closest('[role="dialog"],[role="alertdialog"]')).filter((e,_,a)=>e.matches('[role="dialog"],[role="alertdialog"]')||!e.closest('[role="dialog"],[role="alertdialog"]')&&!a.some(o=>o!==e&&o.contains(e)));
 const surfaces=roots.map(e=>surface(e,e.matches('[role="dialog"],[role="alertdialog"]')?'dialog':'question')).filter(s=>s.kind==='dialog'||s.actions.length||s.fields.length);
 const menus=Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(e=>visible(e)&&!e.closest('[role="menubar"]'));
 const plus=Array.from(document.querySelectorAll<HTMLElement>('button[data-list-navigation-item]')).filter(inChat);
 if(menus.length)surfaces.push(surface(menus.at(-1)!,'menu'));
 else if(plus.length){const parent=plus[0].parentElement!;surfaces.push({id:mark(parent),kind:'menu',title:'添加内容',actions:plus.filter(e=>label(e)).map(action),fields:fields(parent)})}
 for(const s of surfaces)s.actions=s.actions.filter(a=>!/(?:侧边聊天|右侧面板|新窗口|New side chat|Open in side chat|Move to side|Open in new window)/i.test(a.label));
 const footer=Array.from(document.querySelectorAll<HTMLElement>('[data-codex-composer-root],[data-composer-footer-responsive]')).find(e=>!e.closest('[data-app-shell-tab-panel-controller="right"]'));
 if(footer){const modes=Array.from(footer.querySelectorAll('button')).filter(e=>visible(e)&&/^(?:目标|明确目标|计划|Goal|Set goal|Plan)$/i.test(label(e)));if(modes.length)surfaces.push({id:mark(footer),kind:'composer',title:'当前输入模式',fields:[],actions:modes.map(e=>({...action(e),label:/目标|goal/i.test(label(e))?'目标':'计划',selected:true}))})}
 for(const clear of document.querySelectorAll<HTMLButtonElement>('button[aria-label="清除目标"],button[aria-label="Clear goal"]')){if(!visible(clear))continue;let row=clear.parentElement;while(row&&row!==document.body&&!Array.from(row.querySelectorAll('button')).some(b=>/^(?:进行中的目标|已暂停的目标|Active goal|Paused goal)/i.test(label(b))))row=row.parentElement;if(row&&row!==document.body){const title=Array.from(row.querySelectorAll('button')).find(b=>/^(?:进行中的目标|已暂停的目标|Active goal|Paused goal)/i.test(label(b)))!;surfaces.push({id:mark(row),kind:'goal',title:label(title).split('\n').slice(0,2).join('\n').replace(/\s*•\s*$/,''),actions:actions(row).filter(a=>a.id!==mark(title)),fields:[]})}}
 const queue:Omit<Queued,'revision'>[]=[];const seen=new Set<Element>();
 for(const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(e=>inChat(e)&&(/^(?:引导|Steer|重试|Retry)(?:\s|$)/i.test(label(e))||/删除.*(?:排队|队列|待处理)|Delete queued message/i.test(label(e))))){
   let root:HTMLElement|null=b.parentElement;
   while(root&&root!==document.body){const bs=Array.from(root.querySelectorAll('button'));if(bs.some(x=>/删除|移除|Delete|Remove/i.test(label(x)))&&root.innerText.trim()!==label(b))break;root=root.parentElement;}
   if(!root||root===document.body||seen.has(root)||root.querySelector('[data-codex-composer][contenteditable]'))continue;seen.add(root);
   const copy=root.cloneNode(true) as HTMLElement;copy.querySelectorAll('button').forEach(e=>e.remove());const text=copy.textContent?.trim()||root.innerText.trim();
   const as=actions(root).map(a=>/预览.*(?:消息|提示)|Preview queued message/i.test(a.label)?{...a,label:'查看完整消息'}:a);const preview=Array.from(root.querySelectorAll('[aria-label]')).find(e=>/预览.*(?:消息|提示)|Preview queued message/i.test(e.getAttribute('aria-label')||''));if(preview&&!as.some(a=>a.id===mark(preview)))as.push({...action(preview),label:'查看完整消息'});
   queue.push({id:mark(root),text,actions:as,images:images(root)});
 }
 const attachments=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(e=>inChat(e)&&/^移除[“"].+[”"]$|^Remove .+/i.test(label(e))).map(e=>({...action(e),images:images(e.parentElement!)}));
 const send=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(e=>inChat(e)&&/^(?:排队|Queue|Send|Send message|Send prompt|Submit|Submit prompt|发送|发送消息|引导|Steer)(?:\s*\([^)]*\))?$/i.test(label(e))&&!queue.some(q=>document.querySelector(`[data-pocket-ui-id="${q.id}"]`)?.contains(e)));
 const queueRows=queue.filter(q=>{const root=document.querySelector('[data-pocket-ui-id="'+q.id+'"]');return !queue.some(other=>other.id!==q.id&&document.querySelector('[data-pocket-ui-id="'+other.id+'"]')?.contains(root))});
 return {surfaces,queue:queueRows,attachments,composerPlaceholder:document.querySelector('[data-codex-composer][contenteditable="true"]')?.getAttribute('aria-label')||'',sendLabel:send.length===1?label(send[0]):'',sendEnabled:send.length===1&&!send[0].disabled};
}

export class RemoteUi{
 async read(p:Page){const s=await p.evaluate(readRemoteUi);return {...s,surfaces:s.surfaces.map(x=>({...x,revision:uiHash(x)})),queue:s.queue.map(x=>({...x,revision:uiHash(x)}))}}
 async open(p:Page,which:'plus'|'chat',s:Snapshot){
   if(s.confirmation)throw new SafeError('CONFIRMATION','请先处理当前确认请求。');
   if(await p.locator('[role="dialog"],[role="alertdialog"],[data-codex-composer-request-navigation]').filter({visible:true}).count())throw new SafeError('REQUEST','请先处理电脑上的问题或对话框。');
   const selector=which==='plus'?'[data-composer-navigation-target="add-context"]':'button[aria-label="聊天操作"],button[aria-label="Chat actions"]';
   const b=p.locator(selector).filter({visible:true});if(await b.count()!==1)throw new SafeError('NO_MENU','无法识别桌面菜单入口。');
   // A keyboard activation opens the desktop's actual menu; Escape is never sent.
   if(!await b.evaluate(atomicClick,{contextId:s.contextId!,checkOnly:true}))throw new SafeError('CHAT_CHANGED','聊天已变化。');
    if(!await b.evaluate(e=>e.getAttribute('aria-expanded')==='true'||e.getAttribute('data-state')==='open'))await b.press('Enter',{timeout:1200});
   if(!(await this.read(p)).surfaces.some(x=>x.kind==='menu'))throw new SafeError('NO_MENU','桌面未显示菜单，请重试。');
   return '已打开桌面菜单。';
 }
 async close(p:Page){if(!await dismissFloatingMenus(p))throw new SafeError('MENU_CLOSE','电脑菜单未能关闭，请在手机重试关闭；聊天指令未发送。');}

 async act(p:Page,s:Snapshot,op:{surfaceId:string,revision:string,actionId:string,fields?:Record<string,string>}){
   const live=await this.read(p);const source=[...live.surfaces,...live.queue].find(x=>x.id===op.surfaceId);
   const modal=live.surfaces.filter(x=>x.kind==='dialog').at(-1);
   if(modal&&modal.id!==op.surfaceId)throw new SafeError('DIALOG_OPEN','请先处理手机上显示的桌面弹窗，未操作底层控件。');
   if(!source||source.revision!==op.revision)throw new SafeError('STALE_UI','电脑上的问题、菜单或消息已变化，请刷新。');
   const a=source.actions.find(x=>x.id===op.actionId);if(!a||a.disabled&&!Object.keys(op.fields||{}).length)throw new SafeError('NO_ACTION','此操作当前不可用。');
   const fs='fields'in source?source.fields:[];
   for(const [id,value]of Object.entries(op.fields||{})){
     if(!fs.some(f=>f.id===id))throw new SafeError('BAD_FIELD','不支持的输入项目。');
     const el=p.locator(`[data-pocket-ui-id="${id}"]`);if(await el.count()!==1)throw new SafeError('STALE_UI','输入项目已变化。');
     const field=fs.find(f=>f.id===id)!;
     if(field.type==='select'&&!field.options?.some(o=>o.value===value))throw new SafeError('BAD_VALUE','选项已不可用。');
     if(!await el.evaluate(atomicField,{contextId:s.contextId!,oldValue:field.value,value}))throw new SafeError('STALE_UI','聊天或电脑输入已变化，未覆盖。');
   }
   const fresh=await this.read(p),now=[...fresh.surfaces,...fresh.queue].find(x=>x.id===op.surfaceId);
   if(!now||(!Object.keys(op.fields||{}).length&&now.revision!==op.revision)||!now.actions.some(x=>x.id===a.id&&x.label===a.label&&!x.disabled))throw new SafeError('STALE_UI','控件在提交前已变化。');
   const el=p.locator(`[data-pocket-ui-id="${a.id}"]`);if(await el.count()!==1)throw new SafeError('STALE_UI','控件已变化。');
   const dirty=s.draftPresent&&(/^编辑消息|^Edit message/i.test(a.label)||source.actions.some(x=>/^文件和文件夹|^绘图|^目标|^计划模式|^Documents|^PDF|^Spreadsheets|^Presentations|^Template Creator|^浏览器|^电脑|^Visualize|^归档|^创建聊天分支/.test(x.label)));
   if(dirty)throw new SafeError('DRAFT','电脑有未发送草稿，请先处理。');
   if(a.submenu){await el.focus();await el.press((await el.getAttribute('role'))?.startsWith('menuitem')?'ArrowRight':'Enter');return '已读取子菜单。';}
   const desktopLabel=await el.evaluate(e=>(e.getAttribute('aria-label')||(e as HTMLElement).innerText||e.getAttribute('title')||'').trim());
   if(!await el.evaluate(atomicClick,{contextId:s.contextId!,surfaceId:source.id,actionLabel:desktopLabel,...('kind'in now&&now.kind==='dialog'?{confirmationSummary:now.body?.trim()}:{})}))throw new SafeError('CHAT_CHANGED','聊天、弹窗或控件已变化，未操作。');
   if('kind'in source&&source.kind==='dialog'&&a.id===source.dismissActionId){
     const original=p.locator('[data-pocket-ui-id="'+source.id+'"]');
     for(let i=0;i<10;i++){if(!await original.count()||!await original.isVisible())return '已关闭桌面弹窗。';await p.waitForTimeout(80)}
     throw new SafeError('NOT_CONFIRMED','已点击取消，但尚未确认桌面弹窗已关闭，请核对后再操作。');
   }
   return '已操作桌面控件，正在同步结果。';
 }
 async input(p:Page,s:Snapshot,op:{surfaceId:string,revision:string,fields:Record<string,string>}){
   const live=await this.read(p),source=live.surfaces.find(x=>x.id===op.surfaceId);
   const modal=live.surfaces.filter(x=>x.kind==='dialog').at(-1);
   if(modal&&modal.id!==op.surfaceId)throw new SafeError('DIALOG_OPEN','请先处理当前桌面弹窗。');
   if(!source||source.revision!==op.revision)throw new SafeError('STALE_UI','电脑输入界面已变化，请刷新。');
   for(const[id,value]of Object.entries(op.fields)){const field=source.fields.find(f=>f.id===id);if(!field)throw new SafeError('BAD_FIELD','输入项目无效。');
     const el=p.locator('[data-pocket-ui-id="'+id+'"]');
     if(field.type==='select'&&!field.options?.some(o=>o.value===value))throw new SafeError('BAD_VALUE','选项已不可用。');
     if(!await el.evaluate(atomicField,{contextId:s.contextId!,oldValue:field.value,value}))throw new SafeError('STALE_UI','聊天或电脑输入已变化，未覆盖。');
   }
   return '已更新桌面输入。';
 }
}
