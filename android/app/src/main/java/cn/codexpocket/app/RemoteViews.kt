package cn.codexpocket.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun RemotePanels(s:UiState,vm:PocketViewModel,allowMenus:Boolean=true){
    var files by remember{mutableStateOf(false)};var sources by remember{mutableStateOf(false)}
    var drawing by remember{mutableStateOf(false)};var drawingPreview by remember{mutableStateOf<ByteArray?>(null)}
    var confirm by remember{mutableStateOf<Pair<RemoteSurface,RemoteAction>?>(null)}
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){it?.let{vm.uploadUri(it)}}
    val ready=s.socketConnected&&s.snapshot.compatible&&s.pendingId==null&&!s.uploading
    val menu=s.remoteMenu?.takeIf{allowMenus}
    val dialog=s.snapshot.surfaces.lastOrNull{it.kind=="dialog"}
    LaunchedEffect(s.snapshot.contextId){files=false;sources=false;drawing=false;drawingPreview=null;confirm=null}
    if(menu!=null&&!sources&&!files&&!drawing&&drawingPreview==null){
        ModalBottomSheet(onDismissRequest={vm.closeMenu()}){
            Column(Modifier.fillMaxWidth().heightIn(max=560.dp).verticalScroll(rememberScrollState()).padding(20.dp)){
                Row(verticalAlignment=Alignment.CenterVertically){Text(menu.title.ifBlank{"聊天操作"},style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f));IconButton(onClick={vm.closeMenu()}){Icon(Icons.Rounded.Close,"关闭同步菜单")}}
                if(s.pendingId!=null)Text("操作处理中，可随时关闭菜单。")
                MenuFields(menu,ready){vm.remoteInput(menu,it)}
                menu.actions.forEach{a->
                    ListItem(headlineContent={Text(a.label)},leadingContent={Icon(if(a.selected)Icons.Rounded.CheckCircle else Icons.Rounded.ChevronRight,null)},modifier=Modifier.clickable(enabled=ready&&!a.disabled){
                        when{
                            a.label.startsWith("文件和文件夹")-> {vm.closeMenu();sources=true}
                            a.label.startsWith("绘图")-> {vm.closeMenu();drawing=true}
                            a.confirm->confirm=menu to a
                            else->vm.remote(menu,a)
                        }
                    },supportingContent=if(a.disabled){{Text("电脑当前不可用")}}else null)
                }
                if(menu.title=="添加内容"&&menu.actions.none{it.label.startsWith("绘图")})ListItem(headlineContent={Text("手机绘图")},supportingContent={Text("画完预览后加入当前聊天")},leadingContent={Icon(Icons.Rounded.Draw,null)},modifier=Modifier.clickable(enabled=ready&&!s.snapshot.draftPresent){vm.closeMenu();drawing=true})
                if(menu.actions.isEmpty())Text("当前菜单暂无可用操作")
                s.notice?.let{Text(it,color=MaterialTheme.colorScheme.error)}
            }
        }
    }
    if(dialog!=null&&s.snapshot.confirmation==null)Dialog(onDismissRequest={},properties=DialogProperties(usePlatformDefaultWidth=false)){
        Surface(Modifier.fillMaxWidth().padding(16.dp).heightIn(max=680.dp),shape=RoundedCornerShape(24.dp)){
            Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)){RemoteForm(dialog,ready){a,f->if(a.confirm)confirm=dialog to a else vm.remote(dialog,a,f)};if(dialog.actions.isEmpty()&&dialog.fields.isEmpty())TextButton(onClick={vm.closeMenu()},enabled=ready){Text("关闭")}}
        }
    }
    confirm?.let{(surface,action)->AlertDialog(onDismissRequest={confirm=null},title={Text("确认"+action.label.lineSequence().first()+"？")},text={Text("将操作电脑上的当前聊天。")},confirmButton={TextButton(onClick={vm.remote(surface,action);confirm=null},enabled=ready){Text("确认")}},dismissButton={TextButton(onClick={confirm=null}){Text("取消")}})}
    if(sources)AlertDialog(onDismissRequest={sources=false},title={Text("添加文件和图片")},text={Column{
        Text("每个文件上限 20 MB。文件夹可展开后选择文件。")
        TextButton(onClick={sources=false;picker.launch(arrayOf("*/*"))},enabled=ready){Icon(Icons.Rounded.PhoneAndroid,null);Text("从手机选择")}
        TextButton(onClick={sources=false;files=true;vm.browse()},enabled=ready){Icon(Icons.Rounded.Computer,null);Text("从电脑选择")}
    }},confirmButton={TextButton(onClick={sources=false}){Text("取消")}})
    if(files)ModalBottomSheet(onDismissRequest={files=false}){
        Column(Modifier.fillMaxWidth().heightIn(max=600.dp).verticalScroll(rememberScrollState()).padding(20.dp)){
            Row(verticalAlignment=Alignment.CenterVertically){Text(s.files?.name?:"电脑文件",style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f));TextButton(onClick={vm.browse()},enabled=!s.filesLoading){Text("磁盘列表")}}
            Text(s.files?.note?:"选择磁盘，然后展开文件夹。",style=MaterialTheme.typography.bodySmall)
            if(s.filesLoading||s.uploading)LinearProgressIndicator(Modifier.fillMaxWidth())
            s.files?.entries?.forEach{f->ListItem(headlineContent={Text(f.name)},leadingContent={Icon(if(f.directory)Icons.Rounded.Folder else Icons.Rounded.InsertDriveFile,null)},modifier=Modifier.clickable(enabled=ready&&!s.filesLoading){if(f.directory)vm.browse(f.id)else{vm.selectFile(f.id);files=false}})}
            s.notice?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        }
    }
    if(drawing)DrawingBoard(onCancel={drawing=false},onComplete={drawing=false;drawingPreview=it})
    drawingPreview?.let{bytes->AlertDialog(onDismissRequest={drawingPreview=null},title={Text("加入这幅绘图？")},text={LocalPicture(bytes,"手机绘图")},confirmButton={TextButton(onClick={vm.uploadDrawing(bytes);drawingPreview=null},enabled=ready){Text("上传并预览附件")}},dismissButton={TextButton(onClick={drawingPreview=null}){Text("取消")}})}
}

