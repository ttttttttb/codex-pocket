import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import type {FileHandle} from 'node:fs/promises';
import {SafeError,type Message} from './types.js';

export const DOWNLOAD_MAX=100*1024*1024;
export type GeneratedFile={id:string,name:string,size?:number,mime:string,available:boolean,reason?:string};
export type ObservedFileLink={messageId:string,href:string,label:string};
type Entry={context:string,requested:string,real:string,stamp:string,ref:GeneratedFile,seen:number,checked:number};
const mimeTypes:Record<string,string>={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',html:'text/html',htm:'text/html',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',zip:'application/zip',mp4:'video/mp4',mp3:'audio/mpeg',wav:'audio/wav',apk:'application/vnd.android.package-archive'};
export const fileMime=(name:string)=>mimeTypes[path.extname(name).slice(1).toLowerCase()]||'application/octet-stream';

// Only absolute local links observed in assistant messages become download capabilities.
// Phone requests carry an opaque ID, never a path or URL.
export function localFilePath(href:string):string|null{
  try{
    let value=href.trim();
    if(decodeURIComponent(value).split(/[\\/]/).some(x=>x==='..'))return null;
    if(/^file:/i.test(value)){
      const u=new URL(value);if(u.hostname||u.search)return null;u.hash='';value=fileURLToPath(u);
    }else{
      value=decodeURIComponent(value.replace(/#.*$/,''));
      if(/^\/[a-z]:[\\/]/i.test(value))value=value.slice(1);
    }
    value=value.replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/,'');
    if(!/^[a-z]:[\\/]/i.test(value)||/[\x00-\x1f?*<>|]/.test(value)||value.slice(2).includes(':'))return null;
    if(value.split(/[\\/]/).some(x=>x==='..'))return null;
    return path.win32.normalize(value);
  }catch{return null}
}
const stamp=(s:fs.Stats)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
export class GeneratedFiles{
  private entries=new Map<string,Entry>();
  private keys=new Map<string,string>();
  constructor(private protectedRoots:string[]=[process.env.POCKET_STATE_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPocket')]){}
  private protected(file:string){const candidate=path.resolve(file).toLowerCase();return this.protectedRoots.some(root=>{let r=path.resolve(root);try{r=fs.realpathSync(r)}catch{}r=r.toLowerCase();return candidate===r||candidate.startsWith(r+path.sep)})}
  async observe(context:string,messages:Message[],links:ObservedFileLink[]){
    for(const m of messages)m.files=[];
    for(const link of links.slice(0,300)){
      const message=messages.find(m=>m.id===link.messageId&&m.role==='assistant');if(!message)continue;
      const requested=localFilePath(link.href);if(!requested)continue;
      const key=context+'\0'+requested.toLowerCase();let entry=this.entries.get(this.keys.get(key)||'');
      if(!entry||Date.now()-entry.checked>1000){
        let real='',signature='',size:number|undefined,reason:string|undefined;
        try{
          real=await fs.promises.realpath(requested);if(this.protected(real))throw new Error('protected');
          const s=await fs.promises.stat(real);size=s.size;signature=stamp(s);
          if(!s.isFile())reason='这是文件夹，请在电脑上打包或选择其中的文件。';
          else if(s.size>DOWNLOAD_MAX)reason='超过单文件 100 MB 上限。';
        }catch{reason='文件不存在、不可读取或不允许下载。'}
        const ref:GeneratedFile={id:entry?.stamp===signature&&entry?.real===real?entry.ref.id:crypto.randomUUID(),name:path.win32.basename(requested),size,mime:fileMime(requested),available:!reason,...(reason?{reason}:{})};
        if(entry&&entry.ref.id!==ref.id)this.entries.delete(entry.ref.id);
        entry={context,requested,real,stamp:signature,ref,seen:Date.now(),checked:Date.now()};this.keys.set(key,ref.id);this.entries.set(ref.id,entry);
      }
      entry.seen=Date.now();if(!message.files!.some(f=>f.id===entry!.ref.id))message.files!.push(entry.ref);
    }
    for(const[id,e]of this.entries)if(Date.now()-e.seen>60*60*1000||this.entries.size>2000){this.entries.delete(id);this.keys.delete(e.context+'\0'+e.requested.toLowerCase())}
  }
  async open(context:string,id:string):Promise<{handle:FileHandle,file:GeneratedFile}>{
    const e=this.entries.get(id);
    if(!e||e.context!==context||Date.now()-e.seen>60*60*1000)throw new SafeError('STALE_DOWNLOAD','文件卡片已过期，请重新加载这段聊天。');
    if(!e.ref.available)throw new SafeError('FILE_UNAVAILABLE',e.ref.reason||'文件不可下载。');
    let handle:FileHandle|undefined;
    try{
      const real=await fs.promises.realpath(e.requested);
      if(real!==e.real||this.protected(real))throw Error('changed');
      handle=await fs.promises.open(real,'r');const s=await handle.stat();
      if(!s.isFile()||s.size>DOWNLOAD_MAX||stamp(s)!==e.stamp)throw Error('changed');
      return{handle,file:e.ref};
    }catch{await handle?.close();throw new SafeError('FILE_CHANGED','文件已变化、被移动或无法读取，请刷新聊天后重试。')}
  }
}
