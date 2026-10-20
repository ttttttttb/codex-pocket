package cn.codexpocket.app

import android.content.ClipData
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

data class GeneratedFile(val id:String,val name:String,val size:Long?,val mime:String,val available:Boolean,val reason:String?) {
    companion object { fun parse(j:org.json.JSONObject)=GeneratedFile(j.getString("id"),j.getString("name"),if(j.has("size"))j.getLong("size") else null,j.optString("mime","application/octet-stream"),j.optBoolean("available"),j.optString("reason").takeIf{it.isNotBlank()}) }
}
data class OpenableFile(val file:File,val mime:String,val requestId:String)

object DownloadPolicy {
    const val MAX=100L*1024*1024
    fun safeName(name:String):String {
        val safe=name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\x00-\\x1f<>:\"/\\\\|?*]"),"_").trim().takeUnless{it.isBlank()||it.all{c->c=='.'}}?:"文件"
        val extension=safe.substringAfterLast('.',"").takeIf{it.matches(Regex("[A-Za-z0-9]{1,12}"))}?.let{".$it"}?:""
        var stem=safe.dropLast(extension.length)
        while((stem+extension).toByteArray(Charsets.UTF_8).size>180){val count=Character.charCount(stem.codePointBefore(stem.length));stem=stem.dropLast(count)}
        return stem+extension
    }
    fun copy(input:InputStream,output:OutputStream,expected:Long,progress:(Long)->Unit):Long {
        if(expected !in 0..MAX)throw IOException("文件超过 100 MB 或大小无效。")
        var total=0L;val buffer=ByteArray(32768)
        while(true){val n=input.read(buffer);if(n<0)break;total+=n;if(total>MAX||total>expected)throw IOException("文件在下载期间发生变化，请刷新聊天后重试。");output.write(buffer,0,n);progress(total)}
        if(total!=expected)throw IOException("下载未完成，请检查网络后重新点击文件卡片。")
        return total
    }
    fun clean(dir:File,reserve:Long=0){
        if(!dir.exists())return
        val files=dir.listFiles()?.filter{it.isFile}?.sortedByDescending{it.lastModified()}?:return
        var retained=reserve
        files.forEach{f->if(System.currentTimeMillis()-f.lastModified()>24*60*60*1000L||retained+f.length()>250L*1024*1024||f.name.endsWith(".part"))f.delete() else retained+=f.length()}
    }
}

@Composable internal fun DownloadedFileLauncher(s:UiState,vm:PocketViewModel){
    val context=LocalContext.current
    LaunchedEffect(s.openableFile?.requestId){
        val item=s.openableFile?:return@LaunchedEffect
        try{
            val uri=FileProvider.getUriForFile(context,context.packageName+".files",item.file)
            val view=Intent(Intent.ACTION_VIEW).setDataAndType(uri,item.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply{clipData=ClipData.newRawUri("聊天文件",uri)}
            if(view.resolveActivity(context.packageManager)==null)vm.notice("手机没有可打开此类文件的应用，请先安装相应阅读器，再点击文件卡片。")
            else context.startActivity(Intent.createChooser(view,"选择应用打开").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        }catch(_:Exception){vm.notice("无法打开文件，请安装相应阅读器后重试。")}
        finally{vm.consumeOpenable(item.requestId)}
    }
}