@Composable private fun RemoteFieldView(field:RemoteField,value:String,enabled:Boolean,onChange:(String)->Unit){
    if(field.type=="select"){
        var expanded by remember{mutableStateOf(false)}
        Box{OutlinedButton(onClick={expanded=true},enabled=enabled){Text(field.label+"："+(field.options.find{it.value==value}?.label?:value));Icon(Icons.Rounded.ExpandMore,null)}
            DropdownMenu(expanded,onDismissRequest={expanded=false}){field.options.forEach{o->DropdownMenuItem(text={Text(o.label)},onClick={onChange(o.value);expanded=false})}}
        }
    }else OutlinedTextField(value=value,onValueChange=onChange,label={Text(field.label)},modifier=Modifier.fillMaxWidth(),enabled=enabled,minLines=if(field.type=="textarea")3 else 1)
}

@Composable private fun MenuFields(surface:RemoteSurface,enabled:Boolean,onApply:(Map<String,String>)->Unit){
    var values by rememberSaveable(surface.id){mutableStateOf(surface.fields.associate{it.id to it.value})}
    surface.fields.forEach{f->RemoteFieldView(f,values[f.id]?:f.value,enabled){values=values+(f.id to it)}}
    if(surface.fields.isNotEmpty())TextButton(onClick={onApply(values.filter{(id,v)->surface.fields.any{it.id==id&&it.value!=v}})},enabled=enabled&&surface.fields.any{values[it.id]!=it.value}){Text("更新电脑菜单")}
}

@Composable internal fun RemoteForm(surface:RemoteSurface,enabled:Boolean,onAction:(RemoteAction,Map<String,String>)->Unit){
    var values by rememberSaveable(surface.id,surface.title){mutableStateOf(surface.fields.associate{it.id to it.value})}
    var baseline by rememberSaveable(surface.id,surface.title){mutableStateOf(surface.fields.associate{it.id to it.value})}
    var edited by rememberSaveable(surface.id,surface.title){mutableStateOf(listOf<String>())}
    var conflict by remember{mutableStateOf(false)}
    LaunchedEffect(surface.fields){
        val changedByDesktop=surface.fields.filter{baseline[it.id]!=it.value}.map{it.id}
        if(changedByDesktop.any{it in edited})conflict=true
        edited=edited.filter{it !in changedByDesktop}
        values=values+surface.fields.filter{it.id !in edited}.associate{it.id to it.value}
        baseline=surface.fields.associate{it.id to it.value}
    }
    val changed=values.filter{(id,value)->id in edited&&surface.fields.any{it.id==id&&it.value!=value}}
    Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
        Text(surface.title,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold)
        if(surface.body.isNotBlank()&&surface.body!=surface.title)androidx.compose.foundation.text.selection.SelectionContainer{Text(surface.body)}
        if(conflict)Text("电脑已修改回答，已同步电脑内容，请重新核对。",color=MaterialTheme.colorScheme.error)
        surface.fields.forEach{f->RemoteFieldView(f,values[f.id]?:f.value,enabled){values=values+(f.id to it);edited=(edited+f.id).distinct();conflict=false}}
        surface.actions.forEach{a->OutlinedButton(onClick={onAction(a,changed)},enabled=enabled&&(!a.disabled||changed.isNotEmpty()&&Regex("^(发送|提交|确认|保存|下一|Send|Submit|Confirm|Save|Next)",RegexOption.IGNORE_CASE).containsMatchIn(a.label)),modifier=Modifier.fillMaxWidth()){
            if(a.selected){Icon(Icons.Rounded.CheckCircle,null);Spacer(Modifier.width(8.dp))}
            Text(a.label,modifier=Modifier.weight(1f))
        }}
    }
}

