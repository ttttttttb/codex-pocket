import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import QRCode from 'qrcode';
import {WebSocketServer,WebSocket} from 'ws';
import {Identity,certificate} from './identity.js';
import {Journal} from './journal.js';
import {operationSchema,emptySnapshot,SafeError,type Desktop,type Snapshot,type OperationResult} from './types.js';

export const isTailnetIp=(ip:string)=>{const p=ip.split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&p[0]===100&&p[1]>=64&&p[1]<=127;};
export async function tailscaleIp(){
  const candidates=['C:\\Program Files\\Tailscale\\tailscale.exe','tailscale'];
  for(const exe of candidates)try{const{stdout}=await promisify(execFile)(exe,['status','--json'],{timeout:4000,windowsHide:true});const status=JSON.parse(stdout);if(status.BackendState!=='Running')continue;const ip=status.Self?.TailscaleIPs?.find(isTailnetIp);if(ip)return ip as string;}catch{}
  return null;
}
async function jsonBody(req:http.IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const c of req){size+=c.length;if(size>200000)throw new SafeError('TOO_LARGE','请求过大。');chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw new SafeError('BAD_JSON','请求格式错误。')}}
const json=(res:http.ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))};
const bearer=(req:http.IncomingMessage)=>{const auth=req.headers.authorization;return auth?.startsWith('Bearer ')?auth.slice(7):undefined};

