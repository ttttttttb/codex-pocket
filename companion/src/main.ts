import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {Companion} from './server.js';
import {CodexDesktop} from './desktop.js';
const dir=process.env.POCKET_STATE_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPocket');
const app=new Companion(dir,new CodexDesktop());
app.start().then(url=>{
  fs.writeFileSync(path.join(dir,'dashboard.url'),url,{mode:0o600});
  console.log('Codex Pocket 已启动。本机设置页地址已保存至 dashboard.url。');
}).catch(()=>{console.error('启动失败：请确认配套程序没有重复运行，且本机端口 43828 可用。');process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void app.stop().then(()=>process.exit(0)));
