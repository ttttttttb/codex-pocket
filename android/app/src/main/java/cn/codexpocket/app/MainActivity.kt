package cn.codexpocket.app

import android.os.Bundle
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import io.noties.markwon.Markwon
import kotlinx.coroutines.launch

private val DarkScheme=darkColorScheme(primary=Color(0xFFB7F3CF),onPrimary=Color(0xFF102A1D),background=Color(0xFF101214),surface=Color(0xFF191C1F),surfaceVariant=Color(0xFF25292D),onSurface=Color(0xFFE8EAED),onBackground=Color(0xFFE8EAED),onSurfaceVariant=Color(0xFFA5ADB5))
private val LightScheme=lightColorScheme(primary=Color(0xFF216C49),onPrimary=Color.White,background=Color(0xFFFAFAF9),surface=Color.White,surfaceVariant=Color(0xFFEEF0ED),onSurface=Color(0xFF202421),onBackground=Color(0xFF202421),onSurfaceVariant=Color(0xFF646C66))

class MainActivity:ComponentActivity(){
    override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);enableEdgeToEdge();setContent{
        val vm:PocketViewModel=viewModel();val s by vm.state.collectAsStateWithLifecycle()
        val dark=when(s.theme){"dark"->true;"light"->false;else->isSystemInDarkTheme()}
        MaterialTheme(colorScheme=if(dark)DarkScheme else LightScheme){PocketApp(s,vm)}
                         }}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun PocketApp(s:UiState,vm:PocketViewModel){
    DownloadedFileLauncher(s,vm)
    var page by rememberSaveable{mutableStateOf("chat")}
    var search by rememberSaveable{mutableStateOf("")}
    var manual by remember{mutableStateOf(false)};var raw by remember{mutableStateOf("")}
    var scanned by remember{mutableStateOf<String?>(null)};var forget by remember{mutableStateOf(false)}
    var approval by remember{mutableStateOf<Pair<Approval,Boolean>?>(null)}
    var settingKey by remember{mutableStateOf<String?>(null)}
    var createPending by remember{mutableStateOf(false)}
    val drawer=rememberDrawerState(DrawerValue.Closed);val scope=rememberCoroutineScope()
    val scanner=rememberLauncherForActivityResult(ScanContract()){r->r.contents?.let{scanned=it}}
    val c=MaterialTheme.colorScheme
    val ready=s.socketConnected&&s.snapshot.compatible&&s.pendingId==null
    LaunchedEffect(s.pendingId,s.snapshot.contextId){if(createPending&&s.pendingId==null){createPending=false;if(s.snapshot.screen=="new")page="chat"}}
    if(manual)AlertDialog(onDismissRequest={manual=false},title={Text("粘贴配对内容")},text={OutlinedTextField(value=raw,onValueChange={raw=it},label={Text("电脑上的配对内容")},minLines=4,maxLines=8)},confirmButton={TextButton(onClick={scanned=raw;manual=false;raw=""}){Text("下一步")}},dismissButton={TextButton(onClick={manual=false}){Text("取消")}})
    scanned?.let{data->val pairing=remember(data){runCatching{Pairing.parse(data)}}
        AlertDialog(onDismissRequest={scanned=null},title={Text(if(pairing.isSuccess)"连接这台电脑？" else "无法识别配对内容")},text={Text(pairing.getOrNull()?.let{"${it.name}\n请确认这是你电脑上显示的二维码。"}?:pairing.exceptionOrNull()?.message?:"请重新扫码。")},confirmButton={TextButton(onClick={scanned=null;if(pairing.isSuccess)vm.pair(data)}){Text(if(pairing.isSuccess)"确认连接" else "知道了")}},dismissButton={TextButton(onClick={scanned=null}){Text("取消")}})
    }
    if(forget)AlertDialog(onDismissRequest={forget=false},title={Text("移除这台电脑？")},text={Text("本机将删除连接凭据与草稿。重新配对前，请在电脑撤销旧手机授权。")},confirmButton={TextButton(onClick={vm.forget();forget=false;page="chat"}){Text("移除")}},dismissButton={TextButton(onClick={forget=false}){Text("取消")}})
    approval?.let{(a,accept)->AlertDialog(onDismissRequest={approval=null},title={Text(if(accept)"批准这次操作？" else "拒绝这次操作？")},text={Column(Modifier.heightIn(max=400.dp).verticalScroll(rememberScrollState())){Text(a.summary)}},confirmButton={TextButton(onClick={vm.approve(a,accept);approval=null},enabled=ready){Text(if(accept)"批准" else "拒绝")}},dismissButton={TextButton(onClick={approval=null}){Text("取消")}})}
    settingKey?.let{key->
        val menu=s.snapshot.menu?.takeIf{it.key==key&&it.contextId==s.snapshot.contextId&&it.revision==s.snapshot.settingsRevision}
        ModalBottomSheet(onDismissRequest={settingKey=null},containerColor=c.surface){
            Column(Modifier.fillMaxWidth().padding(horizontal=24.dp).padding(bottom=24.dp)){
                Text(s.snapshot.settings.find{it.key==key}?.label?:"输入设置",style=MaterialTheme.typography.titleLarge)
                Text("与电脑当前聊天同步",color=c.onSurfaceVariant,modifier=Modifier.padding(vertical=8.dp),fontSize=13.sp)
                if(menu==null){s.notice?.let{Text(it,color=c.error)};TextButton(onClick={vm.options(key)},enabled=ready){Text(if(s.pendingId!=null)"正在读取桌面选项…" else "重新读取桌面选项")}}
                else LazyColumn(Modifier.heightIn(max=420.dp)){items(menu.options,key={it.id}){o->
                    ListItem(headlineContent={Text(o.label)},leadingContent={RadioButton(selected=o.selected,onClick=null,enabled=!o.disabled)},modifier=Modifier.clickable(enabled=ready&&!o.disabled){vm.setting(key,o.id);settingKey=null},supportingContent=if(o.disabled){{Text("桌面当前不可用")}}else null)
                }}
                Text("设置以桌面确认结果为准",color=c.onSurfaceVariant,fontSize=12.sp,modifier=Modifier.padding(top=12.dp))
            }
        }
    }
    if(s.session!=null)RemotePanels(s,vm,allowMenus=settingKey==null)
    ModalNavigationDrawer(drawerState=drawer,gesturesEnabled=s.session!=null,drawerContent={
        ModalDrawerSheet(drawerContainerColor=c.surface){
            Row(Modifier.fillMaxWidth().padding(20.dp),verticalAlignment=Alignment.CenterVertically){Icon(Icons.Rounded.Terminal,null,tint=c.primary);Spacer(Modifier.width(10.dp));Text("Codex Pocket",style=MaterialTheme.typography.titleLarge)}
            FilledTonalButton(onClick={scope.launch{drawer.close()};page="new"},enabled=ready&&s.snapshot.canCreate,modifier=Modifier.fillMaxWidth().padding(horizontal=16.dp)){Icon(Icons.Rounded.Add,null);Spacer(Modifier.width(8.dp));Text("新建聊天")}
            OutlinedTextField(value=search,onValueChange={search=it},placeholder={Text("搜索已同步聊天")},leadingIcon={Icon(Icons.Rounded.Search,null)},singleLine=true,modifier=Modifier.fillMaxWidth().padding(16.dp),shape=RoundedCornerShape(14.dp))
            Text("仅搜索电脑侧栏已同步的聊天",fontSize=11.sp,color=c.onSurfaceVariant,modifier=Modifier.padding(horizontal=24.dp))
            LazyColumn(Modifier.weight(1f).padding(top=12.dp)){
                val filtered=s.snapshot.chats.filter{it.title.contains(search,true)}
                val groups=s.snapshot.projects.filter{p->filtered.any{it.projectId==p.id}}
                groups.forEach{p->item(key="project-${p.id}"){SectionLabel(p.title)};items(filtered.filter{it.projectId==p.id},key={it.id}){chat->ChatRow(chat,ready){scope.launch{drawer.close()};page="chat";vm.select(chat.id)}}}
                val recent=filtered.filter{it.projectId==null||s.snapshot.projects.none{p->p.id==it.projectId}}
                if(recent.isNotEmpty())item(key="recent"){SectionLabel("最近聊天")}
                items(recent,key={it.id}){chat->ChatRow(chat,ready){scope.launch{drawer.close()};page="chat";vm.select(chat.id)}}
                if(filtered.isEmpty())item{Text("没有匹配的聊天",Modifier.padding(24.dp),color=c.onSurfaceVariant)}
            }
            HorizontalDivider();TextButton(onClick={scope.launch{drawer.close()};page="settings"},modifier=Modifier.padding(16.dp)){Icon(Icons.Rounded.Settings,null);Spacer(Modifier.width(8.dp));Text("连接与外观")}
        }
    }){
        Scaffold(containerColor=c.background,topBar={if(s.session!=null)Column(Modifier.statusBarsPadding()){
            Row(Modifier.fillMaxWidth().height(62.dp).padding(horizontal=8.dp),verticalAlignment=Alignment.CenterVertically){
                IconButton(onClick={if(page!="chat")page="chat" else scope.launch{drawer.open()}}){Icon(if(page=="chat")Icons.Rounded.Menu else Icons.AutoMirrored.Rounded.ArrowBack,if(page=="chat")"聊天列表" else "返回聊天")}
                Column(Modifier.weight(1f)){
                    Text(when(page){"new"->"新建聊天";"settings"->"连接与外观";else->if(s.snapshot.screen=="new")"新聊天" else s.snapshot.title},maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.titleMedium)
                    Row(verticalAlignment=Alignment.CenterVertically){Box(Modifier.size(6.dp).background(if(s.socketConnected&&s.snapshot.connected)c.primary else c.error,CircleShape));Spacer(Modifier.width(6.dp));Text(if(s.socketConnected&&s.snapshot.connected)"${s.session.name} · 实时同步" else if(s.connecting)"正在连接电脑…" else "连接已断开",fontSize=11.sp,color=c.onSurfaceVariant,maxLines=1)}
                }
                if(page=="chat")IconButton(onClick={page="new"},enabled=ready&&s.snapshot.canCreate){Icon(Icons.Rounded.Edit,"新建聊天")}
                if(page=="chat")IconButton(onClick={vm.openMenu("chat")},enabled=ready){Icon(Icons.Rounded.MoreHoriz,"聊天操作")}else IconButton(onClick={page="settings"}){Icon(Icons.Rounded.Tune,"连接与外观")}
            };HorizontalDivider(color=c.outlineVariant)
        }},bottomBar={if(s.session!=null&&page=="chat")Composer(s,vm){settingKey=it;vm.options(it)}}){padding->
            val modifier=Modifier.padding(padding)
            if(s.session==null)Onboarding(modifier,s,onScan={scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描电脑配对二维码").setBeepEnabled(false).setOrientationLocked(true))},onManual={manual=true})
            else when(page){
                "new"->NewChatPage(modifier,s,ready){projectId->createPending=true;vm.create(projectId)}
                "settings"->SettingsPage(modifier,s,vm){forget=true}
                else->ChatContent(modifier,s,vm){a,b->approval=a to b}
            }
        }
    }
}

@Composable private fun SectionLabel(text:String){Text(text,Modifier.padding(24.dp,12.dp),fontSize=12.sp,fontWeight=FontWeight.SemiBold,color=MaterialTheme.colorScheme.onSurfaceVariant)}
@Composable private fun ChatRow(chat:Chat,enabled:Boolean,onClick:()->Unit){NavigationDrawerItem(label={Text(chat.title,maxLines=2,overflow=TextOverflow.Ellipsis)},selected=chat.active,onClick={if(enabled)onClick()},modifier=Modifier.padding(horizontal=12.dp,vertical=2.dp),icon={Icon(if(chat.active)Icons.Rounded.ChatBubble else Icons.Rounded.ChatBubbleOutline,null,modifier=Modifier.size(18.dp))})}

@Composable private fun Onboarding(modifier:Modifier,s:UiState,onScan:()->Unit,onManual:()->Unit){
    val c=MaterialTheme.colorScheme
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),verticalArrangement=Arrangement.Center){
        Icon(Icons.Rounded.Terminal,null,tint=c.primary,modifier=Modifier.size(52.dp));Spacer(Modifier.height(24.dp));Text("Codex Pocket",color=c.primary,fontWeight=FontWeight.Medium)
        Text("继续电脑上的\n每一段思考。",fontSize=34.sp,lineHeight=44.sp,fontWeight=FontWeight.Bold,modifier=Modifier.padding(vertical=16.dp))
        Text("聊天、模式和工作进度，随身同步。",color=c.onSurfaceVariant)
        Spacer(Modifier.height(28.dp));Surface(shape=RoundedCornerShape(20.dp),color=c.surfaceVariant){Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(16.dp)){Text("1  电脑通过 Codex Pocket 启动");Text("2  手机与电脑开启 Tailscale");Text("3  扫码连接，继续同一聊天")}}
        Spacer(Modifier.height(28.dp));Button(onClick=onScan,enabled=!s.pairing,modifier=Modifier.fillMaxWidth().height(52.dp)){Icon(Icons.Rounded.QrCodeScanner,null);Spacer(Modifier.width(8.dp));Text(if(s.pairing)"正在连接…" else "扫描电脑二维码")}
        TextButton(onClick=onManual,enabled=!s.pairing,modifier=Modifier.align(Alignment.CenterHorizontally)){Text("无法扫码？粘贴配对内容")}
        s.notice?.let{Text(it,color=c.error,fontSize=13.sp)}
        Text("个人远程工具 · 0.4.0",color=c.onSurfaceVariant,fontSize=11.sp,modifier=Modifier.padding(top=24.dp))
    }
}