@Composable internal fun QueueCard(item:QueueItem,s:UiState,vm:PocketViewModel){
    var expanded by rememberSaveable(item.id){mutableStateOf(false)};var confirm by remember{mutableStateOf<RemoteAction?>(null)}
    val ready=s.socketConnected&&s.snapshot.compatible&&s.pendingId==null
    OutlinedCard(shape=RoundedCornerShape(16.dp)){
        Column(Modifier.fillMaxWidth().padding(12.dp)){
            Row(verticalAlignment=Alignment.CenterVertically){
                Icon(Icons.Rounded.Queue,null,Modifier.size(18.dp));Spacer(Modifier.width(8.dp))
                Text(item.text,Modifier.weight(1f).clickable{expanded=!expanded},maxLines=if(expanded)Int.MAX_VALUE else 1,overflow=TextOverflow.Ellipsis)
                item.actions.forEach{a->
                    when{
                        a.label.startsWith("引导")||a.label.startsWith("Steer")->TextButton(onClick={vm.queue(item,a)},enabled=ready&&!a.disabled,contentPadding=PaddingValues(8.dp)){Text("引导")}
                        Regex("删除|移除|Delete|Remove",RegexOption.IGNORE_CASE).containsMatchIn(a.label)->IconButton(onClick={confirm=a},enabled=ready&&!a.disabled){Icon(Icons.Rounded.DeleteOutline,"删除待处理消息")}
                        a.label=="查看完整消息"->IconButton(onClick={vm.queue(item,a)},enabled=ready&&!a.disabled){Icon(Icons.Rounded.OpenInFull,a.label)}
                        a.label.startsWith("重试")||a.label.startsWith("Retry")->TextButton(onClick={vm.queue(item,a)},enabled=ready&&!a.disabled){Text("重试")}
                        else->IconButton(onClick={vm.queue(item,a)},enabled=ready&&!a.disabled){Icon(Icons.Rounded.MoreHoriz,a.label)}
                    }
                }
            }
            if(expanded)item.images.forEach{RemotePicture(it,vm)}
        }
    }
    confirm?.let{a->AlertDialog(onDismissRequest={confirm=null},title={Text("删除这条待处理消息？")},text={Text(item.text,maxLines=6,overflow=TextOverflow.Ellipsis)},confirmButton={TextButton(onClick={vm.queue(item,a);confirm=null},enabled=ready){Text("删除")}},dismissButton={TextButton(onClick={confirm=null}){Text("取消")}})}
}

