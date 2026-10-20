import {chromium,type Browser,type Page} from 'playwright-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DesktopControls,readControls} from './controls.js';
import {atomicClick} from './ui-action.js';
import {RemoteUi} from './remote-ui.js';
import {Transfers} from './transfers.js';
import {GeneratedFiles,type ObservedFileLink} from './generated-files.js';
import {emptySnapshot,SafeError,type Desktop,type Snapshot,type Operation,type OperationResult,type Message} from './types.js';

const QUESTION_EXCLUSION=':not([data-codex-composer-request-navigation] *):not([class~="@container/request-card"] *):not(form[data-codex-character-input-boundary][data-codex-escape-boundary] *):not([data-app-shell-tab-panel-controller="right"] *)';
export const COMPOSER='[data-codex-composer][contenteditable="true"], [data-codex-composer] [contenteditable="true"], [data-codex-composer-root] .tiptap[contenteditable="true"], [data-composer-markdown][contenteditable="true"], textarea[data-conversation-id]'.split(', ').map(s=>s+QUESTION_EXCLUSION).join(', ');
const SEND=/^(?:Queue|排队|Send|Send message|Send prompt|Submit|Submit prompt|Steer|Steer prompt|发送|发送消息|发送提示|提交|提交提示|引导|立即发送)(?:\s*\([^)]*\))?$/i;
const STOP=/^(?:Stop|Stop task|Stop response|Stop generating|Interrupt|停止|停止任务|停止生成|停止响应|中断)(?:\s*\([^)]*\))?$/i;

