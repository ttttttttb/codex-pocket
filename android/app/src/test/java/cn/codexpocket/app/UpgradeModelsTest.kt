package cn.codexpocket.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UpgradeModelsTest {
    @Test fun menuClosesLocallyWhileOfflineOrWaitingWithoutClearingAnUncertainSend(){
        val menu=RemoteSurface("plus","r","menu","添加内容",emptyList(),emptyList())
        for(connected in listOf(true,false)){
            val s=UiState(socketConnected=connected,pendingId="uncertain-send",pendingUnknown=true,draft="手机草稿",snapshot=Snapshot(contextId="one",surfaces=listOf(menu)))
            assertNotNull(s.remoteMenu)
            val hidden=s.hideMenu()
            assertNull(hidden.remoteMenu);assertEquals("uncertain-send",hidden.pendingId);assertTrue(hidden.pendingUnknown);assertEquals("手机草稿",hidden.draft)
            assertNull(hidden.copy(snapshot=hidden.snapshot.copy(surfaces=listOf(menu.copy(id="remounted-plus")))).remoteMenu)
            assertNotNull(hidden.copy(hiddenMenuId=null).remoteMenu)
        }
    }
    @Test fun remoteQuestionsMenusQueuesAndPicturesRetainDesktopIdentity(){
        val s=Snapshot.parse(JSONObject("""{"protocolVersion":3,"contextId":"one","composerContext":"$ skill","composerPlaceholder":"目标","surfaces":[{"id":"q","revision":"rev","kind":"question","title":"选择","actions":[{"id":"a","label":"选项","selected":true}],"fields":[{"id":"f","label":"时间","value":"daily","type":"select","options":[{"value":"daily","label":"每天"}]}]}],"queue":[{"id":"row1","revision":"r","text":"继续","actions":[],"images":[{"id":"im","alt":"绘图"}]},{"id":"row2","revision":"r","text":"继续","actions":[],"images":[]}],"messages":[{"id":"m","role":"user","markdown":"","images":[{"id":"im","alt":"绘图"}]}]}"""))
        assertEquals(3,s.protocolVersion);assertEquals(2,s.queue.size);assertNotEquals(s.queue[0].id,s.queue[1].id)
        assertEquals("每天",s.surfaces.single().fields.single().options.single().label)
        assertTrue(s.surfaces.single().actions.single().selected);assertEquals("im",s.messages.single().images.single().id)
        assertEquals("目标",s.composerPlaceholder);assertTrue(s.composerContext.isNotBlank())
    }
    @Test fun newChatWithoutThreadHasIndependentContextAndDesktopSettings(){
        val s=Snapshot.parse(JSONObject("""{"protocolVersion":2,"connected":true,"compatible":true,"threadId":null,"contextId":"new:one","screen":"new","settingsRevision":"r1","projects":[{"id":"p1","title":"项目"}],"settings":[{"key":"plan","label":"模式","value":"计划","enabled":true}],"capabilities":{"newChat":true}}"""))
        assertNull(s.threadId);assertEquals("new:one",s.contextId);assertEquals("new",s.screen);assertTrue(s.canCreate);assertEquals("计划",s.settings.single().value)
    }
    @Test fun identicalTextInDifferentMessagesIsPreserved(){
        val s=Snapshot.parse(JSONObject("""{"threadId":"one","messages":[{"id":"turn1:user:0","role":"user","markdown":"继续"},{"id":"turn2:user:0","role":"user","markdown":"继续"}]}"""))
        assertEquals(2,s.messages.size);assertEquals("one",s.contextId);assertEquals(1,s.protocolVersion)
    }
    @Test fun menuAndPermissionConfirmationRemainBoundToDesktopContext(){
        val s=Snapshot.parse(JSONObject("""{"contextId":"one","settingsRevision":"r","menu":{"key":"permission","contextId":"one","revision":"r","options":[{"id":"opt","label":"请求批准","selected":true,"disabled":false}]},"confirmation":{"id":"confirm","summary":"完全访问？","acceptLabel":"允许","declineLabel":"取消"}}"""))
        assertEquals("one",s.menu!!.contextId);assertTrue(s.menu.options.single().selected);assertEquals("confirm",s.confirmation!!.id)
    }
}
