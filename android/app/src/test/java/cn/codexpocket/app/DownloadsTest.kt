package cn.codexpocket.app

import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

class DownloadsTest {
    @Test fun fileCardsAreOptionalAndRetainTheComputerCapability(){
        val s=Snapshot.parse(JSONObject("""{"contextId":"one","messages":[{"id":"a","role":"assistant","markdown":"文件","files":[{"id":"opaque-id","name":"报告.pdf","size":1048576,"mime":"application/pdf","available":true}]},{"id":"b","role":"assistant","markdown":"旧版消息"}]}"""))
        assertEquals("opaque-id",s.messages[0].files.single().id);assertEquals(1048576L,s.messages[0].files.single().size);assertTrue(s.messages[1].files.isEmpty())
    }
    @Test fun downloadRejectsPartialOversizedAndGrowingFiles(){
        assertThrows(IOException::class.java){DownloadPolicy.copy(ByteArrayInputStream(byteArrayOf(1)),ByteArrayOutputStream(),2){}}
        assertThrows(IOException::class.java){DownloadPolicy.copy(ByteArrayInputStream(byteArrayOf(1,2)),ByteArrayOutputStream(),1){}}
        assertThrows(IOException::class.java){DownloadPolicy.copy(ByteArrayInputStream(byteArrayOf()),ByteArrayOutputStream(),DownloadPolicy.MAX+1){}}
        assertEquals(0L,DownloadPolicy.copy(ByteArrayInputStream(byteArrayOf()),ByteArrayOutputStream(),0){})
        val out=ByteArrayOutputStream();var progress=0L
        DownloadPolicy.copy(ByteArrayInputStream(byteArrayOf(0,-1,3)),out,3){progress=it}
        assertArrayEquals(byteArrayOf(0,-1,3),out.toByteArray());assertEquals(3L,progress)
    }
    @Test fun downloadNamesCannotEscapeThePrivateCache(){
        assertEquals("报告.docx",DownloadPolicy.safeName("C:\\secret\\报告.docx"));assertEquals("file.pdf",DownloadPolicy.safeName("../../file.pdf"));assertEquals("文件",DownloadPolicy.safeName(".."));assertFalse(DownloadPolicy.safeName("a\u0000b").contains('\u0000'))
        val longName=DownloadPolicy.safeName("长文件名".repeat(80)+".docx");assertTrue(longName.toByteArray(Charsets.UTF_8).size<=180);assertTrue(longName.endsWith(".docx"))
    }
}
