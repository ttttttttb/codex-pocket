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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.io.File
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
    val uploading:Boolean=false,val staged:List<StagedFile> = emptyList(),val files:FileListing?=null,val filesLoading:Boolean=false,val hiddenMenuId:String?=null,
    val downloadingId:String?=null,val downloadProgress:Int=0,val openableFile:OpenableFile?=null,val dialogClosePendingId:String?=null,
    val folders:FileListing?=null,val foldersLoading:Boolean=false,val foldersError:String?=null){
    val remoteMenu:RemoteSurface? get()=snapshot.surfaces.lastOrNull{it.kind=="menu"}?.takeIf{hiddenMenuId==null&&!snapshot.hasModal}
    fun hideMenu()=copy(hiddenMenuId=snapshot.surfaces.lastOrNull{it.kind=="menu"}?.id?:hiddenMenuId)
}

private class FileTransferTask {@Volatile var call:okhttp3.Call?=null;var job:Job?=null}

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
    @Volatile private var downloadTask:FileTransferTask?=null
    private val downloadMutex=Mutex()
    private var folderRequest=0
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
                        it.copy(snapshot=snapshot,draft=if(newKey==oldKey)it.draft else drafts.optString(newKey?:""),staged=staged[newKey]?:emptyList(),hiddenMenuId=if(newKey!=oldKey||snapshot.surfaces.none{x->x.kind=="menu"})null else it.hiddenMenuId,dialogClosePendingId=if(newKey!=oldKey||snapshot.modalId!=it.snapshot.modalId)null else it.dialogClosePendingId)
                    }}}
                    "result"->{val result=j.getJSONObject("result");if(dismissals.remove(result.optString("id"))){mutable.update{it.copy(dialogClosePendingId=if(it.dialogClosePendingId==result.optString("id"))null else it.dialogClosePendingId)};if(result.optString("status")!="sent")notice(result.optString("message","电脑弹窗或菜单暂未关闭，请核对后重试。"))}else applyResult(result)}
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

    // Cancel is independent of an uncertain chat operation: never erase or
    // retry that operation just to reach the desktop's cancel button.
    fun dismissDialog(){
        val s=mutable.value;val context=s.snapshot.contextId?:return
        if(!s.socketConnected||!s.snapshot.compatible||s.dialogClosePendingId!=null)return
        val c=s.snapshot.activeConfirmation;val d=s.snapshot.activeDialog
        val request=if(c!=null)JSONObject().put("type","confirm").put("confirmationId",c.id).put("decision","decline")
            else if(d?.dismissAction!=null)JSONObject().put("type","ui-action").put("surfaceId",d.id).put("revision",d.revision).put("actionId",d.dismissAction!!.id)
            else{notice("桌面未提供可安全同步的关闭按钮，请在电脑处理此弹窗。");return}
        val id=UUID.randomUUID().toString();if(dismissals.size>=64)dismissals.remove(dismissals.first());dismissals.add(id)
        request.put("id",id).put("threadId",context);mutable.update{it.copy(dialogClosePendingId=id,notice=null)}
        if(socket?.send(request.toString())!=true){dismissals.remove(id);mutable.update{it.copy(dialogClosePendingId=null,notice="弹窗关闭结果待确认；恢复连接后请检查，不会自动重发。")};return}
        viewModelScope.launch{delay(5000);mutable.update{if(it.dialogClosePendingId==id)it.copy(dialogClosePendingId=null,notice="尚未确认电脑弹窗已关闭，请检查当前弹窗后再操作。")else it}}
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
    fun consumeOpenable(id:String){mutable.update{if(it.openableFile?.requestId==id)it.copy(openableFile=null) else it}}
    fun cancelDownload(){val task=downloadTask;downloadTask=null;task?.call?.cancel();task?.job?.cancel();mutable.update{it.copy(downloadingId=null,downloadProgress=0)}}
    fun downloadFile(file:GeneratedFile,contextId:String){
        if(mutable.value.downloadingId!=null){notice("请等待当前文件下载完成，或先取消下载。");return}
        val session=mutable.value.session?:return
        if(!file.available||file.size==null||file.size !in 0..DownloadPolicy.MAX){notice(file.reason?:"文件不可下载。");return}
        val c=client?:return
        val task=FileTransferTask();downloadTask=task
        mutable.update{it.copy(downloadingId=file.id,downloadProgress=0,notice=null)}
        task.job=viewModelScope.launch{
            var partial:File?=null
            try{
                val ready=downloadMutex.withLock{withContext(Dispatchers.IO){
                    if(downloadTask!==task)throw kotlinx.coroutines.CancellationException()
                    val dir=File(getApplication<Application>().cacheDir,"downloads");dir.mkdirs();DownloadPolicy.clean(dir,file.size)
                    val filename=UUID.randomUUID().toString()+"-"+DownloadPolicy.safeName(file.name)
                    val temp=File(dir,filename+".part");partial=temp
                    val url=session.url+"/api/downloads/"+file.id+"?contextId="+java.net.URLEncoder.encode(contextId,"UTF-8")
                    val call=c.newBuilder().readTimeout(30,TimeUnit.SECONDS).callTimeout(10,TimeUnit.MINUTES).build().newCall(Request.Builder().url(url).header("Authorization","Bearer "+session.token).build());task.call=call
                    if(downloadTask!==task){call.cancel();throw kotlinx.coroutines.CancellationException()}
                    call.execute().use{r->
                        if(!r.isSuccessful){val error=r.body?.source()?.readUtf8( minOf(8192L,r.body?.contentLength()?.takeIf{it>=0}?:0L))?:"";throw IOException(runCatching{JSONObject(error).optString("message","下载失败，请检查电脑连接后重试。")}.getOrDefault("下载失败，请检查电脑连接后重试。"))}
                        val body=r.body?:throw IOException("电脑没有返回文件。")
                        if(body.contentLength()!=file.size)throw IOException("文件大小已变化，请刷新聊天后重试。")
                        val expectedHash=r.header("X-File-SHA256")?.lowercase()?.takeIf{it.matches(Regex("[0-9a-f]{64}"))}?:throw IOException("电脑端未提供文件校验，请更新电脑端。")
                        val hash=java.security.MessageDigest.getInstance("SHA-256")
                        java.security.DigestInputStream(body.byteStream(),hash).use{input->temp.outputStream().use{output->DownloadPolicy.copy(input,output,file.size){done->val percent=if(file.size==0L)100 else (done*100/file.size).toInt();if(downloadTask===task&&mutable.value.downloadProgress!=percent)mutable.update{it.copy(downloadProgress=percent)}}}}
                        val actualHash=hash.digest().joinToString(""){"%02x".format(it)}
                        if(actualHash!=expectedHash)throw IOException("文件校验失败，电脑文件可能正在变化，请稍后重试。")
                    }
                    if(downloadTask!==task||mutable.value.session!=session||call.isCanceled())throw IOException("下载已取消。")
                    val target=File(dir,filename);if(!temp.renameTo(target))throw IOException("手机存储空间不足或文件无法保存。")
                    partial=null;OpenableFile(target,file.mime,UUID.randomUUID().toString())
                }}
                if(downloadTask===task&&mutable.value.session==session)mutable.update{it.copy(openableFile=ready)}else ready.file.delete()
            }catch(_:kotlinx.coroutines.CancellationException){}catch(e:Exception){if(downloadTask===task)notice(e.message?:"下载失败，请检查网络后重新点击文件卡片。")}
            finally{partial?.delete();if(downloadTask===task){downloadTask=null;mutable.update{it.copy(downloadingId=null,downloadProgress=0)}}}
        }
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
    fun browseFolders(folder:String?=null){val request=++folderRequest;val epoch=generation;mutable.update{it.copy(folders=null,foldersLoading=true,foldersError=null)}
        viewModelScope.launch{try{val j=JSONObject(String(api("/api/files?directoriesOnly=1"+(folder?.let{"&folder=$it"}?:""))));if(request==folderRequest&&epoch==generation)mutable.update{it.copy(folders=FileListing.parse(j))}}catch(e:Exception){if(request==folderRequest&&epoch==generation)mutable.update{it.copy(foldersError=e.message?:"无法读取电脑目录。")}}finally{if(request==folderRequest)mutable.update{it.copy(foldersLoading=false)}}}
    }
    fun catalog(){val s=mutable.value;if(s.pendingId!=null||!s.socketConnected||!s.snapshot.canLoadCatalog||s.snapshot.hasModal)return;operate("catalog")}
    fun create(projectId:String?,folderId:String?=null){if(mutable.value.snapshot.draftPresent){notice("电脑有未发送草稿，请先处理。");return};val payload=JSONObject().put("projectId",projectId?:JSONObject.NULL).put("expectedRevision",mutable.value.snapshot.settingsRevision);folderId?.let{payload.put("folderId",it)};operate("create",payload)}
    fun options(key:String){operate("options",JSONObject().put("setting",key).put("expectedRevision",mutable.value.snapshot.settingsRevision))}
    fun setting(key:String,id:String){val menu=mutable.value.snapshot.menu?:return;operate("setting",JSONObject().put("setting",key).put("optionId",id).put("expectedRevision",menu.revision))}
    fun confirm(c:Confirmation,accept:Boolean){operate("confirm",JSONObject().put("confirmationId",c.id).put("decision",if(accept)"accept" else "decline"))}
    fun history(){operate("history")}
    fun stop(){operate("stop")}
    fun approve(a:Approval,accept:Boolean){operate("approve",JSONObject().put("approvalId",a.id).put("decision",if(accept)"accept" else "decline"))}
    private fun operate(type:String,extra:JSONObject=JSONObject(),threadId:String?=mutable.value.snapshot.contextId) {
        val s=mutable.value
        if(!s.socketConnected||!s.snapshot.compatible||s.pendingId!=null||threadId==null){notice("当前无法操作，请确认电脑已连接，并处理待确认的操作。");return}
        if(s.snapshot.hasModal&&type !in listOf("confirm","ui-action","ui-input")){notice("请先确认或取消当前桌面弹窗。");return}
        if(type=="send"&&s.snapshot.draftPresent){notice("电脑有未发送的草稿，请先处理。");return}
        val id=UUID.randomUUID().toString();extra.put("id",id).put("type",type).put("threadId",threadId)
        pendingKind=type
        pendingDraftContext=if(type=="send")s.snapshot.contextId else null;store.savePendingContext(pendingDraftContext)
        store.savePending(id);mutable.update{it.copy(pendingId=id,pendingUnknown=false,notice=null,clearDraftOnSuccess=type=="send")}
        if(socket?.send(extra.toString())!=true){markUnknown();notice("发送结果待确认。请连接后检查聊天，不要重复发送。");return}
        timeout?.cancel();timeout=viewModelScope.launch{delay(12000);if(mutable.value.pendingId==id){markUnknown();notice("操作尚未确认，请检查聊天，不要重复发送。")}}
    }
    fun forget(){cancelDownload();File(getApplication<Application>().cacheDir,"downloads").deleteRecursively();dismissals.clear();generation++;reconnect?.cancel();timeout?.cancel();socket?.cancel();client?.connectionPool?.evictAll();synchronized(images){images.clear()};staged.clear();store.saveSession(null);store.savePending(null);store.savePendingContext(null);store.saveDrafts(JSONObject());drafts.keys().asSequence().toList().forEach{drafts.remove(it)};mutable.value=UiState(theme=store.theme())}
    override fun onCleared(){cancelDownload();generation++;reconnect?.cancel();socket?.cancel();client?.dispatcher?.executorService?.shutdown();super.onCleared()}
}
