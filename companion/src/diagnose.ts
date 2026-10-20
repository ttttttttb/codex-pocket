import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {CodexDesktop} from './desktop.js';

const desktop=new CodexDesktop();
const dir=process.env.POCKET_STATE_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPocket');
const send=process.argv.includes('--send-test');
try{
  const before=await desktop.snapshot();
  if(!before.compatible)throw Error(before.error||'桌面未连接。');
  const report={checkedAt:new Date().toISOString(),desktopVersion:before.desktopVersion,sameThread:false,streamObserved:false,messageSent:false,threadId:before.threadId,mode:send?'live-send':'read-only'};
  if(send){
    if(before.busy)throw Error('当前聊天正在执行任务。请等待任务结束后再测试。');
    if(before.draftPresent)throw Error('电脑输入框有未发送草稿，请先处理。');
    const result=await desktop.operate({id:crypto.randomUUID(),type:'send',threadId:before.threadId!,text:'连接测试：请仅回复“手机连接正常”。'});
    if(result.status!=='sent')throw Error(result.message);
    report.messageSent=true;
    let last='';const end=Date.now()+60000;
    while(Date.now()<end){
      await new Promise(r=>setTimeout(r,350));const now=await desktop.snapshot();
      if(now.threadId!==before.threadId)throw Error('测试中聊天发生切换。');
      report.sameThread=true;
      const reply=now.messages.filter(m=>m.role==='assistant').at(-1)?.markdown||'';
      if(reply&&reply!==last&&reply!==(before.messages.filter(m=>m.role==='assistant').at(-1)?.markdown||''))report.streamObserved=true;
      last=reply;
      if(!now.busy&&report.streamObserved&&reply.includes('手机连接正常'))break;
    }
    if(!report.streamObserved)throw Error('消息已发送，但未在一分钟内观察到新的回复。请检查桌面聊天，不要重复点击。');
  }else report.sameThread=true;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'desktop-verification.json'),JSON.stringify(report,null,2));
  console.log(send?'通过：已在同一段桌面聊天发送测试消息，并观察到回复更新。':'通过：可以读取当前桌面聊天；尚未执行真实收发测试。');
}catch(e){console.error('未通过：'+(e instanceof Error?e.message:'检查失败'));process.exitCode=1;}finally{await desktop.close()}
