import {z} from 'zod';
import type {UiSurface,Queued,UiAction,ImageRef} from './remote-ui.js';
import type {GeneratedFile} from './generated-files.js';

export const operationSchema = z.discriminatedUnion('type', [
  z.object({id:z.string().uuid(),type:z.literal('send'),threadId:z.string().min(1).max(300),text:z.string().max(50000),expectedComposerRevision:z.string().length(64).optional(),uploads:z.array(z.string().uuid()).max(10).optional()}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('ui-open'),threadId:z.string().min(1).max(300),menu:z.enum(['plus','chat'])}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('ui-close'),threadId:z.string().min(1).max(300)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('ui-input'),threadId:z.string().min(1).max(300),surfaceId:z.string().uuid(),revision:z.string().length(64),fields:z.record(z.string().uuid(),z.string().max(50000))}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('context-clear'),threadId:z.string().min(1).max(300)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('ui-action'),threadId:z.string().min(1).max(300),surfaceId:z.string().uuid(),revision:z.string().length(64),actionId:z.string().uuid(),fields:z.record(z.string().uuid(),z.string().max(50000)).optional()}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('attach'),threadId:z.string().min(1).max(300),uploads:z.array(z.string().uuid()).min(1).max(10)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('attachment-remove'),threadId:z.string().min(1).max(300),actionId:z.string().uuid()}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('select'),threadId:z.string().min(1).max(300)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('history'),threadId:z.string().min(1).max(300)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('stop'),threadId:z.string().min(1).max(300)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('catalog'),threadId:z.string().min(1).max(300)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('create'),threadId:z.string().min(1).max(300),projectId:z.string().max(300).nullable(),folderId:z.string().uuid().optional(),expectedRevision:z.string().max(100)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('options'),threadId:z.string().min(1).max(300),setting:z.enum(['permission','plan','model','effort']),expectedRevision:z.string().max(100)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('setting'),threadId:z.string().min(1).max(300),setting:z.enum(['permission','plan','model','effort']),optionId:z.string().max(100),expectedRevision:z.string().max(100)}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('confirm'),threadId:z.string().min(1).max(300),confirmationId:z.string().max(100),decision:z.enum(['accept','decline'])}).strict(),
  z.object({id:z.string().uuid(),type:z.literal('approve'),threadId:z.string().min(1).max(300),approvalId:z.string().min(1).max(200),decision:z.enum(['accept','decline'])}).strict(),
]);
export type Operation=z.infer<typeof operationSchema>;
export type OperationResult={id:string,status:'sent'|'rejected'|'unknown',message:string,clipboard?:string};
export type Message={id:string,role:'user'|'assistant'|'activity',markdown:string,turnId?:string,unitId?:string,slot?:number,images?:ImageRef[],files?:GeneratedFile[],attachedFiles?:{id:string,name:string}[]};
export type SettingKey='permission'|'plan'|'model'|'effort';
export type SettingOption={id:string,label:string,selected:boolean,disabled:boolean};
export type ComposerSetting={key:SettingKey,label:string,value:string,enabled:boolean,reason?:string};
export type Project={id:string,title:string};
export type SettingMenu={key:SettingKey,contextId:string,revision:string,options:SettingOption[],error?:string};
export type Confirmation={id:string,surfaceId?:string,summary:string,acceptLabel:string,declineLabel:string};
export type Chat={id:string,title:string,active:boolean,projectId?:string|null};
export type Approval={id:string,summary:string,acceptLabel:string,declineLabel:string};
export type Snapshot={connected:boolean,compatible:boolean,error:string|null,threadId:string|null,title:string,messages:Message[],chats:Chat[],draftPresent:boolean,busy:boolean,approvals:Approval[],canLoadOlder:boolean,version:string,desktopVersion?:string,protocolVersion?:number,contextId?:string,screen?:'chat'|'new',currentProjectId?:string|null,projects?:Project[],settings?:ComposerSetting[],settingsRevision?:string,menu?:SettingMenu|null,confirmation?:Confirmation|null,capabilities?:{newChat:boolean,settings:boolean,folders?:boolean,catalog?:boolean},surfaces?:UiSurface[],queue?:Queued[],attachments?:UiAction[],sendLabel?:string,sendEnabled?:boolean,composerContext?:string,composerContextEditable?:boolean,composerPlaceholder?:string,composerRevision?:string};
export interface Desktop {snapshot():Promise<Snapshot>;operate(operation:Operation):Promise<OperationResult>;close():Promise<void>;image?(id:string):Promise<Buffer>;download?(contextId:string,id:string):Promise<{handle:import("node:fs/promises").FileHandle,file:import("./generated-files.js").GeneratedFile}>;stage?(contextId:string,name:string,data:Buffer):Promise<{id:string,name:string,size:number}>;files?(folder:string|null,directoriesOnly?:boolean):Promise<unknown>;stageFile?(contextId:string,id:string):Promise<unknown>}
export const emptySnapshot=(error:string):Snapshot=>({connected:false,compatible:false,error,threadId:null,title:'尚未连接 Codex',messages:[],chats:[],draftPresent:false,busy:false,approvals:[],canLoadOlder:false,version:'0.4.3',protocolVersion:3});
export class SafeError extends Error {constructor(public code:string,message:string){super(message)}}
