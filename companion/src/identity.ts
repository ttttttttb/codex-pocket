import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import {SafeError} from './types.js';

const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
export class Identity {
  private code=crypto.randomBytes(20).toString('base64url');
  private expires=Date.now()+300000;
  private tokenHash:string|null=null;
  private attempts=new Map<string,{n:number,start:number}>();
  constructor(private dir:string){fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'device.json');if(fs.existsSync(p))this.tokenHash=JSON.parse(fs.readFileSync(p,'utf8')).tokenHash;}
  pairing(){return{code:this.code,expiresAt:this.expires}}
  rotatePairing(){this.code=crypto.randomBytes(20).toString('base64url');this.expires=Date.now()+300000;return this.pairing()}
  pair(code:string,peer:string){
    let a=this.attempts.get(peer);if(!a||Date.now()-a.start>60000){a={n:0,start:Date.now()};this.attempts.set(peer,a)}
    if(++a.n>5)throw new SafeError('RATE_LIMIT','尝试次数过多，请一分钟后重试。');
    const globalKey='__all__';let total=this.attempts.get(globalKey);if(!total||Date.now()-total.start>60000){total={n:0,start:Date.now()};this.attempts.set(globalKey,total)}
    if(++total.n>30)throw new SafeError('RATE_LIMIT','配对请求过多，请稍后重试。');
    if(this.tokenHash)throw new SafeError('ALREADY_PAIRED','已有手机连接，请在电脑端先撤销旧授权。');
    if(Date.now()>this.expires||!this.code||!this.equal(hash(code),hash(this.code)))throw new SafeError('PAIR_FAILED','配对码错误或已过期，请重新扫码。');
    const token=crypto.randomBytes(32).toString('base64url');this.tokenHash=hash(token);this.code='';this.persist();return token;
  }
  authenticate(token:string|undefined){return !!token&&!!this.tokenHash&&this.equal(hash(token),this.tokenHash)}
  paired(){return this.tokenHash!==null}
  revoke(){this.tokenHash=null;this.persist();this.rotatePairing()}
  private equal(a:string,b:string){return a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b))}
  private persist(){const p=path.join(this.dir,'device.json');fs.writeFileSync(p+'.tmp',JSON.stringify({tokenHash:this.tokenHash}),{mode:0o600});fs.renameSync(p+'.tmp',p)}
}
export async function certificate(dir:string,ip:string){
  const file=path.join(dir,'tls.json');
  if(fs.existsSync(file)){const p=JSON.parse(fs.readFileSync(file,'utf8'));const cert=new crypto.X509Certificate(p.cert);if(p.ip===ip&&Date.parse(cert.validTo)>Date.now()+86400000)return{...p,fingerprint:cert.fingerprint256.replaceAll(':','').toLowerCase()};}
  const p=await selfsigned.generate([{name:'commonName',value:'Codex Pocket'}],{days:365,keySize:2048,algorithm:'sha256',extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:7,ip},{type:7,ip:'127.0.0.1'}]}]});
  const result={ip,key:p.private,cert:p.cert};fs.writeFileSync(file,JSON.stringify(result),{mode:0o600});return{...result,fingerprint:new crypto.X509Certificate(p.cert).fingerprint256.replaceAll(':','').toLowerCase()};
}
