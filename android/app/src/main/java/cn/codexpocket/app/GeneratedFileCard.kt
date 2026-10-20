package cn.codexpocket.app

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale

internal fun readableFileSize(size:Long?):String=when{
    size==null->"大小未知"
    size>=1024*1024->String.format(Locale.ROOT,"%.1f MB",size/1048576.0)
    size>=1024->String.format(Locale.ROOT,"%.1f KB",size/1024.0)
    else->"$size B"
}
@Composable internal fun GeneratedFileCard(file:GeneratedFile,vm:PocketViewModel){
    val s by vm.state.collectAsStateWithLifecycle()
    val downloading=s.downloadingId==file.id
    OutlinedCard(modifier=Modifier.fillMaxWidth().padding(top=10.dp)){
        Column(Modifier.padding(14.dp)){
            Row(verticalAlignment=Alignment.CenterVertically){
                Icon(Icons.Rounded.Description,null,tint=MaterialTheme.colorScheme.primary,modifier=Modifier.size(30.dp))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)){Text(file.name,fontWeight=FontWeight.SemiBold,maxLines=2,overflow=TextOverflow.Ellipsis);Text(readableFileSize(file.size),fontSize=12.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)}
            }
            if(downloading){
                LinearProgressIndicator(progress={s.downloadProgress/100f},modifier=Modifier.fillMaxWidth().padding(top=12.dp))
                Row(verticalAlignment=Alignment.CenterVertically){Text("正在下载 ${s.downloadProgress}%",fontSize=12.sp,modifier=Modifier.weight(1f));TextButton(onClick={vm.cancelDownload()}){Text("取消")}}
            }else{
                file.reason?.let{Text(it,color=MaterialTheme.colorScheme.error,fontSize=12.sp,modifier=Modifier.padding(top=8.dp))}
                TextButton(onClick={s.snapshot.contextId?.let{vm.downloadFile(file,it)}},enabled=file.available&&s.session!=null&&s.socketConnected&&s.downloadingId==null,modifier=Modifier.align(Alignment.End)){Text("下载并选择应用打开")}
            }
        }
    }
}
