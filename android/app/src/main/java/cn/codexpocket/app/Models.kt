package cn.codexpocket.app

import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.security.cert.X509Certificate

data class Pairing(val name: String, val url: String, val fp: String, val code: String) {
    companion object {
        fun parse(raw: String): Pairing {
            val j = JSONObject(raw)
            require(j.getInt("v") == 1) { "配对码版本不支持，请更新 App。" }
            val uri = URI(j.getString("url"))
            val parts = uri.host?.split('.')?.mapNotNull { it.toIntOrNull() } ?: emptyList()
            require(uri.scheme == "https" && uri.port == 43827 && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/") && parts.size == 4 && parts[0] == 100 && parts[1] in 64..127 && parts.all { it in 0..255 }) { "配对地址必须是电脑的 Tailscale HTTPS 地址。" }
            val fp = j.getString("fp").lowercase()
            require(fp.matches(Regex("[0-9a-f]{64}"))) { "电脑证书指纹无效。" }
            val code = j.getString("code")
            require(code.length in 20..100) { "配对码无效。" }
            return Pairing(j.optString("name", "我的电脑").take(100), j.getString("url").trimEnd('/'), fp, code)
        }
    }
}

data class Session(val name: String, val url: String, val fp: String, val token: String) {
    fun toJson() = JSONObject().put("name",name).put("url",url).put("fp",fp).put("token",token)
    companion object { fun fromJson(j: JSONObject) = Session(j.getString("name"),j.getString("url"),j.getString("fp"),j.getString("token")) }
}
data class Chat(val id: String, val title: String, val active: Boolean, val projectId: String?=null)
data class Message(val id: String, val role: String, val markdown: String,val images:List<Picture> = emptyList())
data class Approval(val id: String, val summary: String, val acceptLabel: String, val declineLabel: String)
data class Project(val id:String,val title:String)
data class ComposerSetting(val key:String,val label:String,val value:String,val enabled:Boolean,val reason:String?)
data class SettingOption(val id:String,val label:String,val selected:Boolean,val disabled:Boolean)
data class SettingMenu(val key:String,val contextId:String,val revision:String,val options:List<SettingOption>)
data class Confirmation(val id:String,val summary:String,val acceptLabel:String,val declineLabel:String)
private fun JSONObject.nullable(key:String)=optString(key).takeUnless{it.isBlank()||it=="null"}
private fun <T> JSONObject.list(key:String,parse:(JSONObject)->T):List<T>{val a=optJSONArray(key)?:return emptyList();return (0 until a.length()).map{parse(a.getJSONObject(it))}}
data class Snapshot(val connected:Boolean=false,val compatible:Boolean=false,val error:String?=null,val threadId:String?=null,val title:String="连接你的电脑",val messages:List<Message> = emptyList(),val chats:List<Chat> = emptyList(),val draftPresent:Boolean=false,val busy:Boolean=false,val approvals:List<Approval> = emptyList(),val canLoadOlder:Boolean=false,
    val protocolVersion:Int=1,val contextId:String?=null,val screen:String="chat",val projects:List<Project> = emptyList(),val currentProjectId:String?=null,val settings:List<ComposerSetting> = emptyList(),val settingsRevision:String="",val menu:SettingMenu?=null,val confirmation:Confirmation?=null,val canCreate:Boolean=false,
    val surfaces:List<RemoteSurface> = emptyList(),val queue:List<QueueItem> = emptyList(),val attachments:List<RemoteAction> = emptyList(),val sendLabel:String="",val sendEnabled:Boolean=false,val composerPlaceholder:String="",val composerContext:String="",val composerContextEditable:Boolean=false,val composerRevision:String="") {
    companion object {
        fun parse(j:JSONObject):Snapshot {
            val menu=j.optJSONObject("menu")?.let{m->SettingMenu(m.getString("key"),m.getString("contextId"),m.getString("revision"),m.list("options"){o->SettingOption(o.getString("id"),o.getString("label"),o.optBoolean("selected"),o.optBoolean("disabled"))})}
            val confirmation=j.optJSONObject("confirmation")?.let{c->Confirmation(c.getString("id"),c.getString("summary"),c.getString("acceptLabel"),c.getString("declineLabel"))}
            return Snapshot(connected=j.optBoolean("connected"),compatible=j.optBoolean("compatible"),error=j.nullable("error"),threadId=j.nullable("threadId"),title=j.optString("title","Codex"),
                messages=j.list("messages"){m->Message(m.getString("id"),m.getString("role"),m.getString("markdown"),m.rows("images"){Picture.parse(it)})},
                chats=j.list("chats"){c->Chat(c.getString("id"),c.getString("title"),c.optBoolean("active"),c.nullable("projectId"))},
                draftPresent=j.optBoolean("draftPresent"),busy=j.optBoolean("busy"),approvals=j.list("approvals"){a->Approval(a.getString("id"),a.getString("summary"),a.getString("acceptLabel"),a.getString("declineLabel"))},canLoadOlder=j.optBoolean("canLoadOlder"),
                protocolVersion=j.optInt("protocolVersion",1),contextId=j.nullable("contextId")?:j.nullable("threadId"),screen=j.optString("screen","chat"),projects=j.list("projects"){p->Project(p.getString("id"),p.getString("title"))},currentProjectId=j.nullable("currentProjectId"),
                settings=j.list("settings"){v->ComposerSetting(v.getString("key"),v.getString("label"),v.optString("value"),v.optBoolean("enabled"),v.nullable("reason"))},settingsRevision=j.optString("settingsRevision"),menu=menu,confirmation=confirmation,canCreate=j.optJSONObject("capabilities")?.optBoolean("newChat")==true,
                surfaces=j.rows("surfaces"){RemoteSurface.parse(it)},queue=j.rows("queue"){QueueItem.parse(it)},attachments=j.rows("attachments"){RemoteAction.parse(it)},sendLabel=j.optString("sendLabel"),sendEnabled=j.optBoolean("sendEnabled"),composerPlaceholder=j.optString("composerPlaceholder"),composerContext=j.optString("composerContext"),composerContextEditable=j.optBoolean("composerContextEditable"),composerRevision=j.optString("composerRevision"))
        }
    }
}

object CertificatePin {
    fun verify(cert: X509Certificate, expected: String) {
        cert.checkValidity()
        val actual=MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        val pin=expected.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        require(MessageDigest.isEqual(actual,pin)) { "电脑证书与扫码时不一致，请重新配对。" }
    }
}