@Composable private fun NewChatPage(modifier:Modifier,s:UiState,ready:Boolean,onCreate:(String?)->Unit){
    var project by remember(s.snapshot.currentProjectId){mutableStateOf(s.snapshot.currentProjectId)}
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)){
        Icon(Icons.Rounded.Edit,null,tint=MaterialTheme.colorScheme.primary,modifier=Modifier.size(40.dp));Text("从哪里开始？",style=MaterialTheme.typography.headlineMedium,modifier=Modifier.padding(top=20.dp,bottom=8.dp));Text("选择项目后，会在电脑上打开同一新聊天。",color=MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(20.dp))
        ListItem(headlineContent={Text("普通本地聊天")},supportingContent={Text("使用桌面新聊天的默认工作位置")},leadingContent={RadioButton(project==null,{project=null})},modifier=Modifier.clickable{project=null})
        s.snapshot.projects.forEach{p->ListItem(headlineContent={Text(p.title)},leadingContent={RadioButton(project==p.id,{project=p.id})},modifier=Modifier.clickable{project=p.id})}
        Spacer(Modifier.height(24.dp));s.notice?.let{Notice(it)}
        if(s.snapshot.draftPresent)Notice("电脑有未发送草稿，请先处理。",true)
        Button(onClick={onCreate(project)},enabled=ready&&s.snapshot.canCreate&&!s.snapshot.draftPresent,modifier=Modifier.fillMaxWidth().height(52.dp)){Icon(Icons.Rounded.Add,null);Spacer(Modifier.width(8.dp));Text(if(s.pendingId!=null)"正在打开…" else "在电脑打开新聊天")}
        Text("这里只创建输入页，不会自动发送消息。",color=MaterialTheme.colorScheme.onSurfaceVariant,fontSize=12.sp,modifier=Modifier.padding(top=12.dp))
    }
}

