package cn.codexpocket.app

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class UpgradeUiTest {
    @get:Rule val compose=createAndroidComposeRule<MainActivity>()
    private fun fixture(){
        val vm=PocketViewModel(compose.activity.application as Application)
        val snapshot=Snapshot(connected=true,compatible=true,threadId="one",contextId="one",title="手机界面升级",protocolVersion=2,canCreate=true,
            projects=listOf(Project("p1","我的项目")),chats=listOf(Chat("one","手机界面升级",true,"p1"),Chat("two","另一段聊天",false)),currentProjectId="p1",
            settings=listOf(ComposerSetting("permission","权限","请求批准",true,null),ComposerSetting("plan","模式","默认",true,null),ComposerSetting("model","模型","桌面模型",true,null),ComposerSetting("effort","思考强度","高",true,null)),
            messages=listOf(Message("u1","user","帮我检查这段代码"),Message("a1","assistant","已完成检查。\n\n```kotlin\nval message = \"你好，Codex\"\nprintln(message)\n```\n\n可以继续安排下一项任务。")))
        val sample=UiState(session=Session("我的电脑","https://100.70.1.2:43827","ab".repeat(32),"test-only"),socketConnected=true,snapshot=snapshot)
        compose.activity.runOnUiThread{compose.activity.setContent{MaterialTheme(colorScheme=lightColorScheme()){PocketApp(sample,vm)}}}
        compose.waitForIdle()
    }
    private fun capture(name:String){
        compose.waitForIdle()
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val image=instrumentation.uiAutomation.takeScreenshot()
        val dir=File(compose.activity.getExternalFilesDir(null),"ui-check").apply{mkdirs()}
        File(dir,"$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}
        image.recycle()
    }
    @Test fun upgradedScreensAndControlsAreUsable(){
        fixture()
        compose.onNodeWithText("帮我检查这段代码").assertIsDisplayed()
        compose.onNodeWithText("复制").assertIsDisplayed().performClick()
        compose.onNodeWithText("请求批准").assertIsDisplayed()
        capture("chat-light")
        compose.onNodeWithContentDescription("聊天列表").performClick()
        compose.onNodeWithText("搜索已同步聊天").assertIsDisplayed()
        compose.onNodeWithText("我的项目").assertIsDisplayed()
        capture("sidebar")
        compose.onNodeWithText("新建聊天").performClick()
        compose.onNodeWithText("从哪里开始？").assertIsDisplayed()
        compose.onNodeWithText("普通本地聊天").assertIsDisplayed()
        compose.onNodeWithText("在电脑打开新聊天").assertIsDisplayed()
        capture("new-chat")
        compose.onNodeWithContentDescription("返回聊天").performClick()
        compose.onNodeWithContentDescription("聊天列表").performClick()
        compose.onNodeWithText("连接与外观").performClick()
        compose.onNodeWithText("跟随系统").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("深色").performScrollTo().assertIsDisplayed()
        capture("settings")
    }
    @Test fun questionsAndQueuedMessageControlsAreVisible(){
        var submitted:Map<String,String>?=null
        val vm=PocketViewModel(compose.activity.application as Application)
        val q=RemoteSurface("q","r","question","选择网络",listOf(RemoteAction("a","移动数据和 Wi-Fi 都用"),RemoteAction("submit","提交")),listOf(RemoteField("custom","自行回答","","textarea")))
        val queued=QueueItem("row","revision","这是一条待处理消息",listOf(RemoteAction("steer","引导"),RemoteAction("delete","删除排队消息"),RemoteAction("more","更多操作")),emptyList())
        compose.activity.runOnUiThread{compose.activity.setContent{MaterialTheme{Column{RemoteForm(q,true){_,f->submitted=f};QueueCard(queued,UiState(),vm)}}}}
        compose.onNodeWithText("移动数据和 Wi-Fi 都用").assertIsDisplayed()
        compose.onNodeWithText("自行回答").performTextInput("自定义答案")
        compose.onNodeWithText("提交").performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals("自定义答案",submitted?.get("custom"))}
        compose.onNodeWithText("这是一条待处理消息").assertIsDisplayed()
        compose.onNodeWithText("引导").assertIsDisplayed()
        compose.onNodeWithContentDescription("删除待处理消息").assertExists()
        capture("questions-queue")
    }
}
