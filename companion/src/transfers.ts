import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type {Page} from 'playwright-core';
import {SafeError} from './types.js';

const MAX=20*1024*1024;
type Upload={id:string,contextId:string,name:string,data:Buffer,at:number};
export class Transfers{
 private uploads=new Map<string,Upload>();private entries=new Map<string,{path:string,at:number}>();
 private imageCache=new Map<string,Buffer>();private imageSources=new Map<string,string>();
 knownImages(){return [...this.imageSources.keys()]}
 registerImages(sources:{id:string,src:string}[]){for(const s of sources)this.imageSources.set(s.id,s.src);while(this.imageSources.size>1000||[...this.imageSources.values()].reduce((n,v)=>n+v.length*2,0)>64*1024*1024)this.imageSources.delete(this.imageSources.keys().next().value!)}
 async stage(contextId:string,name:string,data:Buffer){
   if(!data.length||data.length>MAX)throw new SafeError('FILE_SIZE','每个文件须为 1 字节至 20 MB。');
   const safeName=path.basename(name.replaceAll('\\','/')).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,160);if(!safeName||/^\.+$/.test(safeName))throw new SafeError('FILE_NAME','文件名无效。');
   for(const [id,v]of this.uploads)if(Date.now()-v.at>30*60*1000)this.uploads.delete(id);
   if([...this.uploads.values()].reduce((n,x)=>n+x.data.length,0)+data.length>64*1024*1024)throw new SafeError('UPLOAD_LIMIT','待发送附件已达到 64 MB，请先发送或稍后重试。');
   const id=crypto.randomUUID();this.uploads.set(id,{id,contextId,name:safeName,data,at:Date.now()});return {id,name:safeName,size:data.length};
 }
 get(contextId:string,ids:string[]){return ids.map(id=>{const x=this.uploads.get(id);if(!x||x.contextId!==contextId||Date.now()-x.at>30*60*1000)throw new SafeError('STALE_UPLOAD','附件已过期或不属于当前聊天，请重新选择。');return x})}
 consume(ids:string[]){for(const id of ids)this.uploads.delete(id)}
 async files(id:string|null){
   if(!id){const roots=[];for(const letter of ['C','D','E','F']){const dir=letter+':\\';if(fs.existsSync(dir))roots.push(this.entry(dir,letter+':',true))}return {name:'电脑磁盘',entries:roots};}
   const entry=this.entries.get(id);if(!entry||Date.now()-entry.at>15*60*1000)throw new SafeError('STALE_FOLDER','目录已过期，请返回磁盘列表。');
   const real=await fs.promises.realpath(entry.path);const st=await fs.promises.stat(real);if(!st.isDirectory())throw new SafeError('NOT_FOLDER','这不是文件夹。');
   const items=await fs.promises.readdir(real,{withFileTypes:true});const entries=[];
   if(path.dirname(real)!==real)entries.push(this.entry(path.dirname(real),'上一级',true));
   for(const item of items.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name))){if(item.isSymbolicLink()||item.name.startsWith('.'))continue;if(entries.length>=500)break;entries.push(this.entry(path.join(real,item.name),item.name,item.isDirectory()))}
   return {name:path.basename(real)||real,entries,note:'文件夹用于浏览；选择文件加入附件。最多显示 500 项，每个文件上限 20 MB。'};
 }
 private entry(file:string,name:string,directory:boolean){const id=crypto.randomUUID();this.entries.set(id,{path:file,at:Date.now()});while(this.entries.size>5000)this.entries.delete(this.entries.keys().next().value!);return{id,name,directory}}
 async stageFile(contextId:string,id:string){const e=this.entries.get(id);if(!e||Date.now()-e.at>15*60*1000)throw new SafeError('STALE_FILE','文件选择已过期。');const st=await fs.promises.stat(e.path);if(!st.isFile()||st.size>MAX)throw new SafeError('FILE_SIZE','只能添加不超过 20 MB 的文件，请展开文件夹选择文件。');return this.stage(contextId,path.basename(e.path),await fs.promises.readFile(e.path))}
 async image(p:Page,id:string){
   const cached=this.imageCache.get(id);if(cached)return cached;
   const src=this.imageSources.get(id);if(!src)throw new SafeError('NO_IMAGE','图片尚未加载，请加载相应历史后重试。');
   let bytes:Buffer;
   if(src.startsWith('data:image/')){const m=src.match(/^data:image\/[^;,]+;base64,(.*)$/s);if(!m)throw new SafeError('IMAGE_FORMAT','不支持的图片格式。');bytes=Buffer.from(m[1],'base64')}
   else{
     const image=p.locator(`img[data-pocket-image-id="${id}"]`).first();if(!await image.count())throw new SafeError('NO_IMAGE','图片已移出桌面历史，请加载历史后重试。');
     // Re-encode loaded pixels. Never fetch a phone-provided URL or read an arbitrary path.
     const data=await image.evaluate((e)=>{const img=e as HTMLImageElement;if(!img.complete||!img.naturalWidth)return null;try{const c=document.createElement('canvas');const scale=Math.min(1,4096/Math.max(img.naturalWidth,img.naturalHeight));c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));c.getContext('2d')!.drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1]}catch{return null}});
     bytes=data?Buffer.from(data,'base64'):await image.screenshot({type:'png',timeout:3000});
   }
   if(bytes.length>MAX)throw new SafeError('IMAGE_SIZE','图片超过 20 MB，暂时无法预览。');
   while([...this.imageCache.values()].reduce((n,b)=>n+b.length,0)+bytes.length>64*1024*1024&&this.imageCache.size)this.imageCache.delete(this.imageCache.keys().next().value!);
   this.imageCache.set(id,bytes);return bytes;
 }
 async drop(p:Page,contextId:string,ids:string[],expectedDraft=''){
   const files=this.get(contextId,ids);
   const base=path.join(process.env.POCKET_STATE_DIR||path.join(os.tmpdir(),'CodexPocket'),'attachments');
   await fs.promises.mkdir(base,{recursive:true});
   const paths=[];for(const f of files){const dir=path.join(base,f.id);await fs.promises.mkdir(dir,{recursive:true});const target=path.join(dir,f.name);await fs.promises.writeFile(target,f.data,{mode:0o600});paths.push(target)}
   const inputId=crypto.randomUUID();
   await p.evaluate(id=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.hidden=true;input.setAttribute('data-pocket-file-input',id);document.body.append(input)},inputId);
   const input=p.locator('input[data-pocket-file-input="'+inputId+'"]');
   const cdp=await p.context().newCDPSession(p);
   try{const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[data-pocket-file-input="'+inputId+'"]'});await cdp.send('DOM.setFileInputFiles',{nodeId,files:paths})}finally{await cdp.detach()}
   try{
   const ok=await p.evaluate(({contextId,inputId,expectedDraft})=>{
     const route=location.pathname+' '+location.hash;const active=[...new Set(Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-active="true"][aria-current="page"]')).map(e=>e.getAttribute('data-app-action-sidebar-thread-id')).filter(Boolean))];
     const actual=document.querySelector('[data-current-thread]')?.getAttribute('data-current-thread')||route.match(/\/(?:local|threads|thread)\/([^/?#\s]+)/)?.[1]||document.querySelector('textarea[data-conversation-id]')?.getAttribute('data-conversation-id')||(active.length===1?active[0]:null)||document.documentElement.getAttribute('data-pocket-context-id');
     if(active.length>1||actual!==contextId)return false;
     const editor=Array.from(document.querySelectorAll<HTMLElement>('[data-codex-composer][contenteditable="true"],textarea[data-conversation-id]')).filter(e=>e.offsetWidth&&!e.closest('[data-codex-composer-request-navigation],[data-app-shell-tab-panel-controller="right"],[inert],[aria-hidden="true"]'));if(editor.length!==1||(editor[0] instanceof HTMLTextAreaElement?editor[0].value:editor[0].innerText).trim()!==expectedDraft)return false;
     if(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"]')).some(d=>d.offsetWidth&&d.offsetHeight&&!d.closest('[inert],[aria-hidden="true"]')&&!d.contains(editor[0])))return false;
     const source=document.querySelector<HTMLInputElement>('input[data-pocket-file-input="'+inputId+'"]');
     if(!source?.files?.length)return false;
     const dt=new DataTransfer();for(const f of Array.from(source.files))dt.items.add(f);
     const target=editor[0].closest('[data-composer-surface-variant]')||editor[0].closest('[data-codex-composer-root]')||editor[0];
     target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));
     target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
     target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));return true;
   },{contextId,inputId,expectedDraft});
   if(!ok)throw new SafeError('DRAFT_OR_CHANGED','电脑草稿或聊天已变化，未添加附件。');
   }finally{await input.evaluate(e=>e.remove()).catch(()=>{})}
 }
 clear(){this.uploads.clear();this.entries.clear();this.imageCache.clear();this.imageSources.clear()}
}
