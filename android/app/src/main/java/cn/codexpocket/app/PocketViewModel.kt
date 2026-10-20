package cn.codexpocket.app

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.UUID
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

data class UiState(val session: Session?=null,val socketConnected: Boolean=false,val connecting: Boolean=false,val pairing: Boolean=false,val snapshot: Snapshot=Snapshot(),val notice: String?=null,val pendingId: String?=null,val pendingUnknown: Boolean=false,val draft: String="",val clearDraftOnSuccess: Boolean=false,val theme:String="system",
    val uploading:Boolean=false,val staged:List<StagedFile> = emptyList(),val files:FileListing?=null,val filesLoading:Boolean=false,val hiddenMenuId:String?=null){
    val remoteMenu:RemoteSurface? get()=snapshot.surfaces.lastOrNull{it.kind=="menu"}?.takeIf{hiddenMenuId==null}
    fun hideMenu()=copy(hiddenMenuId=snapshot.surfaces.lastOrNull{it.kind=="menu"}?.id?:hiddenMenuId)
}

class PocketViewModel(app: Application): AndroidViewModel(app) {
    private val store=SecureStore(app)
    private val mutable=MutableStateFlow(UiState(session=store.session(),pendingId=store.pending(),pendingUnknown=store.pending()!=null,clearDraftOnSuccess=store.pendingContext()!=null,theme=store.theme()))
    val state=mutable.asStateFlow()
    private val drafts=store.drafts()
    private var pendingDraftContext=store.pendingContext()
    private var socket: WebSocket?=null
    private var client: OkHttpClient?=null
    private var reconnect: Job?=null
    private var timeout: Job?=null
    private var attempt=0
    private var generation=0
    private var lastSeq = -1L
    private val staged=mutableMapOf<String,List<StagedFile>>()
    private val images=java.util.LinkedHashMap<String,ByteArray>()
    private val dismissals=mutableSetOf<String>()
    private var pendingKind:String?=null
    private var pendingAttachContext:String?=null
    private var pendingAttachIds:List<String> = emptyList()
    init { if(mutable.value.session!=null)connect() }