@Composable private fun SettingsPage(modifier:Modifier,s:UiState,vm:PocketViewModel,onForget:()->Unit){
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)){
        SectionLabel("连接的电脑")
        ListItem(headlineContent={Text(s.session?.name?:"")},supportingContent={Text(if(s.socketConnected)"连接程序在线" else "连接已断开")},leadingContent={Icon(Icons.Rounded.Computer,null)})
        ListItem(headlineContent={Text("桌面 Codex")},supportingContent={Text(if(s.snapshot.compatible)"兼容 · 正在同步" else s.snapshot.error?:"等待连接")})
        OutlinedButton(onClick={vm.connect()},modifier=Modifier.fillMaxWidth().padding(vertical=12.dp)){Icon(Icons.Rounded.Refresh,null);Spacer(Modifier.width(8.dp));Text("重新连接")}
        SectionLabel("外观")
        listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach{(value,label)->ListItem(headlineContent={Text(label)},leadingContent={RadioButton(s.theme==value,{vm.theme(value)})},modifier=Modifier.clickable{vm.theme(value)})}
        Spacer(Modifier.height(24.dp));HorizontalDivider();TextButton(onClick=onForget,modifier=Modifier.padding(top=16.dp)){Icon(Icons.Rounded.LinkOff,null);Spacer(Modifier.width(8.dp));Text("解除这台电脑的配对")}
        Text("Codex Pocket 0.4.0\n手机与桌面共用同一聊天和操作状态。",fontSize=12.sp,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(top=24.dp))
    }
}

