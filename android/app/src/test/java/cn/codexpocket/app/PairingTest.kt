package cn.codexpocket.app

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class PairingTest {
    private fun qr(url:String="https://100.70.1.2:43827")=JSONObject().put("v",1).put("name","电脑").put("url",url).put("fp","ab".repeat(32)).put("code","x".repeat(27)).toString()
    @Test fun acceptsOnlyThePrivateComputerEndpoint(){val p=Pairing.parse(qr());assertEquals("电脑",p.name);assertEquals("https://100.70.1.2:43827",p.url)}
    @Test fun rejectsPublicHttpCredentialsAndRedirectTargets(){
        val urls=listOf("http://100.70.1.2:43827","https://example.com:43827","https://100.128.1.2:43827","https://100.70.1.2:9222","https://evil@100.70.1.2:43827","https://100.70.1.2:43827/other","https://100.70.1.2:43827?redirect=evil","https://100.70.1.2:43827#other")
        urls.forEach{url->assertThrows(IllegalArgumentException::class.java){Pairing.parse(qr(url))}}
    }
    @Test fun rejectsInvalidFingerprintAndOldProtocol(){assertThrows(IllegalArgumentException::class.java){Pairing.parse(JSONObject(qr()).put("fp","abc").toString())};assertThrows(IllegalArgumentException::class.java){Pairing.parse(JSONObject(qr()).put("v",2).toString())}}
    @Test fun parsesStreamingSnapshotsWithoutLosingTextOrThreadIdentity(){val s=Snapshot.parse(JSONObject("""{"connected":true,"compatible":true,"threadId":"same-thread","title":"测试","messages":[{"id":"m1","role":"assistant","markdown":"```kotlin\nval n = 1\n```"}],"chats":[],"draftPresent":false,"busy":true,"approvals":[]}"""));assertEquals("same-thread",s.threadId);assertTrue(s.busy);assertTrue(s.messages.single().markdown.contains("val n = 1"))}
}
