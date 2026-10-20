import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import {WebSocket} from 'ws';
import {Identity,certificate} from '../src/identity.js';
import {Journal} from '../src/journal.js';
import {Companion,isTailnetIp} from '../src/server.js';
import {operationSchema,emptySnapshot,type Desktop,type Operation} from '../src/types.js';

function scratch(){return fs.mkdtempSync(path.join(process.cwd(),'.test-'))}
test('one-use pairing, expiry, revocation and restart preserve authorization',t=>{
  const dir=scratch(),id=new Identity(dir),code=id.pairing().code;
  assert.throws(()=>id.pair('wrong','a'));const token=id.pair(code,'a');assert.ok(id.authenticate(token));assert.ok(!id.authenticate(token+'x'));
  assert.throws(()=>id.pair(code,'a'));assert.ok(new Identity(dir).authenticate(token));
  id.revoke();assert.ok(!id.authenticate(token));const now=Date.now();const mock=t.mock.method(Date,'now',()=>now+301000);assert.throws(()=>id.pair(id.pairing().code,'b'));mock.mock.restore();
});
test('pairing brute force is limited and network binds only to tailnet',()=>{
  const id=new Identity(scratch());for(let i=0;i<5;i++)assert.throws(()=>id.pair('bad','peer'));
  assert.throws(()=>id.pair(id.pairing().code,'peer'),/尝试次数/);
  for(const ip of ['0.0.0.0','127.0.0.1','192.168.1.1','100.128.1.1','100.64.1.999','evil'])assert.ok(!isTailnetIp(ip));
  assert.ok(isTailnetIp('100.64.0.1'));assert.ok(isTailnetIp('100.127.255.255'));
});
test('strict API refuses scripts, arbitrary fields and unknown actions',()=>{
  assert.ok(!operationSchema.safeParse({id:crypto.randomUUID(),type:'evaluate',script:'alert(1)'}).success);
  assert.ok(!operationSchema.safeParse({id:crypto.randomUUID(),type:'send',threadId:'a',text:'hello',script:'x'}).success);
});
test('journal survives crash without re-executing an uncertain send',()=>{
  const file=path.join(scratch(),'journal.json');const op:Operation={id:crypto.randomUUID(),type:'send',threadId:'a',text:'private text'};
  const first=new Journal(file);assert.equal(first.begin(op),undefined);
  const afterCrash=new Journal(file);assert.equal(afterCrash.begin(op)?.status,'unknown');
  assert.ok(!fs.readFileSync(file,'utf8').includes(op.text));
  afterCrash.complete(op,{id:op.id,status:'sent',message:'ok'});assert.equal(new Journal(file).begin(op)?.status,'sent');
  assert.equal(afterCrash.begin({...op,text:'different'})?.status,'rejected');
});

function request(port:number,route:string,method='GET',body?:unknown,token?:string){return new Promise<{status:number,body:any}>((resolve,reject)=>{
  const r=https.request({hostname:'127.0.0.1',port,path:route,method,rejectUnauthorized:false,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(text)}))});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);
})}
test('HTTPS/WS auth, duplicate delivery and revoke across the real network service',async()=>{
  let calls=0;let fileCalls=0;const desktop:Desktop={snapshot:async()=>({...emptySnapshot('fixture'),connected:true,compatible:true,threadId:'a'}),operate:async op=>{calls++;return{id:op.id,status:'sent',message:'ok'}},close:async()=>{},image:async()=>{fileCalls++;return Buffer.from('{"ok":true}')},stage:async()=>{fileCalls++;return{id:crypto.randomUUID(),name:'test',size:1}},files:async()=>{fileCalls++;return{entries:[]}},stageFile:async()=>{fileCalls++;return{ok:true}}};
  const bridge=new Companion(scratch(),desktop,{testIp:'127.0.0.1',port:44327,adminPort:44328});
  await bridge.start();
  try{
    assert.equal((await request(44327,'/api/snapshot')).status,401);
    const fileRoutes=[['/api/images/'+crypto.randomUUID(),'GET',undefined],['/api/uploads?contextId=a&name=test','POST',{data:1}],['/api/files','GET',undefined],['/api/files/select','POST',{contextId:'a',id:crypto.randomUUID()}]] as const;
    for(const[route,method,body]of fileRoutes)assert.equal((await request(44327,route,method,body)).status,401);assert.equal(fileCalls,0);
    const paired=await request(44327,'/api/pair','POST',{code:bridge.identity.pairing().code});assert.equal(paired.status,200);const token=paired.body.token;
    assert.equal((await request(44327,'/api/snapshot','GET',undefined,token)).status,200);
    for(const[route,method,body]of fileRoutes)assert.equal((await request(44327,route,method,body,token)).status,200);assert.equal(fileCalls,4);
    const ws=new WebSocket('wss://127.0.0.1:44327/api/events',{rejectUnauthorized:false,headers:{Authorization:'Bearer '+token}});
    await new Promise<void>((r,j)=>{ws.once('open',()=>r());ws.once('error',j)});
    const op={id:crypto.randomUUID(),type:'send',threadId:'a',text:'hello'};
    const results:any[]=[];ws.on('message',data=>{const m=JSON.parse(data.toString());if(m.type==='result')results.push(m.result)});
    ws.send(JSON.stringify(op));ws.send(JSON.stringify(op));
    const until=Date.now()+4000;while(results.length<2&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
    assert.equal(results.length,2);assert.equal(calls,1);
    ws.send(JSON.stringify({type:'evaluate',script:'evil'}));await new Promise(r=>setTimeout(r,50));assert.equal(calls,1);
    assert.equal((await request(44327,'/api/operations/'+op.id,'GET',undefined,token)).body.status,'sent');
    const closeEvent=new Promise<number>(resolve=>ws.once('close',resolve));
    const revoke=await fetch('http://127.0.0.1:44328/revoke',{method:'POST',headers:{'X-Admin-Key':bridge.adminKey}});assert.equal(revoke.status,200);
    assert.equal(await closeEvent,4001);for(const[route,method,body]of fileRoutes)assert.equal((await request(44327,route,method,body,token)).status,401);assert.equal(fileCalls,4);assert.equal((await request(44327,'/api/snapshot','GET',undefined,token)).status,401);
  }finally{await bridge.stop()}
});
test('generated certificate fingerprint is stable and unrelated certificates differ',async()=>{
  const dir=scratch();const a=await certificate(dir,'127.0.0.1');const b=await certificate(dir,'127.0.0.1');assert.equal(a.fingerprint,b.fingerprint);const c=await certificate(scratch(),'127.0.0.1');assert.notEqual(a.fingerprint,c.fingerprint);
});
