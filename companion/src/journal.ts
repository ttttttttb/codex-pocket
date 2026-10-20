import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Operation,OperationResult} from './types.js';

type Entry={hash:string,result:OperationResult,at:number};
export class Journal {
  private entries:Record<string,Entry>={};
  constructor(private file:string){
    if(fs.existsSync(file))this.entries=JSON.parse(fs.readFileSync(file,'utf8'));
  }
  hash(op:Operation){return crypto.createHash('sha256').update(JSON.stringify(op)).digest('hex')}
  get(id:string){return this.entries[id]?.result}
  begin(op:Operation):OperationResult|undefined{
    const prev=this.entries[op.id];
    if(prev){if(prev.hash!==this.hash(op))return{id:op.id,status:'rejected',message:'此操作编号已被使用，请核对聊天状态。'};return prev.result;}
    // Persist before touching the UI. A crash must never replay an uncertain action.
    this.entries[op.id]={hash:this.hash(op),result:{id:op.id,status:'unknown',message:'操作结果待确认，请检查聊天，勿重复发送。'},at:Date.now()};
    this.save();return undefined;
  }
  complete(op:Operation,result:OperationResult){const {clipboard,...receipt}=result;this.entries[op.id]={hash:this.hash(op),result:receipt,at:Date.now()};this.save();return result}
  private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.entries),{mode:0o600});fs.renameSync(temp,this.file)}
}