@Composable private fun ChatContent(modifier:Modifier,s:UiState,vm:PocketViewModel,onApprove:(Approval,Boolean)->Unit){
    val list=rememberLazyListState();val scope=rememberCoroutineScope()
    var following by remember{mutableStateOf(true)}
    var remoteConfirm by remember{mutableStateOf<Pair<RemoteSurface,RemoteAction>?>(null)}
    remoteConfirm?.let{(surface,action)->AlertDialog(onDismissRequest={remoteConfirm=null},title={Text("确认"+action.label+"？")},text={Text(surface.title)},confirmButton={TextButton(onClick={vm.remote(surface,action);remoteConfirm=null}){Text("确认")}},dismissButton={TextButton(onClick={remoteConfirm=null}){Text("取消")}})}
    LaunchedEffect(list){snapshotFlow{list.isScrollInProgress to list.canScrollForward}.collect{(scrolling,canForward)->if(scrolling)following=!canForward}}
    LaunchedEffect(s.snapshot.contextId){following=true}
    LaunchedEffect(s.snapshot.contextId,s.snapshot.messages.size,s.snapshot.messages.lastOrNull()?.markdown){if(following&&s.snapshot.messages.isNotEmpty())list.scrollToItem((s.snapshot.messages.size).coerceAtMost((list.layoutInfo.totalItemsCount-1).coerceAtLeast(0)))}
    val ready=s.socketConnected&&s.snapshot.compatible&&s.pendingId==null
    Column(modifier.fillMaxSize()){
        if(!s.snapshot.compatible)Notice(s.snapshot.error?:"等待桌面连接，请通过配套启动器打开 Codex。",true)
        if(s.snapshot.protocolVersion<2&&s.snapshot.connected)Notice("请更新电脑端以使用新建聊天和模式同步。",true)
        s.notice?.let{Notice(it,onDismiss=if(s.pendingUnknown)null else {{vm.notice(null)}})}
        if(s.pendingUnknown)Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(16.dp)){Text("操作结果待确认",fontWeight=FontWeight.Bold);Text("请检查聊天。此操作不会自动重发。",fontSize=13.sp);TextButton(onClick={vm.acknowledgePending()}){Text("我已检查聊天")}}
        Box(Modifier.weight(1f).fillMaxWidth()){
            if(s.snapshot.messages.isEmpty())Column(Modifier.align(Alignment.Center).padding(24.dp),horizontalAlignment=Alignment.CenterHorizontally){Icon(Icons.Rounded.Terminal,null,tint=MaterialTheme.colorScheme.primary,modifier=Modifier.size(44.dp));Spacer(Modifier.height(20.dp));Text(if(s.snapshot.compatible)"有什么需要一起完成？" else "等待电脑上的聊天",style=MaterialTheme.typography.titleLarge);Text("使用下方工具栏选择模式与模型",color=MaterialTheme.colorScheme.onSurfaceVariant,fontSize=13.sp,modifier=Modifier.padding(top=12.dp))}
            LazyColumn(state=list,modifier=Modifier.fillMaxSize(),contentPadding=PaddingValues(20.dp,20.dp),verticalArrangement=Arrangement.spacedBy(24.dp)){
                if(s.snapshot.canLoadOlder)item(key="history"){TextButton(onClick={following=false;vm.history()},enabled=ready){Icon(Icons.Rounded.ExpandLess,null);Text("加载更早的消息")}}
                items(s.snapshot.messages,key={it.id}){MessageCard(it,vm)}
                items(s.snapshot.surfaces.filter{it.kind=="question"||it.kind=="goal"},key={"question-"+it.id}){q->OutlinedCard{Column(Modifier.padding(16.dp)){RemoteForm(q,ready){a,f->if(a.confirm)remoteConfirm=q to a else vm.remote(q,a,f)}}}}
                if(s.snapshot.busy)item(key="busy"){Row(verticalAlignment=Alignment.CenterVertically){CircularProgressIndicator(Modifier.size(14.dp),strokeWidth=1.5.dp);Spacer(Modifier.width(10.dp));Text("Codex 正在工作…",fontSize=12.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)}}
                items(s.snapshot.approvals,key={"approval-${it.id}"}){a->RequestCard("需要确认",a.summary,a.acceptLabel,a.declineLabel,ready,{onApprove(a,true)},{onApprove(a,false)})}
                s.snapshot.confirmation?.let{c->item(key="confirmation-${c.id}"){RequestCard("权限确认",c.summary,c.acceptLabel,c.declineLabel,ready,{vm.confirm(c,true)},{vm.confirm(c,false)})}}
            }
            if(!following&&s.snapshot.messages.isNotEmpty())SmallFloatingActionButton(onClick={following=true;scope.launch{list.animateScrollToItem((list.layoutInfo.totalItemsCount-1).coerceAtLeast(0))}},modifier=Modifier.align(Alignment.BottomEnd).padding(16.dp)){Icon(Icons.Rounded.ArrowDownward,"回到底部")}
        }
    }
}

