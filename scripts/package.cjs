const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),workspace=path.resolve(root,'..'),stage=path.join(workspace,'package','Codex-Pocket-Windows');
function resetStage(target){const expected=path.join(workspace,'package');if(path.dirname(target)!==expected||!/^Codex-Pocket-(Windows|Source)$/.test(path.basename(target)))throw Error('Unsafe staging path');fs.rmSync(target,{recursive:true,force:true});fs.mkdirSync(target,{recursive:true})}
resetStage(stage);
function copy(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.cpSync(from,to,{recursive:true})}
for(const name of ['dist','assets','windows'])copy(path.join(root,'companion',name),path.join(stage,name));
copy(process.execPath,path.join(stage,'runtime','node.exe'));
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const modules=cp.execFileSync(process.execPath,[npm,'ls','--omit=dev','--all','--parseable'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).slice(1);
const selected=[];
for(const dir of modules.sort((a,b)=>a.length-b.length)){if(selected.some(parent=>dir.startsWith(parent+path.sep)))continue;selected.push(dir);copy(dir,path.join(stage,path.relative(root,dir)));}
fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'codex-pocket-companion',version:'0.4.0',private:true,type:'module'}));
copy(path.join(root,'README.md'),path.join(stage,'使用说明.md'));
copy(path.join(root,'验证记录.md'),path.join(stage,'验证记录.md'));
if(fs.existsSync(path.join(root,'NODE-RUNTIME-LICENSE.txt')))copy(path.join(root,'NODE-RUNTIME-LICENSE.txt'),path.join(stage,'runtime','LICENSE.txt'));
for(const file of fs.readdirSync(path.join(stage,'windows'))){const p=path.join(stage,'windows',file);let text=fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'').replace(/\r?\n/g,'\r\n');fs.writeFileSync(p,(file.endsWith('.ps1')?'\uFEFF':'')+text);}
for(const [name,script]of [['启动 Codex Pocket.cmd','Start-Pocket.ps1'],['停止连接程序.cmd','Stop-Pocket.ps1'],['检查同一聊天连接.cmd','检查连接.ps1'],['修复电脑端连接.cmd','Repair-Pocket.ps1']])fs.writeFileSync(path.join(stage,name),'@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\\'+script+'"\r\nif errorlevel 1 pause\r\n');
console.log('Windows portable package staged: '+stage);
const source=path.join(workspace,'package','Codex-Pocket-Source');resetStage(source);
const excluded=new Set(['node_modules','build','.gradle','.kotlin','.git','.build-cache','keystore','local.properties','.state','dist','test-dist','emitted']);
function sources(dir,target){fs.mkdirSync(target,{recursive:true});for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(excluded.has(e.name)||e.name.startsWith('.test-')||e.name.endsWith('.log')||e.name.endsWith('.jks'))continue;const from=path.join(dir,e.name),to=path.join(target,e.name);if(e.isDirectory())sources(from,to);else copy(from,to);}}
sources(root,source);console.log('Clean source staged: '+source);
