package cn.codexpocket.app

import org.json.JSONObject

internal fun <T> JSONObject.rows(key:String,parse:(JSONObject)->T):List<T>{val a=optJSONArray(key)?:return emptyList();return (0 until a.length()).map{parse(a.getJSONObject(it))}}
data class Picture(val id:String,val alt:String){companion object{fun parse(j:JSONObject)=Picture(j.getString("id"),j.optString("alt","图片"))}}
data class RemoteAction(val id:String,val label:String,val disabled:Boolean=false,val selected:Boolean=false,val submenu:Boolean=false,val confirm:Boolean=false,val images:List<Picture> = emptyList()){
    companion object{fun parse(j:JSONObject)=RemoteAction(j.getString("id"),j.getString("label"),j.optBoolean("disabled"),j.optBoolean("selected"),j.optBoolean("submenu"),j.optBoolean("confirm"),j.rows("images"){Picture.parse(it)})}
}
data class RemoteOption(val value:String,val label:String)
data class RemoteField(val id:String,val label:String,val value:String,val type:String,val options:List<RemoteOption> = emptyList())
data class RemoteSurface(val id:String,val revision:String,val kind:String,val title:String,val actions:List<RemoteAction>,val fields:List<RemoteField> = emptyList(),val body:String=""){
    companion object{fun parse(j:JSONObject)=RemoteSurface(j.getString("id"),j.getString("revision"),j.getString("kind"),j.getString("title"),j.rows("actions"){RemoteAction.parse(it)},j.rows("fields"){RemoteField(it.getString("id"),it.getString("label"),it.optString("value"),it.optString("type"),it.rows("options"){o->RemoteOption(o.getString("value"),o.getString("label"))})},j.optString("body"))}
}
data class QueueItem(val id:String,val revision:String,val text:String,val actions:List<RemoteAction>,val images:List<Picture>){
    companion object{fun parse(j:JSONObject)=QueueItem(j.getString("id"),j.getString("revision"),j.getString("text"),j.rows("actions"){RemoteAction.parse(it)},j.rows("images"){Picture.parse(it)})}
}
data class ComputerFile(val id:String,val name:String,val directory:Boolean)
data class FileListing(val name:String,val entries:List<ComputerFile>,val note:String){
    companion object{fun parse(j:JSONObject)=FileListing(j.getString("name"),j.rows("entries"){ComputerFile(it.getString("id"),it.getString("name"),it.getBoolean("directory"))},j.optString("note"))}
}
data class StagedFile(val id:String,val name:String,val contextId:String,val preview:ByteArray?=null)
