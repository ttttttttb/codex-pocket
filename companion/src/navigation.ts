import type {Page} from 'playwright-core';
import path from 'node:path';
import crypto from 'node:crypto';
import {SafeError} from './types.js';
import {atomicClick,atomicField} from './ui-action.js';

const MORE=/^(?:Show more|Load more|更多|显示更多|展开更多|加载更多)(?:\s*\(\d+\))?$/i;
export function readCatalog(){
 const shown=(e:Element)=>!!(e as HTMLElement).offsetWidth&&!!(e as HTMLElement).offsetHeight&&!e.closest('[inert],[aria-hidden="true"]');
 const buttons=[...document.querySelectorAll('[data-app-action-sidebar-section] button')].filter(shown);
 return {more:buttons.some(b=>/^(?:Show more|Load more|更多|显示更多|展开更多|加载更多)(?:\s*\(\d+\))?$/i.test((b.getAttribute('aria-label')||b.textContent||'').trim())),collapsed:!!document.querySelector('[data-app-action-sidebar-project-collapsed="true"],[data-app-action-sidebar-section-collapsed="true"]')};
}

// Expand actual sidebar UI on demand. Never change chats, submit drafts or use
// the desktop's private conversation API to manufacture a separate chat list.
export async function loadCatalog(p:Page,contextId:string){
 const deadline=Date.now()+8000;let count=0;
 for(;count<40&&Date.now()<deadline;count++){
  let target=p.locator('[data-app-action-sidebar-section-collapsed="true"] [data-app-action-sidebar-section-toggle][aria-expanded="false"]').filter({visible:true}).first();
  if(!await target.count())target=p.locator('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-collapsed="true"]').filter({visible:true}).first();
  if(!await target.count())target=p.locator('[data-app-action-sidebar-section]').getByRole('button',{name:MORE}).filter({visible:true}).first();
  if(!await target.count())break;
  if(!await target.evaluate(atomicClick,{contextId}))throw new SafeError('CATALOG_CHANGED','电脑聊天或弹窗已变化，已停止加载列表。');
  await p.waitForTimeout(130);
 }
 const state=await p.evaluate(readCatalog);
 return state.more||state.collapsed?'已同步更多项目和聊天；仍有未展开内容，可点“加载更多项目和聊天”继续。':'已同步桌面项目与已加载聊天。';
}

// A directory chosen through the authenticated browser is dropped onto the
// desktop's source-folder control, exactly as a desktop folder drag. The phone
// supplies only an expiring opaque directory ID, never CDP data or a raw path.
export async function addFolderProject(p:Page,contextId:string,folder:string,existingNames:string[],check:()=>Promise<void>):Promise<string>{
 const add=p.getByRole('button',{name:/^(?:Add new project|添加新项目|新建项目|添加项目)$/i}).filter({visible:true});
 if(await add.count()!==1)throw new SafeError('NO_FOLDER_CONTROL','桌面未提供唯一的添加项目入口。');
 await check();if(!await add.evaluate(atomicClick,{contextId,emptyDraft:true}))throw new SafeError('CHAT_CHANGED','聊天或草稿已变化，未打开目录设置。');
 const modal=p.getByRole('dialog').filter({has:p.getByRole('textbox',{name:/^(?:Project name|项目名称)$/i})}).filter({visible:true});
 try{await modal.waitFor({state:'visible',timeout:1500})}catch{throw new SafeError('NO_FOLDER_FORM','无法确认桌面项目设置，请处理桌面提示。')}
 const marker=crypto.randomUUID();await modal.evaluate((e,id)=>e.setAttribute('data-pocket-folder-form',id),marker);
 const original=p.locator('[data-pocket-folder-form="'+marker+'"]');let submitted=false;let ownedTitle='';
 try{
  await check();
  const field=original.getByRole('textbox',{name:/^(?:Project name|项目名称)$/i});
  const nameBase=path.basename(folder)||folder.replace(/[:\\/]/g,'')+' 工作目录';let title=nameBase;
  for(let n=2;existingNames.includes(title);n++)title=nameBase+' ('+n+')';
  const old=await field.inputValue();if(old)throw new SafeError('PROJECT_DRAFT','项目名称中已有内容，未覆盖。');
  if(!await field.evaluate(atomicField,{contextId,oldValue:'',value:title}))throw new SafeError('PROJECT_CHANGED','项目表单已变化。');
  ownedTitle=title;
  const source=original.getByRole('button',{name:/^(?:Add|添加|Choose source folders|选择源文件夹)$/i});
  if(await source.count()!==1)throw new SafeError('NO_SOURCE_CONTROL','桌面源文件夹控件不兼容。');
  await check();if(!await source.evaluate(atomicClick,{contextId,checkOnly:true}))throw new SafeError('PROJECT_CHANGED','项目或聊天已变化。');
  const cdp=await p.context().newCDPSession(p);
  try{for(const type of ['dragEnter','dragOver','drop'] as const){
   await check();
   if(await original.count()!==1||await field.inputValue()!==title||!await source.evaluate(atomicClick,{contextId,checkOnly:true}))throw new SafeError('PROJECT_CHANGED','目录表单或顶层弹窗已变化，已停止操作。');
   const box=await source.boundingBox();if(!box)throw new SafeError('NO_SOURCE_CONTROL','源文件夹控件不可见。');
   await cdp.send('Input.dispatchDragEvent',{type,x:box.x+box.width/2,y:box.y+box.height/2,data:{items:[],files:[folder],dragOperationsMask:1}});
  }}finally{await cdp.detach()}
  const expectedName=path.basename(folder)||folder;
  const remove=original.getByRole('button',{name:new RegExp('^(?:Remove|移除) '+expectedName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i')});
  try{await remove.waitFor({state:'visible',timeout:2000})}catch{throw new SafeError('FOLDER_NOT_CONFIRMED','桌面未确认所选文件夹，未创建聊天。')}
  const submit=original.getByRole('button',{name:/^(?:Create project|创建项目)$/i,exact:true});
  await check();if(await field.inputValue()!==title||await original.getByRole('button',{name:/^(?:Remove|移除) /i}).count()!==1||!await submit.evaluate(atomicClick,{contextId}))throw new SafeError('PROJECT_CHANGED','创建按钮、源目录或聊天已变化，未提交。');
  submitted=true;
  for(let n=0;n<25;n++){
   await p.waitForTimeout(120);
   const dialogs=p.getByRole('dialog').filter({visible:true});
   if(await dialogs.count()&&await dialogs.last().getAttribute('data-pocket-folder-form')!==marker)throw new SafeError('FOLDER_CONFIRMATION','所选目录需要桌面确认，请先在手机处理弹窗。确认后从项目列表选择新项目，再点新建聊天；不会自动信任文件夹或重复创建。');
   const rows=await p.locator('[data-app-action-sidebar-project-row]').evaluateAll((es,title)=>es.filter(e=>e.getAttribute('data-app-action-sidebar-project-label')===title).map(e=>e.getAttribute('data-app-action-sidebar-project-id')).filter(Boolean),title);
   if(rows.length===1&&!await original.count())return rows[0]!;
  }
  throw new SafeError('PROJECT_PENDING','已提交目录项目，结果尚未确认。请检查桌面，不会自动重复创建。');
 }finally{
  if(!submitted&&await original.count()&&await original.getByRole('textbox',{name:/^(?:Project name|项目名称)$/i}).inputValue()===ownedTitle){
   const cancel=original.getByRole('button',{name:/^(?:Cancel|取消)$/i,exact:true});
   if(await cancel.count()===1)await cancel.evaluate(atomicClick,{contextId});
  }
 }
}