@Composable private fun RequestCard(title:String,text:String,accept:String,decline:String,enabled:Boolean,onAccept:()->Unit,onDecline:()->Unit){OutlinedCard{Column(Modifier.padding(16.dp)){Text(title,fontWeight=FontWeight.Bold);Text(text,fontSize=13.sp,modifier=Modifier.padding(vertical=12.dp));Row{OutlinedButton(onClick=onDecline,enabled=enabled){Text(decline)};Spacer(Modifier.width(12.dp));Button(onClick=onAccept,enabled=enabled){Text(accept)}}}}}
@Composable private fun Notice(text:String,warning:Boolean=false,onDismiss:(()->Unit)?=null){val c=MaterialTheme.colorScheme;Surface(color=if(warning)c.errorContainer else c.surfaceVariant){Row(Modifier.fillMaxWidth().padding(14.dp,10.dp),verticalAlignment=Alignment.CenterVertically){Text(text,fontSize=12.sp,lineHeight=18.sp,color=if(warning)c.onErrorContainer else c.onSurfaceVariant,modifier=Modifier.weight(1f));onDismiss?.let{IconButton(onClick=it,modifier=Modifier.size(28.dp)){Icon(Icons.Rounded.Close,"关闭提示",Modifier.size(16.dp))}}}}}
@Composable private fun MessageCard(m:Message,vm:PocketViewModel){val user=m.role=="user";val c=MaterialTheme.colorScheme;Column(Modifier.fillMaxWidth(),horizontalAlignment=if(user)Alignment.End else Alignment.Start){if(!user)Text(if(m.role=="activity")"执行详情" else "Codex",fontSize=12.sp,fontWeight=FontWeight.SemiBold,color=c.primary,modifier=Modifier.padding(bottom=8.dp));if(m.markdown.isNotBlank())if(user)Surface(shape=RoundedCornerShape(18.dp),color=c.surfaceVariant){Text(m.markdown,Modifier.padding(16.dp,12.dp),fontSize=15.sp,lineHeight=23.sp)}else Markdown(m.markdown);m.images.forEach{RemotePicture(it,vm)};m.files.forEach{GeneratedFileCard(it,vm)}}}
@Composable private fun Markdown(text:String){
    val context=LocalContext.current;val markwon=remember(context){Markwon.create(context)};val clipboard=LocalClipboardManager.current;val c=MaterialTheme.colorScheme
    val chunks=remember(text){Regex("(?s)```([^\\n`]*)\\n(.*?)(?:```|$)").findAll(text).toList()}
    Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(10.dp)){
        var offset=0
        chunks.forEach{match->
            val before=text.substring(offset,match.range.first);if(before.isNotBlank())MarkdownText(before,markwon,c.onSurface,c.primary)
            val code=match.groupValues[2].trimEnd();Surface(color=c.surfaceVariant,shape=RoundedCornerShape(12.dp)){Column(Modifier.fillMaxWidth()){
                Row(Modifier.fillMaxWidth().padding(start=14.dp),verticalAlignment=Alignment.CenterVertically){Text(match.groupValues[1].ifBlank{"代码"},fontSize=12.sp,color=c.onSurfaceVariant,modifier=Modifier.weight(1f));TextButton(onClick={clipboard.setText(AnnotatedString(code))}){Icon(Icons.Rounded.ContentCopy,null,Modifier.size(14.dp));Spacer(Modifier.width(6.dp));Text("复制",fontSize=12.sp)}}
                SelectionContainerCompat(code)
            }};offset=match.range.last+1
        }
        val tail=text.substring(offset);if(tail.isNotBlank())MarkdownText(tail,markwon,c.onSurface,c.primary)
    }
}
@Composable private fun SelectionContainerCompat(text:String){androidx.compose.foundation.text.selection.SelectionContainer{Text(text,fontFamily=FontFamily.Monospace,fontSize=13.sp,lineHeight=20.sp,modifier=Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(14.dp))}}
@Composable private fun MarkdownText(text:String,markwon:Markwon,color:Color,link:Color){AndroidView(factory={TextView(it).apply{textSize=15f;setLineSpacing(5f,1f);setTextIsSelectable(true)}},update={it.setTextColor(color.toArgb());it.setLinkTextColor(link.toArgb());markwon.setMarkdown(it,text)},modifier=Modifier.fillMaxWidth())}