// These functions are serialized by Playwright; keep them independent of module scope.
export function domSnapshot():Omit<Snapshot,'connected'|'compatible'|'error'|'version'>&{fileLinks:ObservedFileLink[]}{
  const visible=(e:Element)=>!!(e as HTMLElement).offsetWidth&&!!(e as HTMLElement).offsetHeight&&!e.closest('[data-app-shell-tab-panel-controller="right"]');
  const tidy=(s:string)=>(s||'').replace(/\u00a0/g,' ').trim();
  const uuid=()=>crypto.randomUUID?.()||'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));
  const usedImages=new Set<string>();
  const imageRefs=(root:Element)=>Array.from(root.querySelectorAll<HTMLImageElement>("img")).filter(e=>!e.closest('[aria-hidden="true"],[inert]')).map(e=>{
    const img=e as HTMLImageElement&{__pocketSrc?:string};const src=e.currentSrc||e.src;
    if(!e.getAttribute("data-pocket-image-id")||img.__pocketSrc!==src){e.setAttribute("data-pocket-image-id",uuid());img.__pocketSrc=src}
    return {id:e.getAttribute("data-pocket-image-id")!,alt:e.alt||"图片"};
  });
  const md=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';
    if(!(node instanceof HTMLElement))return '';
    if(node.matches('button,script,style,svg,[aria-hidden="true"],[data-markdown-copy="exclude"],input,textarea'))return '';
    const tag=node.tagName.toLowerCase();
    if(tag==='pre'){const code=node.querySelector('code');const lang=code?.className.match(/language-([\w+-]+)/)?.[1]||'';return'\n\n```'+lang+'\n'+(code?.textContent||node.textContent||'').replace(/\n$/,'')+'\n```\n\n';}
    const text=Array.from(node.childNodes).map(md).join('');
    if(tag==='br')return'\n';if(tag==='code')return'`'+text+'`';
    if(tag==='strong'||tag==='b')return'**'+text+'**';if(tag==='em')return'*'+text+'*';
    if(/^h[1-6]$/.test(tag))return'\n\n'+'#'.repeat(Number(tag[1]))+' '+text+'\n\n';
    if(tag==='li')return'\n- '+text.trim();if(tag==='a'){const href=node.getAttribute('href')||'';return /^https?:\/\//i.test(href)?'['+text+']('+href+')':text;}
    if(['p','div','section','article','ul','ol','blockquote'].includes(tag))return'\n'+text+'\n';
    return text;
  };
  const route=location.pathname+' '+location.hash;
  const marker=document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread');
  const threadId=marker||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(()=>{const ids=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];return ids.length===1?ids[0]:null})()||null;
  const composer=Array.from(document.querySelectorAll<HTMLElement>('[data-codex-composer][contenteditable="true"], [data-codex-composer] [contenteditable="true"], [data-codex-composer-root] .tiptap[contenteditable="true"], [data-composer-markdown][contenteditable="true"], textarea[data-conversation-id]')).find(e=>visible(e)&&!e.closest("[data-codex-composer-request-navigation]"));
  const projectFor=(row:Element)=>{let el=row.parentElement;while(el&&!el.matches('[data-app-action-sidebar-section]')){const projects=el.querySelectorAll('[data-app-action-sidebar-project-row]');if(projects.length===1)return projects[0].getAttribute('data-app-action-sidebar-project-id');el=el.parentElement;}return null;};
  const sidebarChats=Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row]')).flatMap(row=>{const id=row.getAttribute('data-app-action-sidebar-thread-id');const title=tidy(row.getAttribute('data-app-action-sidebar-thread-title')||'');return id&&title?[{id,title:title.slice(0,150),active:id===threadId,projectId:projectFor(row)}]:[]});
  const chats=[...sidebarChats,...Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap(a=>{const id=a.getAttribute('href')?.match(/\/(?:local|threads|thread)\/([^/?#]+)/)?.[1];return id&&tidy(a.innerText)?[{id,title:tidy(a.innerText).slice(0,150),active:id===threadId}]:[]})].filter((c,i,a)=>a.findIndex(x=>x.id===c.id)===i);
  const messages:Message[]=[];
  const fileLinks:ObservedFileLink[]=[];
  // Attachments are siblings of the text bubble. A turn can contain several
  // user messages (steering/replies), so the whole turn is not their owner.
  const userRoots=Array.from(document.querySelectorAll<HTMLElement>('[data-content-search-unit-key]')).filter(e=>!!e.querySelector('[data-user-message-bubble],[aria-label="用户附件"],[aria-label="User attachment"],img[alt="用户附件"],img[alt="User attachment"],[data-composer-attachment-pill]')||e.hasAttribute('data-local-conversation-user-anchor'));
  const candidates=[...new Set([...userRoots,...Array.from(document.querySelectorAll<HTMLElement>('[data-turn-key] [data-user-message-bubble], [data-turn-key] .markdown, [data-turn-key] .prose, [data-turn-key] [data-markdown-text-style="assistant-message"], [data-message-role], [data-content-search-unit-key] article'))])].filter(e=>!userRoots.some(u=>u!==e&&u.contains(e))).sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
  const slots=new Map<string,number>();
  for(const el of candidates){
    if(!visible(el)||el.closest('[aria-hidden="true"],[inert]'))continue;
    if(el.closest('[data-codex-composer-root]'))continue;
    // Prefer the semantic message content to its surrounding article; avoid duplicate wrappers.
    if(el.matches('article,[data-message-role]')&&el.querySelector('[data-user-message-bubble],[data-markdown-text-style="assistant-message"],.markdown,.prose'))continue;
    if(el.matches('.markdown,.prose')&&el.querySelector('[data-markdown-text-style="assistant-message"]'))continue;
    if(el.matches('.markdown,.prose')&&el.parentElement?.closest('[data-markdown-text-style="assistant-message"]'))continue;
    if(el.matches('.prose')&&el.closest('.markdown')!==null)continue;
    if(el.matches('.markdown,.prose')&&el.closest('[data-user-message-bubble]'))continue;
    const unit=el.closest('[data-content-search-unit-key]');const turn=el.closest('[data-turn-key]');
    const role=userRoots.includes(el)||el.matches('[data-user-message-bubble]')||el.getAttribute('data-message-role')==='user'?'user':el.getAttribute('data-message-role')==='activity'?'activity':'assistant';
    const turnId=el.closest('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key')||turn?.getAttribute('data-turn-key')||undefined,unitId=unit?.getAttribute('data-content-search-unit-key')||undefined;
    const key=turnId||el.getAttribute('data-message-id')||unitId||'visible';
    const textRoot=role==='user'&&userRoots.includes(el)?el.querySelector('[data-user-message-bubble]'):el;
    let markdown=textRoot?tidy(md(textRoot)).replace(/\n{3,}/g,'\n\n'):'';
    const images=imageRefs(el);images.forEach(i=>usedImages.add(i.id));
    const attachedFiles=role==='user'?Array.from(el.querySelectorAll<HTMLElement>('[data-composer-attachment-pill]')).map((f,i)=>({id:key+':file:'+i,name:tidy(f.getAttribute('aria-label')||f.textContent||'附件')})).filter(f=>!!f.name):[];
    if(!markdown&&!images.length&&!attachedFiles.length)continue;
    const slotKey=key+':'+role,slot=slots.get(slotKey)||0;slots.set(slotKey,slot+1);
    const id=slotKey+':'+slot;
    messages.push({id,role,markdown,turnId,unitId,slot,images,attachedFiles:attachedFiles.map((f,i)=>({...f,id:id+':file:'+i}))});
    if(role==='assistant')for(const a of el.querySelectorAll('a[href],[data-file-reference][data-markdown-copy-text]'))fileLinks.push({messageId:id,href:a.getAttribute('href')||a.getAttribute('data-markdown-copy-text')||'',label:tidy(a.textContent||'')});
  }
  for(const turn of document.querySelectorAll<HTMLElement>("[data-turn-key]")){
    if(!visible(turn)||turn.querySelector("[data-turn-key]"))continue;
    const images=imageRefs(turn).filter(i=>!usedImages.has(i.id));if(!images.length)continue;
    images.forEach(i=>usedImages.add(i.id));const turnId=turn.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key')||turn.getAttribute("data-turn-key")!;
    const role=turn.querySelector('[data-user-message-bubble],[aria-label="用户附件"],[aria-label="User attachment"],img[alt="用户附件"],img[alt="User attachment"]')?"user":"assistant";
    const existing=messages.find(m=>m.turnId===turnId&&m.role===role);
    if(existing)existing.images=[...(existing.images||[]),...images];else messages.push({id:turnId+":"+role+":0",role,markdown:"",turnId,images});
  }
  if(!messages.length)for(const el of document.querySelectorAll<HTMLElement>('[data-turn-key]')){
    if(!visible(el)||el.querySelector('[data-turn-key]'))continue;const markdown=tidy(md(el)).replace(/\n{3,}/g,'\n\n');if(markdown)messages.push({id:el.dataset.turnKey||'visible',role:'activity',markdown});
  }
  const fingerprint=(s:string)=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16)};
  const approvals=Array.from(document.querySelectorAll<HTMLElement>('[data-codex-composer-request-navigation]')).filter(visible).flatMap(root=>{
    const buttons=Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter(visible);
    const label=(b:HTMLButtonElement)=>tidy(b.getAttribute('aria-label')||b.innerText);
    const a=buttons.find(b=>/^(?:Approve|Allow|Accept|允许|批准|同意)(?: once| this time|本次|一次)?$/i.test(label(b)));
    const d=buttons.find(b=>/^(?:Deny|Decline|Reject|拒绝|不允许)$/i.test(label(b)));
    if(!a||!d)return[];const summary=tidy(root.innerText);return[{id:fingerprint(summary),summary,acceptLabel:label(a),declineLabel:label(d)}];
  });
  const title=chats.find(c=>c.active)?.title||document.querySelector('h1')?.textContent?.trim()||document.title;
  const root=composer?.closest('[data-codex-composer-root]')||document.querySelector('[data-composer-footer-responsive]')||document;
  const queued=Array.from(root.querySelectorAll("button")).some(b=>visible(b)&&/^(?:Queue|排队|Steer|引导)$/i.test(b.getAttribute("aria-label")||""));
  const busy=queued||Array.from(root.querySelectorAll('button')).some(b=>visible(b)&&/^(?:Stop|Stop task|Stop response|Stop generating|Interrupt|停止|停止任务|停止生成|停止响应|中断)(?:\s*\([^)]*\))?$/i.test(tidy(b.getAttribute('aria-label')||b.textContent||'')));
  return{threadId,title,messages,fileLinks,chats,draftPresent:!!tidy(composer instanceof HTMLTextAreaElement?composer.value:composer?.innerText||''),busy,approvals,canLoadOlder:!!document.querySelector('[data-turn-key]')};
}

export function mergeMessages(old:Message[],visible:Message[]):Message[]{
  if(!old.length)return visible;
  const result=[...old];
  for(let i=0;i<visible.length;i++){
    const m=visible[i],index=result.findIndex(p=>p.id===m.id);
    if(index>=0){result[index]=m;continue;}
    const next=visible.slice(i+1).find(n=>result.some(p=>p.id===n.id));
    if(next)result.splice(result.findIndex(p=>p.id===next.id),0,m);else result.push(m);
  }
  return result;
}

export class CodexDesktop implements Desktop {
  private browser:Browser|null=null;private page:Page|null=null;
  private cache=new Map<string,Message[]>();
  private controls=new DesktopControls();
  private remoteUi=new RemoteUi();
  private transfers=new Transfers();
  private generatedFiles=new GeneratedFiles();
  private ownedDraft:{contextId:string,text:string,editable?:boolean}|null=null;
  private lastContext:string|null=null;
  private newContext:string|null=null;
  private newProjectId:string|null=null;
  private desktopVersion:string|null=null;
  private versionCheckedAt=0;
  constructor(private endpoint='http://127.0.0.1:9222',private fixture=false){}
  private async checkVersion(){
    if(this.fixture)return 'fixture';
    if(Date.now()-this.versionCheckedAt<30000&&this.desktopVersion)return this.desktopVersion;
    let detected='';
    try{const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()'],{timeout:5000,windowsHide:true});detected=stdout.trim();}catch{}
    if(!detected){
      const dir=process.env.POCKET_STATE_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPocket');
      try{const config=path.join(dir,'desktop-install.json');const manifest=process.env.POCKET_CODEX_MANIFEST||(fs.existsSync(config)?JSON.parse(fs.readFileSync(config,'utf8')).manifest:null);
        if(typeof manifest==='string'&&path.basename(manifest).toLowerCase()==='appxmanifest.xml')detected=fs.readFileSync(manifest,'utf8').match(/<Identity\b[^>]*\bVersion="([\d.]+)"/i)?.[1]||'';
      }catch{}
    }
    if(!/^\d+(?:\.\d+){2,3}$/.test(detected))throw new SafeError('NO_VERSION','无法确认桌面 Codex 版本，已暂停远程操作。');
    if(this.desktopVersion&&this.desktopVersion!==detected)throw new SafeError('VERSION_CHANGED','检测到 Codex 版本已更新，请重启配套程序并重新执行同一聊天连接测试。');
    this.desktopVersion=detected;this.versionCheckedAt=Date.now();return detected;
  }
  private async connect(){
    if(this.browser?.isConnected()&&this.page&&!this.page.isClosed())return this.page;
    const url=new URL(this.endpoint);if(!['127.0.0.1','localhost'].includes(url.hostname))throw new SafeError('BAD_CDP','桌面控制端口必须仅限本机。');
    if(!this.browser?.isConnected())this.browser=await chromium.connectOverCDP(this.endpoint,{timeout:3000});
    const pages=this.browser.contexts().flatMap(c=>c.pages());
    this.page=null;
    const candidates:Page[]=[];
    for(const p of pages){if(p.isClosed())continue;const u=p.url();if(!this.fixture&&!/^(?:app|codex|file):\/\//.test(u))continue;
      if(await p.locator(COMPOSER+', [data-current-thread],[data-app-action-sidebar-thread-active="true"][aria-current="page"],[data-codex-composer-request-navigation],[data-codex-question],[class~="@container/request-card"]').filter({visible:true}).count())candidates.push(p);
    }
    if(candidates.length>1)throw new SafeError('MULTIPLE_WINDOWS','检测到多个 Codex 聊天窗口，请先保留一个窗口以免操作错误。');
    this.page=candidates[0]||null;
    if(!this.page)throw new SafeError('NO_CODEX','找不到 Codex 聊天输入框。请在桌面打开一段本地聊天。');
    this.page.setDefaultTimeout(2000);return this.page;
  }
  async snapshot():Promise<Snapshot>{
    try{
      const p=await this.connect();
      const desktopVersion=await this.checkVersion();
      for(const other of this.browser!.contexts().flatMap(c=>c.pages())){
        if(other===p||other.isClosed()||(!this.fixture&&!/^(?:app|codex|file):\/\//.test(other.url())))continue;
        if(await other.locator(COMPOSER).filter({visible:true}).count())throw new SafeError('MULTIPLE_WINDOWS','检测到多个 Codex 聊天窗口，请先保留一个窗口以免操作错误。');
      }
      const {fileLinks,...state}=await p.evaluate(domSnapshot);
      const editorCount=await p.locator(COMPOSER).filter({visible:true}).count();
      if(editorCount!==1){
        // Preview/browser layout transitions can temporarily hide or remount the
        // main editor. Keep the CDP page and readable state so the next poll can
        // recover, rather than timing out and throwing away the conversation.
        const ui=await p.evaluate(readControls),remote=await this.remoteUi.read(p);
        if(state.threadId){state.messages=mergeMessages(this.cache.get(state.threadId)||[],state.messages);this.cache.set(state.threadId,state.messages);this.newContext=null;await p.evaluate(()=>document.documentElement.removeAttribute('data-pocket-context-id'));}
        const active=await p.locator('[data-app-action-sidebar-thread-active="true"][aria-current="page"]').evaluateAll(es=>[...new Set(es.map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))]);
        const newOwner=await p.evaluate(()=>document.documentElement.getAttribute('data-pocket-context-id'));
        const contextId=state.threadId||(newOwner===this.newContext?newOwner:null)||undefined;
        const canRespond=editorCount===0&&!!contextId&&active.length<=1&&(remote.surfaces.some(x=>x.kind==='dialog'||x.kind==='question')||state.approvals.length>0);
        state.approvals=state.approvals.map(a=>({...a,id:crypto.createHash('sha256').update(a.summary).digest('hex')}));
        if(ui.confirmation)ui.confirmation.id=crypto.createHash('sha256').update(JSON.stringify({contextId,surfaceId:ui.confirmation.surfaceId,summary:ui.confirmation.summary})).digest('hex');
        if(contextId)await this.generatedFiles.observe(contextId,state.messages,fileLinks);
        await this.registerImages(p);
        return {...state,...ui,...remote,connected:true,compatible:canRespond,contextId,screen:state.threadId?'chat':'new',version:'0.4.1',protocolVersion:3,desktopVersion,menu:null,sendEnabled:false,settings:ui.settings.map(s=>({...s,enabled:false,reason:'请先处理当前问答或等待主输入框恢复'})),capabilities:{newChat:false,settings:false},error:canRespond?null:editorCount===0?'电脑主聊天输入框暂不可见，连接仍在。可先处理问答或收起右侧预览；界面恢复后会自动同步。':'电脑出现多个主聊天输入框，已暂停发送以免误操作；请保留一个主聊天，恢复后自动同步。'};
      }
      if(!state.threadId){
        this.newContext=await p.locator(COMPOSER).filter({visible:true}).first().evaluate((e,candidate)=>{
          const owner=e.getAttribute('data-pocket-context-owner');
          const id=owner&&/^new:[0-9a-f-]{36}$/.test(owner)?owner:candidate;
          e.setAttribute('data-pocket-context-owner',id);document.documentElement.setAttribute('data-pocket-context-id',id);return id;
        },'new:'+crypto.randomUUID());
      }else{
        this.newContext=null;
        await p.locator(COMPOSER).filter({visible:true}).first().evaluate(e=>{e.removeAttribute('data-pocket-context-owner');document.documentElement.removeAttribute('data-pocket-context-id')});
      }
      this.lastContext=state.threadId;
      const contextId=state.threadId||this.newContext!;
      await this.generatedFiles.observe(contextId,state.messages,fileLinks);
      const actualText=await p.locator(COMPOSER).filter({visible:true}).first().evaluate(e=>(e instanceof HTMLTextAreaElement?e.value:(e as HTMLElement).innerText).trim());
      if(this.ownedDraft&&(this.ownedDraft.contextId!==contextId||this.ownedDraft.text!==actualText))this.ownedDraft=null;
      if(this.ownedDraft)state.draftPresent=false;
      await p.evaluate(id=>document.documentElement.setAttribute("data-pocket-active-context",id),contextId);
      const ui=await p.evaluate(readControls);
      const remote=await this.remoteUi.read(p);
      await this.registerImages(p);
      if(!state.threadId&&!ui.currentProjectId)ui.currentProjectId=this.newProjectId;
      if(ui.confirmation)ui.confirmation.id=crypto.createHash('sha256').update(JSON.stringify({contextId,surfaceId:ui.confirmation.surfaceId,summary:ui.confirmation.summary})).digest('hex');
      const settingsRevision=crypto.createHash('sha256').update(JSON.stringify({contextId,projectId:ui.currentProjectId,settings:ui.settings})).digest('hex');
      const menu=this.controls.menu?.contextId===contextId&&this.controls.menu.revision===settingsRevision?this.controls.menu:null;
      state.approvals=state.approvals.map(a=>({...a,id:crypto.createHash('sha256').update(a.summary).digest('hex')}));
      const count=await p.locator(COMPOSER).filter({visible:true}).count();
      const composerId=count===1?await p.locator(COMPOSER).filter({visible:true}).getAttribute('data-conversation-id'):null;
      const activeIds=await p.locator('[data-app-action-sidebar-thread-active="true"][aria-current="page"]').evaluateAll(es=>[...new Set(es.map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))]);
      const compatible=count===1&&activeIds.length<=1&&(!composerId||composerId===state.threadId);
      if(state.threadId){const merged=mergeMessages(this.cache.get(state.threadId)||[],state.messages);this.cache.set(state.threadId,merged);state.messages=merged;}
      return{...state,connected:true,compatible,error:compatible?null:'当前界面无法唯一定位聊天和输入框，已暂停远程操作。',version:'0.4.1',desktopVersion,protocolVersion:3,contextId,screen:state.threadId?'chat':'new',...ui,...remote,composerContext:this.ownedDraft?.text||'',composerContextEditable:this.ownedDraft?.editable===true,composerRevision:crypto.createHash('sha256').update(JSON.stringify({settingsRevision,placeholder:remote.composerPlaceholder,modes:remote.surfaces.filter(x=>x.kind==='composer')})).digest('hex'),settingsRevision,menu};
    }catch(e){this.page=null;return emptySnapshot(e instanceof SafeError?e.message:'未连接桌面控制入口。请关闭 Codex 后，用配套启动器重新打开。');}
  }
  private async registerImages(p:Page){this.transfers.registerImages(await p.locator('img[data-pocket-image-id]').evaluateAll((es,known)=>es.filter(e=>!known.includes(e.getAttribute('data-pocket-image-id')!)).map(e=>({id:e.getAttribute('data-pocket-image-id')!,src:(e as HTMLImageElement).currentSrc||(e as HTMLImageElement).src})),this.transfers.knownImages()));}
  private async check(threadId:string){const s=await this.snapshot();if(!s.compatible)throw new SafeError('INCOMPATIBLE',s.error||'桌面版本不兼容。');if((s.contextId||s.threadId)!==threadId)throw new SafeError('CHAT_CHANGED','电脑已切换聊天，操作已取消。');return s;}
  async operate(op:Operation):Promise<OperationResult>{
    const sent=(message:string):OperationResult=>({id:op.id,status:'sent',message});
    const p=await this.connect();
    // A modal takes precedence over all underlying chat/settings operations.
    const guard=await this.snapshot();
    const modal=guard.surfaces?.filter(x=>x.kind==='dialog').at(-1);
    if((guard.confirmation||modal)&&op.type!=='confirm'&&op.type!=='ui-action'&&op.type!=='ui-input')throw new SafeError('DIALOG_OPEN','请先确认或取消手机上显示的桌面弹窗，未操作底层聊天。');
    if(!['confirm','ui-action','ui-input','approve','history','ui-close'].includes(op.type)&&await p.locator(COMPOSER).filter({visible:true}).count()!==1)throw new SafeError('WAITING_FOR_INPUT','电脑正在显示问答或预览，请先处理当前问答；主聊天输入框恢复后即可发送。');
    if(op.type==="ui-open"||op.type==="ui-close"||op.type==="ui-action"||op.type==="ui-input"||op.type==="context-clear"||op.type==="attach"||op.type==="attachment-remove"){
      const s=await this.check(op.threadId);
      if(op.type==="ui-open")return sent(await this.remoteUi.open(p,op.menu,s));
      if(op.type==="ui-close"){await this.remoteUi.close(p);return sent("已关闭菜单。");}
      if(op.type==="ui-input")return sent(await this.remoteUi.input(p,s,op));
      if(op.type==="context-clear"){if(!this.ownedDraft||this.ownedDraft.contextId!==op.threadId||s.draftPresent)throw new SafeError('DRAFT_CHANGED','无法确认输入上下文归属，未清空。');const input=p.locator(COMPOSER).filter({visible:true});if(!await input.evaluate(atomicClick,{contextId:op.threadId,clearDraft:this.ownedDraft.text}))throw new SafeError('DRAFT_CHANGED','电脑草稿或聊天已变化，未清空。');this.ownedDraft=null;return sent('已移除手机选择的输入上下文。');}
      if(op.type==="ui-action"){
        const action=s.surfaces?.find(x=>x.id===op.surfaceId)?.actions.find(x=>x.id===op.actionId);
        const copying=!!action&&/^复制(?:深度链接|为 Markdown|工作目录)|^Copy (?:deep link|as Markdown|working directory)/i.test(action.label);
        const clipboard=async()=>{try{return(await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-Clipboard -Raw'],{windowsHide:true,timeout:3000,maxBuffer:2*1024*1024})).stdout.trimEnd()}catch{return null}};
        const previous=copying?await clipboard():null;
        const message=await this.remoteUi.act(p,s,op);
        if(!s.draftPresent&&await p.locator(COMPOSER).filter({visible:true}).count()===1){const text=await p.locator(COMPOSER).filter({visible:true}).first().evaluate(e=>(e instanceof HTMLTextAreaElement?e.value:(e as HTMLElement).innerText).trim());if(text)this.ownedDraft={contextId:op.threadId,text,editable:/^编辑消息|^Edit message/i.test(action?.label||'')||this.ownedDraft?.editable===true};}
        if(copying){await p.waitForTimeout(150);const text=await clipboard();if(text!=null&&text!==previous&&text.length<1000000)return {...sent('已复制到手机剪贴板。'),clipboard:text};return{id:op.id,status:'unknown',message:'已点击桌面复制，但未确认剪贴板变化，请检查，勿重复操作。'};}
        return sent(message);
      }
      if(op.type==="attachment-remove"){
        if(!s.attachments?.some(a=>a.id===op.actionId))throw new SafeError("STALE_ATTACHMENT","附件已变化。");
        if(!await p.locator('[data-pocket-ui-id="'+op.actionId+'"]').evaluate(atomicClick,{contextId:op.threadId}))throw new SafeError("CHAT_CHANGED","聊天已变化。");return sent("已移除桌面附件。");
      }
      if(s.draftPresent)throw new SafeError("DRAFT","电脑有未发送草稿，请先处理。");
      const before=s.attachments?.length||0;await this.transfers.drop(p,op.threadId,op.uploads,this.ownedDraft?.text||'');
      for(let i=0;i<20;i++){await p.waitForTimeout(150);const now=await this.check(op.threadId);if((now.attachments?.length||0)>=before+op.uploads.length){this.transfers.consume(op.uploads);return sent("附件已加入电脑当前聊天，尚未发送。");}}
      throw new SafeError("NOT_CONFIRMED","桌面尚未确认附件，请检查电脑附件，勿重复添加。");
    }
    if(op.type==='create'||op.type==='options'||op.type==='setting'||op.type==='confirm'){
      const state=await this.check(op.threadId);
      if(op.type==='confirm')return sent(await this.controls.confirm(p,state,op.confirmationId,op.decision==='accept'));
      if(op.expectedRevision!==state.settingsRevision)throw new SafeError('SETTINGS_CHANGED','电脑页面或设置已变化，请重试。');
      if(state.confirmation||state.surfaces?.some(x=>x.kind==='dialog'))throw new SafeError('CONFIRMATION','请先处理桌面确认。');
      if(op.type==='options')return sent(await this.controls.options(p,op.setting,state));
      if(op.type==='setting')return sent(await this.controls.apply(p,op.setting,op.optionId,state,()=>this.check(op.threadId)));
      if(state.draftPresent||this.ownedDraft)throw new SafeError('DRAFT','电脑有未发送草稿或已选上下文，请先处理。');
      let button;
      if(op.projectId){
        const project=state.projects?.find(x=>x.id===op.projectId);if(!project)throw new SafeError('PROJECT_CHANGED','项目已不在电脑侧栏中。');
        const rows=p.locator('[data-app-action-sidebar-project-row]');let row=null;
        for(let i=0;i<await rows.count();i++)if(await rows.nth(i).getAttribute('data-app-action-sidebar-project-id')===op.projectId){row=rows.nth(i);break;}
        if(!row)throw new SafeError('NO_PROJECT','无法定位项目。');
        button=row.getByRole('button',{name:`在 ${project.title} 中开始新聊天`,exact:true});
        if(!await button.count())button=row.getByRole('button',{name:`Start new chat in ${project.title}`,exact:true});
      }else button=p.locator('button[aria-label="新聊天"],button[aria-label="新建聊天"],button[aria-label="New chat"]').filter({visible:true});
      if(await button.count()!==1)throw new SafeError('NO_NEW_CHAT','无法唯一定位新聊天按钮。');
      const fresh=await this.check(op.threadId);if(fresh.draftPresent)throw new SafeError('DRAFT','电脑有未发送草稿。');
      if(!await button.evaluate(atomicClick,{contextId:op.threadId,emptyDraft:true}))throw new SafeError('CHANGED','聊天或草稿已变化，未新建。');
      this.newContext=null;
      this.newProjectId=op.projectId;
      await p.locator(COMPOSER).filter({visible:true}).first().evaluate(e=>e.removeAttribute('data-pocket-context-owner'));
      for(let i=0;i<20;i++){await p.waitForTimeout(150);const now=await this.snapshot();if(now.compatible&&now.contextId!==state.contextId)return sent('已在电脑打开新聊天。');}
      return{id:op.id,status:'unknown',message:'已请求新聊天，请检查桌面是否打开。不会自动重试。'};
    }
    if(op.type==='select'){
      const rows=p.locator('[data-app-action-sidebar-thread-row]').filter({visible:true});let target=null;
      for(let i=0;i<await rows.count();i++){const row=rows.nth(i);if(await row.getAttribute('data-app-action-sidebar-thread-id')===op.threadId){target=row;break;}}
      const a=p.locator('a[href]').filter({visible:true});
      if(!target)for(let i=0;i<await a.count();i++){const link=a.nth(i);const href=await link.getAttribute('href');if(href?.match(/\/(?:local|threads|thread)\/([^/?#]+)/)?.[1]===op.threadId){target=link;break;}}
      if(!target)throw new SafeError('NOT_LISTED','该聊天当前不在电脑侧栏中，请先在电脑打开。');
      const s=await this.snapshot();if(!s.compatible)throw new SafeError('INCOMPATIBLE',s.error||'桌面版本不兼容。');if(s.draftPresent||this.ownedDraft)throw new SafeError('DRAFT','电脑输入框有未发送草稿或已选上下文，请先处理。');if(s.confirmation)throw new SafeError('CONFIRMATION','请先处理桌面确认。');
      if(!await target.evaluate(atomicClick,{contextId:s.contextId!,emptyDraft:true}))throw new SafeError('CHANGED','聊天或草稿已变化，未切换。');
      await p.waitForFunction(id=>{const route=location.pathname+' '+location.hash;return(document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread')||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(()=>{const ids=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];return ids.length===1?ids[0]:null})()||document.documentElement.getAttribute('data-pocket-context-id'))===id},op.threadId,{timeout:4000});
      return sent('已切换聊天。');
    }
    const before=await this.check(op.threadId);
    if(before.confirmation||before.surfaces?.some(x=>x.kind==='dialog'))throw new SafeError('CONFIRMATION','请先处理桌面确认。');
    const composer=p.locator(COMPOSER).filter({visible:true});
    if(op.type==='history'){
      await p.evaluate(()=>{const turn=document.querySelector('[data-turn-key]');if(!turn)throw Error('没有可加载的历史');let el=turn.parentElement;while(el){if(el.scrollHeight>el.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(el).overflowY)){el.scrollTop=Math.max(0,el.scrollTop-el.clientHeight*0.8);return;}el=el.parentElement;}throw Error('找不到聊天滚动容器');});
      await p.waitForTimeout(400);return sent('已向上加载历史。');
    }
    if(op.type==='stop'){
      const stop=p.getByRole('button',{name:STOP}).filter({visible:true});if(await stop.count()!==1)throw new SafeError('NO_STOP','无法唯一定位停止按钮。');await this.check(op.threadId);if(!await stop.evaluate(atomicClick,{contextId:op.threadId}))throw new SafeError('CHAT_CHANGED','聊天或停止按钮已变化，未操作。');return sent('已请求停止。');
    }
    if(op.type==='approve'){
      const approval=before.approvals.find(a=>a.id===op.approvalId);if(!approval)throw new SafeError('STALE_APPROVAL','审批已被处理或内容已变化，请刷新。');
      // Read and click in a single renderer task to avoid approving a replaced prompt.
      const ok=await p.evaluate(({threadId,summary:expectedSummary,decision})=>{
        const route=location.pathname+' '+location.hash;const id=document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread')||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(()=>{const ids=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];return ids.length===1?ids[0]:null})()||document.documentElement.getAttribute('data-pocket-context-id');if(id!==threadId)return false;
        const tidy=(s:string)=>s.replace(/\u00a0/g,' ').trim();
        for(const root of document.querySelectorAll<HTMLElement>('[data-codex-composer-request-navigation]')){const summary=tidy(root.innerText);if(summary!==expectedSummary)continue;
          const pattern=decision==='accept'?/^(?:Approve|Allow|Accept|允许|批准|同意)(?: once| this time|本次|一次)?$/i:/^(?:Deny|Decline|Reject|拒绝|不允许)$/i;
          const matches=Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter(b=>b.offsetWidth&&pattern.test(tidy(b.getAttribute('aria-label')||b.innerText))&&!b.disabled);if(matches.length!==1)return false;matches[0].click();return true;}
        return false;
      },{...op,summary:approval.summary});if(!ok)throw new SafeError('STALE_APPROVAL','审批或聊天已变化，未执行。');return sent('已处理审批。');
    }
    if(before.draftPresent)throw new SafeError('DRAFT','电脑输入框有未发送草稿，本次未发送。');
    if(op.uploads?.length)throw new SafeError("ATTACH_FIRST","请先将附件加入桌面，再发送。");
    if(op.expectedComposerRevision&&op.expectedComposerRevision!==before.composerRevision)throw new SafeError('COMPOSER_CHANGED','电脑输入模式或设置已变化，请重新核对后发送。');
    if(!op.text.trim()&&!before.attachments?.length)throw new SafeError("EMPTY","请填写消息或添加附件。");
    const prefix=this.ownedDraft?.contextId===op.threadId?this.ownedDraft.text:'';
    const desiredText=prefix?(prefix+'\n'+op.text).trim():op.text;
    const oldQueue=(before.queue||[]).map(q=>q.id);
    const oldCount=before.messages.filter(m=>m.role==='user'&&m.markdown.trim()===desiredText.trim()).length;
    const inserted=await composer.evaluate((el,{text,threadId,prefix})=>{
      const route=location.pathname+' '+location.hash;const id=document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread')||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(()=>{const ids=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];return ids.length===1?ids[0]:null})()||document.documentElement.getAttribute('data-pocket-context-id');
      if(id!==threadId||(el instanceof HTMLTextAreaElement?el.value:(el as HTMLElement).innerText).trim()!==prefix||el.closest('[inert],[aria-hidden="true"]')||Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"]')).some(d=>d.offsetWidth&&d.offsetHeight&&!d.closest('[inert],[aria-hidden="true"]')&&!d.contains(el)))return false;
      (el as HTMLElement).focus();
      if(prefix&&!(el instanceof HTMLTextAreaElement)){const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range)}
      return !text||document.execCommand('insertText',false,(prefix?'\n':'')+text);
    },{...op,prefix});
    if(!inserted)throw new SafeError('DRAFT_OR_CHANGED','输入框或聊天发生变化，本次未发送。');
    await p.waitForTimeout(100);
    const current=await this.check(op.threadId);
    if(op.expectedComposerRevision&&current.composerRevision!==op.expectedComposerRevision)throw new SafeError('COMPOSER_CHANGED','输入模式在发送前发生变化，文本保留在电脑草稿中，未发送。');
    if((await composer.evaluate(el=>el instanceof HTMLTextAreaElement?el.value:(el as HTMLElement).innerText)).trim()!==desiredText.trim())throw new SafeError('DRAFT_CHANGED','电脑输入内容发生变化，已保留草稿，未点击发送。');
    const root=composer.locator('xpath=ancestor::*[@data-codex-composer-root][1]');
    const footer=p.locator('[data-composer-footer-responsive]').filter({visible:true});
    const send=(await root.count()?root:await footer.count()===1?footer:p).getByRole('button',{name:SEND}).filter({visible:true});
    if(await send.count()!==1)throw new SafeError('NO_SEND','无法唯一定位发送按钮，文本已保留在电脑草稿中。');
    // Atomic validation immediately before the UI action. Never call backend thread/start.
    const clicked=await send.evaluate(atomicClick,{contextId:op.threadId,expectedDraft:desiredText});
    if(!clicked)throw new SafeError('CHANGED','聊天或草稿发生变化，未发送。');
    for(let i=0;i<15;i++){await p.waitForTimeout(200);const now=await this.snapshot();if(now.contextId!==op.threadId&&!op.threadId.startsWith('new:'))break;if(!now.draftPresent&&now.queue?.some(q=>!oldQueue.includes(q.id)))return sent('已进入桌面待处理队列，可在消息条点击引导。');if(!now.draftPresent&&now.messages.filter(m=>m.role==='user'&&m.markdown.trim()===desiredText.trim()).length>oldCount)return sent('已发送到桌面当前聊天。');}
    return{id:op.id,status:'unknown',message:'已点击发送，但尚未确认消息。请检查聊天，勿重复发送。'};
  }
  async image(id:string){return this.transfers.image(await this.connect(),id)}
  async download(contextId:string,id:string){return this.generatedFiles.open(contextId,id)}
  async stage(contextId:string,name:string,data:Buffer){await this.check(contextId);return this.transfers.stage(contextId,name,data)}
  async files(folder:string|null){return this.transfers.files(folder)}
  async stageFile(contextId:string,id:string){await this.check(contextId);return this.transfers.stageFile(contextId,id)}
  async close(){if(this.browser){await this.browser.close().catch(()=>{});this.browser=null;this.page=null;}}
}