    private fun pinnedClient(fp: String): OkHttpClient {
        val trust=object:X509TrustManager {
            override fun getAcceptedIssuers()=emptyArray<X509Certificate>()
            override fun checkClientTrusted(chain:Array<out X509Certificate>?,authType:String?) { throw CertificateException("Client certificates are not accepted") }
            override fun checkServerTrusted(chain:Array<out X509Certificate>?,authType:String?) {
                try { require(!chain.isNullOrEmpty());CertificatePin.verify(chain[0],fp) }catch(e:Exception){throw CertificateException("电脑证书不匹配或已过期。",e)}
            }
        }
        val ssl=SSLContext.getInstance("TLS").apply{init(null,arrayOf<TrustManager>(trust),SecureRandom())}
        return OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory,trust).followRedirects(false).followSslRedirects(false).connectTimeout(6,TimeUnit.SECONDS).readTimeout(15,TimeUnit.SECONDS).pingInterval(15,TimeUnit.SECONDS).build()
    }
    fun pair(raw:String) {
        if(mutable.value.pairing)return
        val pairing=try{Pairing.parse(raw)}catch(e:Exception){mutable.update{it.copy(notice=e.message?:"二维码无效。")};return}
        mutable.update{it.copy(pairing=true,notice=null)}
        viewModelScope.launch {
            try {
                val session=withContext(Dispatchers.IO) {
                    val c=pinnedClient(pairing.fp)
                    try {
                        val req=Request.Builder().url(pairing.url+"/api/pair").post(JSONObject().put("code",pairing.code).toString().toRequestBody("application/json".toMediaType())).build()
                        c.newCall(req).execute().use{r->val j=JSONObject(r.body?.string()?:"{}");if(!r.isSuccessful)throw IOException(j.optString("message","配对失败，请在电脑刷新二维码。"));Session(pairing.name,pairing.url,pairing.fp,j.getString("token"))}
                    }finally { c.connectionPool.evictAll();c.dispatcher.executorService.shutdown() }
                }
                store.saveSession(session);mutable.update{it.copy(session=session,pairing=false,notice="配对成功，正在同步聊天。")};connect()
            }catch(e:Exception){mutable.update{it.copy(pairing=false,notice=if(e is IOException&&e.message?.contains("配对")==true)e.message else "连接失败：请确认手机已开启 Tailscale、电脑在线，且二维码未过期。")}}
        }
    }
    fun connect() {
        val s=mutable.value.session?:return
        generation++;val epoch=generation
        reconnect?.cancel();socket?.cancel();client?.connectionPool?.evictAll()
        client=pinnedClient(s.fp);lastSeq = -1
        mutable.update{it.copy(connecting=true,socketConnected=false)}
        val req=Request.Builder().url(s.url.replaceFirst("https://","wss://")+"/api/events").header("Authorization","Bearer "+s.token).build()
        socket=client!!.newWebSocket(req,object:WebSocketListener(){
            override fun onOpen(webSocket:WebSocket,response:Response) { if(epoch!=generation){webSocket.cancel();return};attempt=0;mutable.update{it.copy(socketConnected=true,connecting=false,notice=null)};checkPending(s,epoch) }
            override fun onMessage(webSocket:WebSocket,text:String) {
                if(epoch!=generation)return
                viewModelScope.launch {
                if(epoch!=generation)return@launch
                try{val j=JSONObject(text);when(j.optString("type")){
                    "snapshot"->{val seq=j.optLong("seq");if(seq>=lastSeq){lastSeq=seq;val snapshot=Snapshot.parse(j.getJSONObject("snapshot"));mutable.update{
                        val oldKey=it.snapshot.contextId;val newKey=snapshot.contextId
                        if(oldKey!=null)drafts.put(oldKey,it.draft)
                        it.copy(snapshot=snapshot,draft=if(newKey==oldKey)it.draft else drafts.optString(newKey?:""),staged=staged[newKey]?:emptyList(),hiddenMenuId=if(newKey!=oldKey||snapshot.surfaces.none{x->x.kind=="menu"})null else it.hiddenMenuId)
                    }}}
                    "result"->{val result=j.getJSONObject("result");if(dismissals.remove(result.optString("id"))){if(result.optString("status")!="sent")notice(result.optString("message","电脑菜单暂未关闭，可重试。"))}else applyResult(result)}
                    "error"->mutable.update{it.copy(notice=j.optString("message","操作失败。"))}
                }}catch(_:Exception){mutable.update{it.copy(notice="同步数据不兼容，请更新手机和电脑端。")}}
                }
            }
            override fun onClosed(webSocket:WebSocket,code:Int,reason:String) {
                if(epoch!=generation)return
                if(code==4001){mutable.update{it.copy(socketConnected=false,connecting=false,notice="电脑已撤销授权，请重新配对。")};markUnknown();return}
                lost(epoch)
            }
            override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?) {
                if(epoch!=generation)return
                if(response?.code==401){mutable.update{it.copy(socketConnected=false,connecting=false,notice="连接授权已失效，请重新配对。")};markUnknown();return}
                lost(epoch)
            }
        })
    }
    private fun lost(epoch:Int) {
        mutable.update{it.copy(socketConnected=false,connecting=true,notice="连接已中断，正在重连。尚未确认的操作不会自动重发。")};markUnknown()
        reconnect?.cancel();reconnect=viewModelScope.launch{delay((1000L shl attempt.coerceAtMost(4)).coerceAtMost(15000));attempt++;if(epoch==generation&&mutable.value.session!=null)connect()}
    }
    private fun checkPending(s:Session,epoch:Int) {
        val id=mutable.value.pendingId?:return
        viewModelScope.launch(Dispatchers.IO){try{val req=Request.Builder().url(s.url+"/api/operations/"+id).header("Authorization","Bearer "+s.token).build();client?.newCall(req)?.execute()?.use{r->if(r.isSuccessful&&epoch==generation){val j=JSONObject(r.body?.string()?:"{}");j.put("id",id);withContext(Dispatchers.Main){applyResult(j)}}}}catch(_:Exception){} }
    }
    private fun applyResult(j:JSONObject) {
        if(j.optString("id")!=mutable.value.pendingId)return
        timeout?.cancel()
        when(j.optString("status")){
            "sent"->{
                val before=mutable.value
                if(pendingKind=="attach"&&pendingAttachContext!=null){val key=pendingAttachContext!!;staged[key]=(staged[key]?:emptyList()).filter{it.id !in pendingAttachIds}}
                j.optString("clipboard").takeIf{it.isNotEmpty()}?.let{value->(getApplication<Application>().getSystemService(Application.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Codex",value))}
                if(before.clearDraftOnSuccess&&pendingDraftContext!=null){drafts.remove(pendingDraftContext);store.saveDrafts(drafts)}
                val clear=before.clearDraftOnSuccess&&before.snapshot.contextId==pendingDraftContext
                store.savePending(null);store.savePendingContext(null);pendingDraftContext=null
                mutable.update{it.copy(pendingId=null,pendingUnknown=false,notice=j.optString("message"),draft=if(clear)"" else it.draft,clearDraftOnSuccess=false,staged=staged[it.snapshot.contextId]?:emptyList())}
            }
            "rejected"->{store.savePending(null);store.savePendingContext(null);pendingDraftContext=null;mutable.update{it.copy(pendingId=null,pendingUnknown=false,notice=j.optString("message"),clearDraftOnSuccess=false)}}
            else->{mutable.update{it.copy(pendingUnknown=true,notice=j.optString("message","操作结果待确认，请检查聊天。"))}}
        }
    }
    private fun markUnknown(){if(mutable.value.pendingId!=null)mutable.update{it.copy(pendingUnknown=true)}}
    fun draft(text:String){val value=text.take(50000);mutable.value.snapshot.contextId?.let{drafts.put(it,value);store.saveDrafts(drafts)};mutable.update{it.copy(draft=value)}}
    fun theme(value:String){if(value !in listOf("system","light","dark"))return;store.saveTheme(value);mutable.update{it.copy(theme=value)}}
    fun notice(text:String?){mutable.update{it.copy(notice=text)}}
    fun acknowledgePending(){timeout?.cancel();store.savePending(null);store.savePendingContext(null);pendingDraftContext=null;mutable.update{it.copy(pendingId=null,pendingUnknown=false,clearDraftOnSuccess=false,notice="已解除待确认状态。请确认原指令未发送，再手动操作。")}}
    fun send(){val s=mutable.value;if(s.draft.isBlank()&&s.snapshot.attachments.isEmpty())return;if(s.staged.isNotEmpty()){notice("请先将待添加附件加入聊天。");return};val payload=JSONObject().put("text",s.draft);if(s.snapshot.composerRevision.isNotEmpty())payload.put("expectedComposerRevision",s.snapshot.composerRevision);operate("send",payload)}
    fun openMenu(menu:String){mutable.update{it.copy(hiddenMenuId=null)};operate("ui-open",JSONObject().put("menu",menu))}
    fun closeMenu(){
        val s=mutable.value
        mutable.update{it.hideMenu()}
        val context=s.snapshot.contextId?:return
        if(!s.socketConnected){notice("手机菜单已关闭。电脑离线，关闭请求不会自动重发。");return}
        val id=UUID.randomUUID().toString();if(dismissals.size>=64)dismissals.remove(dismissals.first());dismissals.add(id)
        val request=JSONObject().put("id",id).put("type","ui-close").put("threadId",context)
        if(socket?.send(request.toString())!=true){dismissals.remove(id);notice("手机菜单已关闭；电脑菜单未确认，可连接后重试。")} 
    }

    fun remote(surface:RemoteSurface,action:RemoteAction,fields:Map<String,String> = emptyMap()){operate("ui-action",JSONObject().put("surfaceId",surface.id).put("revision",surface.revision).put("actionId",action.id).put("fields",JSONObject(fields)))}
    fun remoteInput(surface:RemoteSurface,fields:Map<String,String>){operate("ui-input",JSONObject().put("surfaceId",surface.id).put("revision",surface.revision).put("fields",JSONObject(fields)))}
    fun editQueuedDraft(){val s=mutable.value;if(!s.snapshot.composerContextEditable)return;if(s.draft.isNotBlank()){notice("请先处理手机输入框中的草稿，避免覆盖。");return};draft(s.snapshot.composerContext);clearContext()}
    fun clearContext(){operate("context-clear")}
    fun queue(item:QueueItem,action:RemoteAction){operate("ui-action",JSONObject().put("surfaceId",item.id).put("revision",item.revision).put("actionId",action.id))}
    fun removeAttachment(action:RemoteAction){operate("attachment-remove",JSONObject().put("actionId",action.id))}
    fun discardStaged(id:String){val key=mutable.value.snapshot.contextId?:return;staged[key]=(staged[key]?:emptyList()).filter{it.id!=id};mutable.update{it.copy(staged=staged[key]?:emptyList())}}
    fun attachStaged(){val s=mutable.value;if(s.staged.isEmpty())return;pendingAttachContext=s.snapshot.contextId;pendingAttachIds=s.staged.map{it.id};operate("attach",JSONObject().put("uploads",org.json.JSONArray(pendingAttachIds)))}
    private suspend fun api(path:String,body:ByteArray?=null):ByteArray=withContext(Dispatchers.IO){
        val s=mutable.value.session?:throw IOException("请先配对电脑。")
        val request=Request.Builder().url(s.url+path).header("Authorization","Bearer "+s.token)
        if(body!=null)request.post(body.toRequestBody("application/octet-stream".toMediaType()))
        val c=client?:throw IOException("连接已断开。")
        c.newCall(request.build()).execute().use{r->val data=r.body?.bytes()?:byteArrayOf();if(!r.isSuccessful)throw IOException(runCatching{JSONObject(String(data)).optString("message","操作失败。")}.getOrDefault("操作失败。"));data}
    }
    suspend fun image(id:String):ByteArray{
        synchronized(images){images[id]?.let{return it}}
        val mine=generation
        val data=api("/api/images/"+id)
        if(mine!=generation)throw IOException("配对状态已变化。")
        synchronized(images){while(images.values.sumOf{it.size}+data.size>32*1024*1024&&images.isNotEmpty())images.remove(images.keys.first());if(data.size<=20*1024*1024)images[id]=data}
        return data
    }
    fun uploadUri(uri:Uri){val key=mutable.value.snapshot.contextId?:return;if(mutable.value.uploading)return
        mutable.update{it.copy(uploading=true,notice=null)}
        viewModelScope.launch{try{
            val pair=withContext(Dispatchers.IO){val resolver=getApplication<Application>().contentResolver;var name="手机文件";resolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use{c->if(c.moveToFirst())name=c.getString(0)}
                val data=resolver.openInputStream(uri)?.use{input->val out=ByteArrayOutputStream();val buffer=ByteArray(8192);while(true){val n=input.read(buffer);if(n<0)break;if(out.size()+n>20*1024*1024)throw IOException("单个文件不能超过 20 MB。");out.write(buffer,0,n)};out.toByteArray()}?:throw IOException("无法读取此文件。")
                name to data}
            uploadBytes(key,pair.first,pair.second)
        }catch(e:Exception){notice(e.message?:"上传失败，请重新选择重试。")}finally{mutable.update{it.copy(uploading=false)}}}
    }
    fun uploadDrawing(data:ByteArray){val key=mutable.value.snapshot.contextId?:return;if(mutable.value.uploading)return;mutable.update{it.copy(uploading=true)}
        viewModelScope.launch{try{uploadBytes(key,"手机绘图-"+System.currentTimeMillis()+".png",data)}catch(e:Exception){notice(e.message?:"绘图上传失败。")}finally{mutable.update{it.copy(uploading=false)}}}
    }
    private suspend fun uploadBytes(context:String,name:String,data:ByteArray){
        val path="/api/uploads?contextId="+java.net.URLEncoder.encode(context,"UTF-8")+"&name="+java.net.URLEncoder.encode(name,"UTF-8")
        val mine=generation
        val j=JSONObject(String(api(path,data)));if(mine!=generation)return;val preview=if(name.matches(Regex("(?i).*\\.(png|jpe?g|webp|gif)$")))data else null
        val file=StagedFile(j.getString("id"),j.getString("name"),context,preview);staged[context]=(staged[context]?:emptyList())+file
        mutable.update{it.copy(staged=staged[it.snapshot.contextId]?:emptyList(),notice="文件已上传，预览后点击“加入聊天”。")}
    }
    fun browse(folder:String?=null){mutable.update{it.copy(filesLoading=true)}
        viewModelScope.launch{try{val j=JSONObject(String(api("/api/files"+(folder?.let{"?folder=$it"}?:""))));mutable.update{it.copy(files=FileListing.parse(j))}}catch(e:Exception){notice(e.message?:"无法读取电脑文件。")}finally{mutable.update{it.copy(filesLoading=false)}}}
    }
    fun selectFile(id:String){val mine=generation;val key=mutable.value.snapshot.contextId?:return;if(mutable.value.uploading)return;mutable.update{it.copy(uploading=true)}
        viewModelScope.launch{try{val body=JSONObject().put("contextId",key).put("id",id).toString().toByteArray();val j=JSONObject(String(api("/api/files/select",body)));if(mine!=generation)return@launch;staged[key]=(staged[key]?:emptyList())+StagedFile(j.getString("id"),j.getString("name"),key);mutable.update{it.copy(staged=staged[it.snapshot.contextId]?:emptyList(),notice="电脑文件已选择，点击“加入聊天”。")}}catch(e:Exception){notice(e.message?:"无法添加此文件。")}finally{mutable.update{it.copy(uploading=false)}}}
    }
    fun select(id:String){if(mutable.value.snapshot.draftPresent){notice("电脑有未发送草稿，请先处理。");return};operate("select",threadId=id)}
    fun create(projectId:String?){if(mutable.value.snapshot.draftPresent){notice("电脑有未发送草稿，请先处理。");return};operate("create",JSONObject().put("projectId",projectId?:JSONObject.NULL).put("expectedRevision",mutable.value.snapshot.settingsRevision))}
    fun options(key:String){operate("options",JSONObject().put("setting",key).put("expectedRevision",mutable.value.snapshot.settingsRevision))}
    fun setting(key:String,id:String){val menu=mutable.value.snapshot.menu?:return;operate("setting",JSONObject().put("setting",key).put("optionId",id).put("expectedRevision",menu.revision))}
    fun confirm(c:Confirmation,accept:Boolean){operate("confirm",JSONObject().put("confirmationId",c.id).put("decision",if(accept)"accept" else "decline"))}
    fun history(){operate("history")}
    fun stop(){operate("stop")}
    fun approve(a:Approval,accept:Boolean){operate("approve",JSONObject().put("approvalId",a.id).put("decision",if(accept)"accept" else "decline"))}
    private fun operate(type:String,extra:JSONObject=JSONObject(),threadId:String?=mutable.value.snapshot.contextId) {
        val s=mutable.value
        if(!s.socketConnected||!s.snapshot.compatible||s.pendingId!=null||threadId==null){notice("当前无法操作，请确认电脑已连接，并处理待确认的操作。");return}
        if(type=="send"&&s.snapshot.draftPresent){notice("电脑有未发送的草稿，请先处理。");return}
        val id=UUID.randomUUID().toString();extra.put("id",id).put("type",type).put("threadId",threadId)
        pendingKind=type
        pendingDraftContext=if(type=="send")s.snapshot.contextId else null;store.savePendingContext(pendingDraftContext)
        store.savePending(id);mutable.update{it.copy(pendingId=id,pendingUnknown=false,notice=null,clearDraftOnSuccess=type=="send")}
        if(socket?.send(extra.toString())!=true){markUnknown();notice("发送结果待确认。请连接后检查聊天，不要重复发送。");return}
        timeout?.cancel();timeout=viewModelScope.launch{delay(12000);if(mutable.value.pendingId==id){markUnknown();notice("操作尚未确认，请检查聊天，不要重复发送。")}}
    }
    fun forget(){dismissals.clear();generation++;reconnect?.cancel();timeout?.cancel();socket?.cancel();client?.connectionPool?.evictAll();synchronized(images){images.clear()};staged.clear();store.saveSession(null);store.savePending(null);store.savePendingContext(null);store.saveDrafts(JSONObject());drafts.keys().asSequence().toList().forEach{drafts.remove(it)};mutable.value=UiState(theme=store.theme())}
    override fun onCleared(){generation++;reconnect?.cancel();socket?.cancel();client?.dispatcher?.executorService?.shutdown();super.onCleared()}
}