@Composable private fun Composer(s:UiState,vm:PocketViewModel,onSetting:(String)->Unit){
    val c=MaterialTheme.colorScheme;val ready=s.socketConnected&&s.snapshot.compatible&&s.pendingId==null&&!s.uploading
    var stopConfirm by remember{mutableStateOf(false)}
    var goalConfirm by remember{mutableStateOf(false)}
    val goalMode=s.snapshot.surfaces.any{it.kind=="composer"&&it.actions.any{a->a.label=="目标"}}
    if(goalConfirm)AlertDialog(onDismissRequest={goalConfirm=false},title={Text("将这条消息设为目标？")},text={Text(s.draft,maxLines=8,overflow=TextOverflow.Ellipsis)},confirmButton={TextButton(onClick={vm.send();goalConfirm=false},enabled=ready&&goalMode){Text("设为目标")}},dismissButton={TextButton(onClick={goalConfirm=false}){Text("取消")}})
    if(stopConfirm)AlertDialog(onDismissRequest={stopConfirm=false},title={Text("停止当前任务？")},text={Text("这会停止电脑上正在执行的任务。")},confirmButton={TextButton(onClick={vm.stop();stopConfirm=false},enabled=ready){Text("停止任务")}},dismissButton={TextButton(onClick={stopConfirm=false}){Text("继续执行")}})
    Column(Modifier.background(c.background).navigationBarsPadding().imePadding().padding(12.dp)){
        if(s.snapshot.draftPresent)Text("电脑有未发送草稿，请先处理。",color=c.error,fontSize=12.sp,modifier=Modifier.padding(6.dp,4.dp))
        Column(Modifier.heightIn(max=220.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(6.dp)){s.snapshot.queue.forEach{QueueCard(it,s,vm)}}
        Surface(shape=RoundedCornerShape(24.dp),color=c.surface,border=BorderStroke(1.dp,c.outlineVariant)){
            Column(Modifier.padding(8.dp)){
                Attachments(s,vm)
                s.snapshot.surfaces.filter{it.kind=="composer"}.forEach{m->Row{m.actions.forEach{a->InputChip(selected=true,onClick={vm.remote(m,a)},label={Text(a.label)},enabled=ready,trailingIcon={Icon(Icons.Rounded.Close,"退出此模式",Modifier.size(14.dp))})}}}
                if(s.snapshot.composerContext.isNotBlank())Row(verticalAlignment=Alignment.CenterVertically){Text("已选上下文："+s.snapshot.composerContext,Modifier.weight(1f),maxLines=2,overflow=TextOverflow.Ellipsis);IconButton(onClick={vm.clearContext()},enabled=ready){Icon(Icons.Rounded.Close,"移除所选上下文")}}
                if(s.snapshot.composerContextEditable)TextButton(onClick={vm.editQueuedDraft()},enabled=ready){Text("移到手机输入框编辑")}
                TextField(value=s.draft,onValueChange={vm.draft(it)},modifier=Modifier.fillMaxWidth(),enabled=s.pendingId==null,placeholder={Text(s.snapshot.composerPlaceholder.ifBlank{if(s.snapshot.busy)"发送后同步桌面待处理消息…" else "询问或安排一项任务…"},fontSize=15.sp)},maxLines=5,colors=TextFieldDefaults.colors(focusedContainerColor=Color.Transparent,unfocusedContainerColor=Color.Transparent,disabledContainerColor=Color.Transparent,focusedIndicatorColor=Color.Transparent,unfocusedIndicatorColor=Color.Transparent,disabledIndicatorColor=Color.Transparent))
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
                    Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(4.dp)){
                        IconButton(onClick={vm.openMenu("plus")},enabled=ready){Icon(Icons.Rounded.Add,"添加文件等内容")}
                        s.snapshot.settings.filter{it.key!="plan"}.forEach{setting->TextButton(onClick={if(setting.enabled)onSetting(setting.key)else vm.notice("${setting.label}：${setting.reason?:"桌面当前不可用"}")},enabled=ready,contentPadding=PaddingValues(horizontal=9.dp,vertical=4.dp)){
                            if(setting.key=="permission")Icon(Icons.Rounded.Shield,null,Modifier.size(14.dp))
                            if(setting.key=="plan")Icon(Icons.Rounded.Checklist,null,Modifier.size(14.dp))
                            if(setting.key=="permission"||setting.key=="plan")Spacer(Modifier.width(4.dp))
                            Text(setting.value.ifBlank{setting.label},fontSize=12.sp,maxLines=1);Icon(Icons.Rounded.ExpandMore,null,Modifier.size(14.dp))
                        }}
                    }
                    Spacer(Modifier.width(6.dp))
                    FilledIconButton(onClick={if(s.snapshot.busy&&s.draft.isBlank()&&s.snapshot.attachments.isEmpty())stopConfirm=true else if(goalMode)goalConfirm=true else vm.send()},enabled=ready&&(s.snapshot.busy||s.draft.isNotBlank()||s.snapshot.attachments.isNotEmpty())&&s.staged.isEmpty()&&(!s.snapshot.draftPresent||s.snapshot.busy&&s.draft.isBlank()),modifier=Modifier.size(40.dp)){
                        if(s.pendingId!=null&&!s.pendingUnknown)CircularProgressIndicator(Modifier.size(16.dp),strokeWidth=2.dp)
                        else Icon(if(s.snapshot.busy&&s.draft.isBlank()&&s.snapshot.attachments.isEmpty())Icons.Rounded.Stop else Icons.AutoMirrored.Rounded.Send,if(s.snapshot.busy&&s.draft.isBlank()&&s.snapshot.attachments.isEmpty())"停止当前任务" else "发送指令",Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}
