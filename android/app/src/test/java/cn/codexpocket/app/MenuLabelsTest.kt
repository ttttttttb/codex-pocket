package cn.codexpocket.app
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class MenuLabelsTest {
 @Test fun fileMenusUsePhonePickerInBothDesktopLanguages(){
  listOf("文件和文件夹","文件和文件夹\n添加上下文","Files and folders","Files and folders\nAdd context","Add files").forEach{assertTrue(it,isFileSourceAction(it))}
  listOf("Plan mode","Draw","Open in new window","Files changed").forEach{assertFalse(it,isFileSourceAction(it))}
  assertTrue(isDrawingAction("Draw"));assertTrue(isDrawingAction("绘图"))
 }
 @Test fun directoryResponseKeepsCurrentFolderIdentityAndCapabilities(){
  val f=FileListing.parse(JSONObject("""{"name":"work","path":"D:\\work","id":"selected","entries":[]}"""));assertEquals("selected",f.id);assertEquals("D:\\work",f.path)
  val s=Snapshot.parse(JSONObject("""{"capabilities":{"newChat":true,"catalog":true,"folders":true}}"""));assertTrue(s.canCreate);assertTrue(s.canLoadCatalog);assertTrue(s.canBrowseFolders)
 }
}
