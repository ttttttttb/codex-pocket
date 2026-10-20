import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import type {IncomingHttpHeaders} from 'node:http';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {GeneratedFiles,localFilePath,DOWNLOAD_MAX} from '../src/generated-files.js';
import {domSnapshot,mergeMessages} from '../src/desktop.js';
import {Companion} from '../src/server.js';
import {emptySnapshot,type Message} from '../src/types.js';

test('local link normalization refuses remote, traversal, device and alternate data stream paths',()=>{
  assert.equal(localFilePath('D:/成果/报告.docx:12'), 'D:\\成果\\报告.docx');
  assert.equal(localFilePath('D:/成果/报告.docx:12:1-20:3'), 'D:\\成果\\报告.docx');
  assert.equal(localFilePath('/D:/成果/报告.pdf#page=2'),'D:\\成果\\报告.pdf');
  assert.equal(localFilePath('file:///D:/some%20file.pdf'),'D:\\some file.pdf');
  for(const x of ['https://example.com/a.pdf','file://server/share/a.pdf','file:///D:/a.pdf?x=1','file:///D:/a/../auth.json','../file.pdf','D:/a/../auth.json','D:/a.pdf:secret','\\\\server\\share\\a.pdf','\\\\?\\D:\\a.pdf','D:/a%00.pdf'])assert.equal(localFilePath(x),null,x);
});
test('observed file capabilities retain identity, isolate chats, reject changed, private, missing and oversized files',async()=>{
  const dir=fs.mkdtempSync(path.join(process.cwd(),'.test-download-'));
  try{
    const file=path.join(dir,'报告.pdf');fs.writeFileSync(file,'PDF fixture');
    const registry=new GeneratedFiles([path.join(dir,'private')]);
    const messages:Message[]=[{id:'assistant',role:'assistant',markdown:'成果'},{id:'user',role:'user',markdown:'file'}];
    const links=[{messageId:'assistant',href:file,label:'报告'}];
    await registry.observe('one',messages,[...links,...links,{messageId:'user',href:path.join(dir,'user.txt'),label:'not output'}]);
    const ref=messages[0].files![0];assert.equal(messages[0].files!.length,1);assert.equal(messages[1].files!.length,0);assert.ok(ref.available);assert.equal(ref.size,11);assert.equal(ref.mime,'application/pdf');assert.ok(!JSON.stringify(ref).includes(dir));
    await registry.observe('one',messages,links);assert.equal(messages[0].files![0].id,ref.id);
    await assert.rejects(registry.open('two',ref.id),/过期/);await assert.rejects(registry.open('one',crypto.randomUUID()),/过期/);
    const {handle}=await registry.open('one',ref.id);try{assert.equal(await handle.readFile('utf8'),'PDF fixture')}finally{await handle.close()}
    fs.writeFileSync(file,'Modified and longer PDF');await assert.rejects(registry.open('one',ref.id),/变化/);
    fs.mkdirSync(path.join(dir,'private'));fs.writeFileSync(path.join(dir,'private','tls.json'),'private');
    const huge=path.join(dir,'huge.zip');const fd=fs.openSync(huge,'w');fs.ftruncateSync(fd,DOWNLOAD_MAX+1);fs.closeSync(fd);
    const other=new GeneratedFiles([path.join(dir,'private')]);
    await other.observe('one',messages,['private/tls.json','missing.pdf','huge.zip','.'].map(name=>({messageId:'assistant',href:path.join(dir,name),label:name})));
    assert.equal(messages[0].files!.length,4);assert.ok(messages[0].files!.every(x=>!x.available));
    for(const f of messages[0].files!)await assert.rejects(other.open('one',f.id));
    fs.unlinkSync(file);await assert.rejects(registry.open('one',ref.id),/变化/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('actual message DOM links become file cards without exposing source paths in the protocol',async()=>{
  const dir=fs.mkdtempSync(path.join(process.cwd(),'.test-file-dom-'));const file=path.join(dir,'图 表.xlsx');fs.writeFileSync(file,'xlsx');
  const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const p=await b.newPage();await p.setContent('<div data-turn-key="t"><div class="markdown"><p>成果 <a id="file">下载表格</a><span role="button" data-file-reference>表格文件标签</span><a href="https://example.com">官网</a></p></div></div>');await p.locator('#file').evaluate((a,url)=>a.setAttribute('href',url),pathToFileURL(file).href);await p.locator('[data-file-reference]').evaluate((a,local)=>a.setAttribute('data-markdown-copy-text',local+':12:1-20:3'),file);
    const {fileLinks,...s}=await p.evaluate(domSnapshot);const registry=new GeneratedFiles();await registry.observe('one',s.messages,fileLinks);
    assert.equal(fileLinks.length,3);assert.equal(s.messages[0].files!.length,1);assert.equal(s.messages[0].files![0].name,'图 表.xlsx');assert.ok(!JSON.stringify(s).includes(dir));
    const merged=mergeMessages(s.messages,[{...s.messages[0],markdown:'流式更新'}]);assert.equal(merged.length,1);assert.equal(merged[0].files!.length,1);
  }finally{await b.close();fs.rmSync(dir,{recursive:true,force:true})}
});
function request(port:number,url:string,token?:string){return new Promise<{status:number,bytes:Buffer,headers:IncomingHttpHeaders}>((resolve,reject)=>{
  const req=https.get({host:'127.0.0.1',port,path:url,rejectUnauthorized:false,headers:token?{Authorization:'Bearer '+token}:{}},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode!,bytes:Buffer.concat(chunks),headers:res.headers}));});req.on('error',reject);
})}
test('HTTPS downloads require pairing, opaque observed IDs and the correct context; revocation blocks access',async()=>{
  const dir=fs.mkdtempSync(path.join(process.cwd(),'.test-download-service-'));const file=path.join(dir,'中文 报告.pdf');const bytes=Buffer.from([0,255,17,23]);fs.writeFileSync(file,bytes);
  const registry=new GeneratedFiles();const messages:Message[]=[{id:'a',role:'assistant',markdown:'output'}];await registry.observe('one',messages,[{messageId:'a',href:file,label:'报告'}]);const id=messages[0].files![0].id;
  const service=new Companion(path.join(dir,'state'),{snapshot:async()=>emptySnapshot('fixture'),operate:async op=>({id:op.id,status:'sent',message:'unused'}),close:async()=>{},download:(context,id)=>registry.open(context,id)},{testIp:'127.0.0.1',port:44427,adminPort:44428});
  await service.start();
  try{
    const route='/api/downloads/'+id+'?contextId=one';assert.equal((await request(44427,route)).status,401);
    const token=service.identity.pair(service.identity.pairing().code,'fixture');
    const r=await request(44427,route,token);assert.equal(r.status,200);assert.deepEqual(r.bytes,bytes);assert.equal(r.headers['x-file-sha256'],crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(r.headers['content-type'],'application/pdf');assert.ok(r.headers['content-disposition']?.includes(encodeURIComponent('中文 报告.pdf')));
    for(const bad of ['/api/downloads/'+id+'?contextId=wrong','/api/downloads/'+crypto.randomUUID()+'?contextId=one',route+'&path=C:/secret'])assert.equal((await request(44427,bad,token)).status,400);
    fs.writeFileSync(file,'changed');assert.equal((await request(44427,route,token)).status,400);
    service.identity.revoke();assert.equal((await request(44427,route,token)).status,401);
  }finally{await service.stop();fs.rmSync(dir,{recursive:true,force:true})}
});