export class Companion {
  readonly identity:Identity;readonly journal:Journal;readonly adminKey=crypto.randomBytes(32).toString('base64url');
  private tls:https.Server|null=null;private admin:http.Server|null=null;private wss=new WebSocketServer({noServer:true,maxPayload:200000});
  private latest=emptySnapshot('正在连接桌面……');private seq=0;private revision='';private polling=false;private timer:NodeJS.Timeout|null=null;
  private networkTimer:NodeJS.Timeout|null=null;private queue:Promise<unknown>=Promise.resolve();private tlsInfo:{ip:string,fingerprint:string,url:string}|null=null;
  private refreshingNetwork=false;
  private adminSockets=new Set<import('node:net').Socket>();
  constructor(private dir:string,private desktop:Desktop,private options:{adminPort?:number,port?:number,testIp?:string}={}){fs.mkdirSync(dir,{recursive:true});this.identity=new Identity(dir);this.journal=new Journal(path.join(dir,'operations.json'));}
  async start(){
    this.admin=http.createServer(async(req,res)=>{
      try{
        if(req.headers.host!==`127.0.0.1:${this.options.adminPort||43828}`)return json(res,403,{error:'HOST_DENIED'});
        const url=new URL(req.url||'/','http://127.0.0.1');
        if(url.pathname==='/'&&req.method==='GET'){const page=fs.readFileSync(new URL('../assets/admin.html',import.meta.url),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});return res.end(page)}
        if(req.headers['x-admin-key']!==this.adminKey)return json(res,401,{error:'UNAUTHORIZED'});
        if(req.method==='GET'&&url.pathname==='/status')return json(res,200,await this.adminStatus());
        if(req.method==='POST'&&url.pathname==='/pairing'){this.identity.rotatePairing();return json(res,200,await this.adminStatus());}
        if(req.method==='POST'&&url.pathname==='/revoke'){this.identity.revoke();for(const ws of this.wss.clients)ws.close(4001,'Authorization revoked');return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/retry'){await this.refreshNetwork();return json(res,200,{ok:true});}
        if(req.method==='GET'&&url.pathname==='/compatibility')return json(res,200,{connected:this.latest.connected,compatible:this.latest.compatible,error:this.latest.error,desktopVersion:this.latest.desktopVersion,threadId:this.latest.threadId,messageCount:this.latest.messages.length,checkedAt:new Date().toISOString()});
        return json(res,404,{error:'NOT_FOUND'});
      }catch{json(res,500,{error:'LOCAL_ERROR',message:'本机设置操作失败，请重试。'});}
    });
    this.admin.on('connection',s=>{this.adminSockets.add(s);s.on('close',()=>this.adminSockets.delete(s))});
    await new Promise<void>((resolve,reject)=>{this.admin!.once('error',reject);this.admin!.listen(this.options.adminPort||43828,'127.0.0.1',resolve)});
    await this.refreshNetwork();await this.poll();
    this.timer=setInterval(()=>void this.poll(),350);this.networkTimer=setInterval(()=>void this.refreshNetwork().catch(()=>{}),15000);
    this.wss.on('connection',ws=>{ws.send(JSON.stringify({type:'snapshot',seq:this.seq,snapshot:this.latest}));ws.on('message',raw=>{void this.handleMessage(ws,raw.toString())});ws.on('error',()=>{});});
    return `http://127.0.0.1:${this.options.adminPort||43828}/#${this.adminKey}`;
  }
  private async refreshNetwork(){
    if(this.refreshingNetwork)return;this.refreshingNetwork=true;
    try{
    const ip=this.options.testIp||await tailscaleIp();
    if(ip===this.tlsInfo?.ip)return;
    if(this.tls){for(const ws of this.wss.clients)ws.close(4002,'Network changed');this.tls.closeAllConnections();await new Promise<void>(r=>this.tls!.close(()=>r()));this.tls=null;this.tlsInfo=null;}
    if(!ip)return;
    if(!this.options.testIp&&!isTailnetIp(ip))throw Error('Not a Tailscale address');
    const cert=await certificate(this.dir,ip);const port=this.options.port||43827;
    this.tls=https.createServer({key:cert.key,cert:cert.cert,minVersion:'TLSv1.2'},async(req,res)=>{
      try{
        if(req.headers.origin)return json(res,403,{error:'ORIGIN_DENIED'});
        const u=new URL(req.url||'/','https://localhost');
        if(req.method==='POST'&&u.pathname==='/api/pair'){
          const body=await jsonBody(req);if(typeof body.code!=='string')return json(res,400,{error:'BAD_PAIR'});
          const token=this.identity.pair(body.code,req.socket.remoteAddress||'unknown');return json(res,200,{token,name:os.hostname(),version:'0.3.1'});
        }
        if(!this.identity.authenticate(bearer(req)))return json(res,401,{error:'UNAUTHORIZED'});
        if(req.method==='GET'&&/^\/api\/images\/[0-9a-f-]{36}$/.test(u.pathname)&&this.desktop.image){const bytes=await this.desktop.image(u.pathname.split('/').at(-1)!);res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(bytes)}
        if(req.method==='POST'&&u.pathname==='/api/uploads'&&this.desktop.stage){
          const context=u.searchParams.get('contextId')||'',name=u.searchParams.get('name')||'文件';
          if(!context||context.length>300||name.length>200)throw new SafeError('BAD_UPLOAD','附件参数无效。');
          let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw new SafeError('FILE_SIZE','单个附件不能超过 20 MB。');chunks.push(chunk)}
          if(!this.identity.authenticate(bearer(req)))return json(res,401,{error:'UNAUTHORIZED'});
          return json(res,200,await this.desktop.stage(context,name,Buffer.concat(chunks)));
        }
        if(req.method==='GET'&&u.pathname==='/api/files'&&this.desktop.files){const id=u.searchParams.get('folder');if(id&&!/^[0-9a-f-]{36}$/.test(id))throw new SafeError('BAD_FOLDER','目录标识无效。');return json(res,200,await this.desktop.files(id))}
        if(req.method==='POST'&&u.pathname==='/api/files/select'&&this.desktop.stageFile){const j=await jsonBody(req);if(typeof j.contextId!=='string'||j.contextId.length>300||typeof j.id!=='string'||!/^[0-9a-f-]{36}$/.test(j.id))throw new SafeError('BAD_FILE','文件标识无效。');return json(res,200,await this.desktop.stageFile(j.contextId,j.id))}
        if(req.method==='GET'&&u.pathname==='/api/snapshot')return json(res,200,this.latest);
        if(req.method==='GET'&&/^\/api\/operations\/[0-9a-f-]{36}$/.test(u.pathname))return json(res,200,this.journal.get(u.pathname.split('/').at(-1)!)||{status:'unknown',message:'电脑尚未确认此操作。'});
        return json(res,404,{error:'NOT_FOUND'});
      }catch(e){const safe=e instanceof SafeError;json(res,safe?400:500,{error:safe?e.code:'REQUEST_FAILED',message:safe?e.message:'请求失败，请重试。'});}
    });
    this.tls.requestTimeout=10000;this.tls.headersTimeout=10000;
    this.tls.on('upgrade',(req,socket,head)=>{
      if(req.url!=='/api/events'||req.headers.origin||!this.identity.authenticate(bearer(req))){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.wss.emit('connection',ws,req));
    });
    await new Promise<void>((resolve,reject)=>{this.tls!.once('error',reject);this.tls!.listen(port,ip,resolve)});
    this.tlsInfo={ip,url:`https://${ip}:${port}`,fingerprint:cert.fingerprint};
    }finally{this.refreshingNetwork=false;}
  }
  async adminStatus(){
    const p=this.identity.pairing();const qr=this.tlsInfo&&!this.identity.paired()?JSON.stringify({v:1,name:os.hostname(),url:this.tlsInfo.url,fp:this.tlsInfo.fingerprint,code:p.code}):null;
    return{network:this.tlsInfo,paired:this.identity.paired(),expiresAt:p.expiresAt,qr:qr?await QRCode.toDataURL(qr,{width:360,margin:2,errorCorrectionLevel:'M'}):null,pairingText:qr,desktop:{connected:this.latest.connected,compatible:this.latest.compatible,error:this.latest.error,title:this.latest.title,version:this.latest.desktopVersion},version:'0.3.1'};
  }
  private async poll(){if(this.polling)return;this.polling=true;try{const snapshot=await this.desktop.snapshot();const rev=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');this.latest=snapshot;if(rev!==this.revision){this.revision=rev;this.seq++;this.broadcast({type:'snapshot',seq:this.seq,snapshot});}}catch{this.latest=emptySnapshot('桌面连接暂时中断。');this.broadcast({type:'snapshot',seq:++this.seq,snapshot:this.latest});}finally{this.polling=false}}
  private broadcast(v:unknown){const data=JSON.stringify(v);for(const ws of this.wss.clients)if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>4000000){ws.close(4003,'Slow client');continue;}ws.send(data)}}
  private async handleMessage(ws:WebSocket,raw:string){
    let input:unknown;try{input=JSON.parse(raw)}catch{ws.send(JSON.stringify({type:'error',message:'消息格式错误。'}));return}
    if((input as any)?.type==='ping'){ws.send(JSON.stringify({type:'pong',seq:this.seq}));return;}
    if((input as any)?.type==='resync'){ws.send(JSON.stringify({type:'snapshot',seq:this.seq,snapshot:this.latest}));return;}
    const parsed=operationSchema.safeParse(input);if(!parsed.success){ws.send(JSON.stringify({type:'error',message:'不支持的操作。'}));return;}
    const op=parsed.data;
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      // Revocation/connection loss before dispatch must cancel queued actions.
      if(ws.readyState!==WebSocket.OPEN)return;
      const prev=this.journal.begin(op);if(prev){ws.send(JSON.stringify({type:'result',result:prev}));return;}
      let result:OperationResult;
      try{result=await this.desktop.operate(op)}catch(e){result={id:op.id,status:e instanceof SafeError&&e.code!=='NOT_CONFIRMED'?'rejected':'unknown',message:e instanceof SafeError?e.message:'操作结果待确认，请检查电脑聊天，勿重复发送。'};}
      this.journal.complete(op,result);if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',result}));await this.poll();
    });
  }
  async stop(){if(this.timer)clearInterval(this.timer);if(this.networkTimer)clearInterval(this.networkTimer);for(const ws of this.wss.clients)ws.terminate();this.wss.close();for(const s of this.adminSockets)s.destroy();await Promise.all([this.admin&&new Promise<void>(r=>this.admin!.close(()=>r())),this.tls&&new Promise<void>(r=>{this.tls!.closeAllConnections();this.tls!.close(()=>r())})]);await this.desktop.close();}
}
