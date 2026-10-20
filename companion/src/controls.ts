import crypto from 'node:crypto';
import type {Page,Locator} from 'playwright-core';
import {SafeError,type ComposerSetting,type SettingKey,type SettingMenu,type Snapshot,type Confirmation} from './types.js';
import {atomicClick,dismissFloatingMenus} from './ui-action.js';

export function readControls(){
  const visible=(e:Element)=>!!(e as HTMLElement).offsetWidth&&!e.closest('[inert],[aria-hidden="true"]');
  const root=Array.from(document.querySelectorAll('[data-codex-composer-root],[data-composer-footer-responsive]')).find(e=>!e.closest('[data-app-shell-tab-panel-controller="right"]'))||document;
  const buttons=Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter(e=>!!e.offsetWidth);
  const permission=root.querySelector<HTMLButtonElement>('[data-composer-navigation-target="permissions"]');
  const intelligence=root.querySelector<HTMLButtonElement>('[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]');
  const plan=buttons.find(b=>/^(?:计划|Plan|退出计划模式|Exit plan mode|Plan mode)$/i.test(b.getAttribute('aria-label')||b.innerText.trim()));
  const add=root.querySelector<HTMLButtonElement>('[data-composer-navigation-target="add-context"]');
  const value=(e:HTMLElement|null)=>e?.querySelector('[data-tooltip-overflow-target]')?.textContent?.trim()||e?.innerText.trim()||'';
  const effort=intelligence?.getAttribute('data-selected-reasoning-effort')||'';
  const picker=document.querySelector('[data-model-picker-view-toggle]');
  const effortLabel=Array.from(intelligence?.querySelectorAll<HTMLElement>('[data-reasoning-effort]')||[]).find(e=>e.getAttribute('data-reasoning-effort')===effort)?.textContent?.trim()||picker?.querySelector('[class*="ViewToggleEffortLabel"]')?.textContent?.trim()||effort;
  const model=intelligence?.querySelector('[class*="TriggerModelText"],[data-current-model]')?.textContent?.trim()||picker?.querySelector('[class*="ViewToggleModelLabel"]')?.textContent?.trim()||intelligence?.innerText.split('\n')[0]?.trim()||'';
  const enabled=(e:HTMLButtonElement|null|undefined)=>!!e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';
  const settings:ComposerSetting[]=[
    {key:'permission',label:'权限',value:value(permission),enabled:enabled(permission)},
    {key:'plan',label:'模式',value:plan?'计划':'默认',enabled:enabled(plan||add)},
    {key:'model',label:'模型',value:model,enabled:enabled(intelligence)},
    {key:'effort',label:'思考强度',value:effortLabel,enabled:enabled(intelligence)},
  ].map(s=>({...s,reason:s.enabled?undefined:'桌面未提供此控件或当前不可用'})) as ComposerSetting[];
  const projects=Array.from(document.querySelectorAll('[data-app-action-sidebar-project-row]')).map(e=>({id:e.getAttribute('data-app-action-sidebar-project-id')||'',title:e.getAttribute('data-app-action-sidebar-project-label')||''})).filter(p=>p.id&&p.title);
  const current=document.querySelector('[data-app-action-sidebar-thread-active="true"][aria-current="page"]');
  let currentProjectId:string|null=null;
  let ancestor=current?.parentElement;
  while(ancestor&&!ancestor.matches('[data-app-action-sidebar-section]')){const rows=ancestor.querySelectorAll('[data-app-action-sidebar-project-row]');if(rows.length===1){currentProjectId=rows[0].getAttribute('data-app-action-sidebar-project-id');break;}ancestor=ancestor.parentElement;}
  const newChat=Array.from(document.querySelectorAll('button')).some(b=>visible(b)&&/^(?:新聊天|新建聊天|New chat)$/i.test(b.getAttribute('aria-label')||b.innerText.trim()));
  const dialogs=Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"],[role="dialog"]')).filter(visible);
  const top=dialogs.at(-1);
  const dialog=top&&/完[全整]访问|full access|不受限制|unrestricted/i.test(top.innerText)&&top.querySelector('button')?top:null;
  let confirmation:Confirmation|null=null;
  if(dialog){const bs=Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).filter(visible);const a=bs.find(b=>/^(?:允许|确认|启用|继续|Allow|Confirm|Enable|Continue)(?:完[全整]访问(?:权限)?| full access)?$/i.test(b.innerText.trim()));const d=bs.find(b=>/^(?:取消|拒绝|Cancel|Deny)$/i.test(b.innerText.trim()));if(a&&d&&!a.disabled&&!d.disabled&&!dialog.querySelector('input,textarea,select,[contenteditable="true"],[role="checkbox"],[role="radio"]')){let surfaceId=dialog.getAttribute('data-pocket-ui-id');if(!surfaceId){surfaceId=crypto.randomUUID?.()||'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));dialog.setAttribute('data-pocket-ui-id',surfaceId)}confirmation={id:'',surfaceId,summary:dialog.innerText.trim(),acceptLabel:a.innerText.trim(),declineLabel:d.innerText.trim()};}}
  return{projects,currentProjectId,settings,confirmation,capabilities:{newChat,settings:settings.some(s=>s.enabled)}};
}

type Target={label:string,kind:'item'|'slider'|'plan',value?:number};
const digest=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
export class DesktopControls{
  menu:SettingMenu|null=null;
  private targets=new Map<string,Target>();
  private expiry=0;
  private trigger(key:SettingKey,p:Page){return p.locator(key==='permission'?'[data-composer-navigation-target="permissions"]:not([data-app-shell-tab-panel-controller="right"] *)':'[data-codex-intelligence-trigger]:not([data-app-shell-tab-panel-controller="right"] *),[data-composer-navigation-target="reasoning"]:not([data-app-shell-tab-panel-controller="right"] *)').filter({visible:true});}
  private async closeMenu(_p:Page){this.menu=null;this.targets.clear();}
  private async open(p:Page,key:SettingKey){
    if(key==='plan')return;
    if(await p.locator('[role="dialog"],[role="alertdialog"],[role="menu"]').filter({visible:true}).count())throw new SafeError('DESKTOP_MENU','电脑有已打开的菜单或对话框，请先处理。');
    const trigger=this.trigger(key,p);if(await trigger.count()!==1||!await trigger.isEnabled())throw new SafeError('NO_CONTROL','桌面没有提供这个控件。');
    if(!await trigger.evaluate(atomicClick,{contextId:await p.locator('html').getAttribute('data-pocket-active-context')||'',checkOnly:true}))throw new SafeError('DIALOG_OPEN','页面或弹窗已变化，未打开设置。');
    await trigger.press('Enter',{timeout:1200});
    if(key==='model'){
      const toggle=p.locator('[data-model-picker-view-toggle]').filter({visible:true});
      if(await toggle.count()===1)await toggle.evaluate(e=>(e as HTMLElement).click());
    }
    await p.waitForTimeout(160);
  }
  async options(p:Page,key:SettingKey,state:Snapshot){
    if(this.menu)await this.closeMenu(p);
    await this.open(p,key);
    const options:SettingMenu['options']=[];this.targets.clear();
    const add=(target:Target,selected=false,disabled=false)=>{const id=digest(JSON.stringify({key,target,context:state.contextId,revision:state.settingsRevision}));this.targets.set(id,target);options.push({id,label:target.label,selected,disabled})};
    try{
      if(key==='plan'){
        const current=state.settings?.find(s=>s.key==='plan')?.value==='计划';
        add({kind:'plan',label:'默认',value:0},!current);add({kind:'plan',label:'计划',value:1},current);
      }else if(key==='effort'){
        const slider=p.locator('[data-reasoning-slider] [role="slider"],[data-model-picker-power-slider] [role="slider"]').first();
        if(await slider.count()){
          const min=Number(await slider.getAttribute('aria-valuemin')),max=Number(await slider.getAttribute('aria-valuemax')),now=Number(await slider.getAttribute('aria-valuenow'));
          if(!Number.isInteger(min)||!Number.isInteger(max)||max-min>20)throw new SafeError('NO_OPTIONS','无法识别桌面强度范围。');
          for(let n=min;n<=max;n++)add({kind:'slider',label:`第 ${n-min+1} 档 / 共 ${max-min+1} 档${n===now?' · '+state.settings?.find(s=>s.key==='effort')?.value:''}`,value:n},n===now,await slider.getAttribute('aria-disabled')==='true');
        }
      }
      if(!options.length){
        const items=await p.locator('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]').evaluateAll(es=>es.filter(e=>(e as HTMLElement).offsetWidth&&!e.closest('[inert],[aria-hidden="true"]')&&e.closest('[role="menu"]')).map(e=>({label:(e as HTMLElement).innerText.trim(),selected:e.getAttribute('aria-checked')==='true'||e.getAttribute('data-model-selected')==='true',disabled:e.getAttribute('aria-disabled')==='true'})));
        for(const item of items){if(!item.label||/重置为默认|选择模型|Reset to default/i.test(item.label))continue;const current=state.settings?.find(s=>s.key===key)?.value;add({kind:'item',label:item.label},item.selected||key==='permission'&&!!current&&item.label.startsWith(current),item.disabled)}
      }
      if(!options.length)throw new SafeError('NO_OPTIONS','无法识别桌面选项，已暂停此项操作。');
      this.menu={key,contextId:state.contextId!,revision:state.settingsRevision!,options};this.expiry=Date.now()+60000;
      return '已读取桌面选项。';
    }finally{if(key!=='plan')await this.dismiss(p);}
  }
  async apply(p:Page,key:SettingKey,optionId:string,state:Snapshot,check:()=>Promise<Snapshot>){
    const menu=this.menu,target=this.targets.get(optionId);
    if(!menu||!target||menu.key!==key||menu.contextId!==state.contextId||menu.revision!==state.settingsRevision||Date.now()>this.expiry)throw new SafeError('STALE_OPTIONS','桌面状态或选项已变化，请重新打开选项。');
    const option=menu.options.find(o=>o.id===optionId)!;if(option.disabled)throw new SafeError('DISABLED','桌面当前禁用此选项。');
    if(option.selected)return '已经是当前设置。';
    await this.open(p,key);
    try{
      const fresh=await check();if(fresh.settingsRevision!==state.settingsRevision)throw new SafeError('SETTINGS_CHANGED','电脑设置已变化，未执行。');
      if(target.kind==='plan'){
        if(target.value===0){const b=p.locator('[data-codex-composer-root],[data-composer-footer-responsive]').getByRole('button',{name:/^(?:计划|Plan|退出计划模式|Exit plan mode|Plan mode)$/i}).filter({visible:true});if(await b.count()!==1)throw new SafeError('NO_PLAN','无法唯一定位计划模式按钮。');if(!await b.evaluate(atomicClick,{contextId:state.contextId!}))throw new SafeError('CHAT_CHANGED','聊天已变化，未执行。');}
        else{
          const b=p.locator('[data-composer-navigation-target="add-context"]').filter({visible:true});if(await b.count()!==1)throw new SafeError('NO_PLAN','无法定位模式菜单。');await b.press('Enter');await p.waitForTimeout(180);
          const item=p.getByRole('menuitem',{name:/^(?:计划模式|计划|Plan mode|Plan)$/i}).or(p.getByRole('option',{name:/^(?:计划模式|计划|Plan mode|Plan)$/i})).or(p.locator('button[data-list-navigation-item]').filter({hasText:/^(?:计划模式|Plan mode)/i})).filter({visible:true});
          if(await item.count()!==1)throw new SafeError('NO_PLAN','当前桌面未显示计划模式入口，请先在电脑操作。');if(!await item.evaluate(atomicClick,{contextId:state.contextId!}))throw new SafeError('CHAT_CHANGED','聊天已变化，未执行。');
        }
      }else if(target.kind==='slider'){
        const slider=p.locator('[data-reasoning-slider],[data-model-picker-power-slider] [role="slider"]').filter({visible:true}).first();
        await slider.focus();
        const now=Number(await p.locator('[data-model-picker-power-slider] [role="slider"],[data-reasoning-slider] [role="slider"]').first().getAttribute('aria-valuenow'));
        for(let n=0;n<Math.abs(target.value!-now);n++){
          const fresh=await check();if(fresh.confirmation||fresh.surfaces?.some(x=>x.kind==='dialog'))return '桌面要求确认，请先处理手机上的弹窗。';
          if(!await slider.evaluate(atomicClick,{contextId:state.contextId!,checkOnly:true}))throw new SafeError('DIALOG_OPEN','控件或弹窗已变化，已暂停强度调整。');
          await slider.press(target.value!>now?'ArrowRight':'ArrowLeft',{timeout:1200});
        }
        const after=await check();if(after.confirmation||after.surfaces?.some(x=>x.kind==='dialog'))return '桌面要求确认，请先处理手机上的弹窗。';
        const actual=Number(await p.locator('[data-model-picker-power-slider] [role="slider"],[data-reasoning-slider] [role="slider"]').first().getAttribute('aria-valuenow'));
        if(actual!==target.value)throw new SafeError('NOT_CONFIRMED','桌面未确认强度修改，请检查当前设置。');
      }else{
        const items=p.locator('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]').filter({visible:true});
        let match:Locator|null=null;let matches=0;
        for(let i=0;i<await items.count();i++){const e=items.nth(i);if((await e.innerText()).trim()===target.label&&!await e.evaluate(e=>!!e.closest('[inert],[aria-hidden="true"]'))){match=e;matches++;}}
        if(matches!==1||!match)throw new SafeError('OPTIONS_CHANGED','无法唯一定位选项，请重新读取。');if(!await match.evaluate(atomicClick,{contextId:state.contextId!}))throw new SafeError('CHAT_CHANGED','聊天已变化，未执行。');
      }
    }finally{await this.dismiss(p);this.menu=null;this.targets.clear();}
    for(let n=0;n<12;n++){await p.waitForTimeout(120);const fresh=await check();if(fresh.confirmation||fresh.surfaces?.some(x=>x.kind==='dialog'))return '桌面要求确认，请查看并确认或取消。';if(fresh.settingsRevision!==state.settingsRevision)return '桌面已确认设置更新。';}
    throw new SafeError('NOT_CONFIRMED','桌面尚未确认修改，请检查当前设置。');
  }
  async confirm(p:Page,state:Snapshot,id:string,accept:boolean){
    const c=state.confirmation;if(!c||c.id!==id)throw new SafeError('STALE_CONFIRMATION','确认请求已变化。');
    const dialogs=p.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true});
    for(let i=0;i<await dialogs.count();i++){const d=dialogs.nth(i);if(c.surfaceId&&await d.getAttribute('data-pocket-ui-id')!==c.surfaceId||(await d.innerText()).trim()!==c.summary)continue;const b=d.getByRole('button',{name:accept?c.acceptLabel:c.declineLabel,exact:true});if(await b.count()===1&&await b.evaluate(atomicClick,{contextId:state.contextId!,surfaceId:c.surfaceId,confirmationSummary:c.summary,actionLabel:accept?c.acceptLabel:c.declineLabel})){
      const original=c.surfaceId?p.locator('[data-pocket-ui-id="'+c.surfaceId+'"]'):d;
      for(let n=0;n<10;n++){if(!await original.count()||!await original.isVisible())return accept?'已确认桌面请求。':'已取消桌面请求。';await p.waitForTimeout(80)}
      throw new SafeError('NOT_CONFIRMED','已点击桌面按钮，但弹窗结果尚未确认；请检查当前提示，勿重复操作。');
    }}
    throw new SafeError('STALE_CONFIRMATION','找不到原确认请求，未操作。');
  }
  private async dismiss(p:Page){
    if(await p.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true}).count())return;
    if(!await dismissFloatingMenus(p))throw new SafeError('MENU_CLOSE','电脑菜单未能关闭，请重试。');
  }
}
