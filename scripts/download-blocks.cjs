const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../toolchain');
async function blocks(url,name){
 const target=path.join(root,name),block=1024*1024;
 async function part(start,end){for(let attempt=0;attempt<4;attempt++){try{
  const r=await fetch(url+(url.includes('?')?'&':'?')+'pocket-block='+start,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(45000)});
  const range=r.headers.get('content-range');if(r.status!==206||!range?.startsWith(`bytes ${start}-`))throw Error('Invalid range: '+r.status);
  const b=Buffer.from(await r.arrayBuffer());if(b.length!==end-start+1&&start!==0)throw Error('Incomplete block');return{b,total:Number(range.split('/')[1])};
 }catch(e){if(attempt===3)throw e}}}
 const first=await part(0,block-1);const fd=fs.openSync(target,'w');fs.ftruncateSync(fd,first.total);fs.writeSync(fd,first.b,0,first.b.length,0);let next=block,finished=first.b.length;
 try{await Promise.all(Array.from({length:6},async()=>{while(next<first.total){const start=next;next+=block;const end=Math.min(start+block,first.total)-1;const {b,total}=await part(start,end);if(total!==first.total)throw Error('Changed remote archive');fs.writeSync(fd,b,0,b.length,start);finished+=b.length;if(finished%(20*block)<block)console.log(name+': '+Math.round(finished/first.total*100)+'%')}}));}finally{fs.closeSync(fd)}
 console.log('Complete '+name+' ('+first.total+' bytes)');
}
module.exports={blocks};
if(require.main===module)Promise.all([
 blocks('https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip','sdk.zip'),
 blocks('https://downloads.gradle.org/distributions/gradle-8.13-bin.zip','gradle.zip')
]).catch(e=>{console.error(e.message);process.exitCode=1});