@Composable internal fun Attachments(s:UiState,vm:PocketViewModel){
    val ready=s.socketConnected&&s.pendingId==null&&!s.uploading
    Column{
        if(s.uploading){LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在上传文件…",style=MaterialTheme.typography.bodySmall)}
        if(s.staged.isNotEmpty())Column(Modifier.heightIn(max=240.dp).verticalScroll(rememberScrollState())){
            s.staged.forEach{file->Row(verticalAlignment=Alignment.CenterVertically){Column(Modifier.weight(1f)){Text(file.name,maxLines=1,overflow=TextOverflow.Ellipsis);file.preview?.let{LocalPicture(it,file.name,Modifier.height(90.dp))}};IconButton(onClick={vm.discardStaged(file.id)},enabled=ready){Icon(Icons.Rounded.Close,"移除待添加附件")}}}
            TextButton(onClick={vm.attachStaged()},enabled=ready&&!s.snapshot.draftPresent){Text("加入聊天（尚未发送）")}
        }
        s.snapshot.attachments.forEach{a->Column{a.images.forEach{RemotePicture(it,vm)};Row(verticalAlignment=Alignment.CenterVertically){Icon(Icons.Rounded.AttachFile,null);Text(a.label.removePrefix("移除").trim('“','”'),Modifier.weight(1f),maxLines=1,overflow=TextOverflow.Ellipsis);IconButton(onClick={vm.removeAttachment(a)},enabled=ready){Icon(Icons.Rounded.Close,"移除聊天附件")}}}}
    }
}

@Composable internal fun RemotePicture(picture:Picture,vm:PocketViewModel){
    var retry by remember(picture.id){mutableIntStateOf(0)}
    val result by produceState<Result<ByteArray>?>(null,picture.id,retry){value=null;value=runCatching{vm.image(picture.id)}}
    when{
        result==null->Box(Modifier.fillMaxWidth().height(110.dp),contentAlignment=Alignment.Center){CircularProgressIndicator()}
        result!!.isFailure->OutlinedButton(onClick={retry++}){Text("图片加载失败，点击重试")}
        else->LocalPicture(result!!.getOrThrow(),picture.alt)
    }
}
@Composable internal fun LocalPicture(bytes:ByteArray,alt:String,modifier:Modifier=Modifier){
    var full by remember{mutableStateOf(false)}
    val bitmap by produceState<Bitmap?>(null,bytes){value=withContext(Dispatchers.Default){runCatching{val o=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,o);o.inSampleSize=(maxOf(o.outWidth,o.outHeight)/2048).coerceAtLeast(1);o.inJustDecodeBounds=false;BitmapFactory.decodeByteArray(bytes,0,bytes.size,o)}.getOrNull()}}
    if(bitmap==null)Text("图片正在加载或格式不支持",style=MaterialTheme.typography.bodySmall)
    else Image(bitmap!!.asImageBitmap(),alt,modifier.fillMaxWidth().heightIn(max=240.dp).clickable{full=true},contentScale=ContentScale.Fit)
    if(full&&bitmap!=null)Dialog(onDismissRequest={full=false},properties=DialogProperties(usePlatformDefaultWidth=false)){
        var scale by remember{mutableFloatStateOf(1f)};var offset by remember{mutableStateOf(Offset.Zero)}
        Box(Modifier.fillMaxSize().background(Color.Black).pointerInput(Unit){detectTransformGestures{_,pan,zoom,_->scale=(scale*zoom).coerceIn(1f,8f);offset=if(scale==1f)Offset.Zero else offset+pan}}){
            Image(bitmap!!.asImageBitmap(),alt,Modifier.fillMaxSize().graphicsLayer(scaleX=scale,scaleY=scale,translationX=offset.x,translationY=offset.y),contentScale=ContentScale.Fit)
            IconButton(onClick={full=false},modifier=Modifier.align(Alignment.TopEnd).statusBarsPadding()){Icon(Icons.Rounded.Close,"关闭图片",tint=Color.White)}
        }
    }
}

@Composable private fun DrawingBoard(onCancel:()->Unit,onComplete:(ByteArray)->Unit){
    var strokes by remember{mutableStateOf<List<List<Offset>>>(emptyList())};var current by remember{mutableStateOf<List<Offset>>(emptyList())}
    var size by remember{mutableStateOf(androidx.compose.ui.geometry.Size(1f,1f))}
    Dialog(onDismissRequest=onCancel,properties=DialogProperties(usePlatformDefaultWidth=false)){
        Surface(Modifier.fillMaxSize()){Column(Modifier.statusBarsPadding().navigationBarsPadding()){
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
                TextButton(onClick=onCancel){Text("取消")};Text("手机画板",Modifier.weight(1f),fontWeight=FontWeight.Bold)
                IconButton(onClick={strokes=strokes.dropLast(1)},enabled=strokes.isNotEmpty()){Icon(Icons.Rounded.Undo,"撤销")}
                IconButton(onClick={strokes=emptyList();current=emptyList()}){Icon(Icons.Rounded.DeleteSweep,"清空")}
                TextButton(onClick={
                    val width=1400;val height=(width*size.height/size.width).toInt().coerceIn(1,2400);val bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);val canvas=android.graphics.Canvas(bitmap);canvas.drawColor(android.graphics.Color.WHITE)
                    val paint=android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply{color=android.graphics.Color.BLACK;strokeWidth=4f;style=android.graphics.Paint.Style.STROKE;strokeCap=android.graphics.Paint.Cap.ROUND;strokeJoin=android.graphics.Paint.Join.ROUND}
                    for(line in strokes){val path=android.graphics.Path();line.forEachIndexed{i,p->val x=p.x/size.width*width;val y=p.y/size.height*height;if(i==0)path.moveTo(x,y)else path.lineTo(x,y)};canvas.drawPath(path,paint)}
                    val out=ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.PNG,100,out);bitmap.recycle();onComplete(out.toByteArray())
                },enabled=strokes.isNotEmpty()){Text("完成")}
            }
            Canvas(Modifier.fillMaxWidth().weight(1f).background(Color.White).pointerInput(Unit){detectDragGestures(onDragStart={current=listOf(it)},onDragEnd={strokes=strokes+listOf(current);current=emptyList()},onDragCancel={current=emptyList()}){change,_->change.consume();current=current+change.position}}){
                size=this.size
                for(line in strokes+listOf(current))line.zipWithNext().forEach{(a,b)->drawLine(Color.Black,a,b,4f)}
            }
        }}
    }
}
