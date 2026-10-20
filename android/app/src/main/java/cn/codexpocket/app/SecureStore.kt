package cn.codexpocket.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureStore(context: Context) {
    private val prefs=context.getSharedPreferences("pocket_secure",Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val ks=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("codex_pocket",null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("codex_pocket",KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun put(name: String,value: String?) {
        if(value==null){prefs.edit().remove(name).commit();return}
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key()) }
        val encrypted=cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(name,Base64.encodeToString(cipher.iv+encrypted,Base64.NO_WRAP)).commit()
    }
    private fun get(name: String): String? {
        val raw=prefs.getString(name,null)?:return null
        return try { val bytes=Base64.decode(raw,Base64.NO_WRAP);val c=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)))};String(c.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8) }catch(_:Exception){null}
    }
    fun session(): Session? = try { get("session")?.let { Session.fromJson(JSONObject(it)) } }catch(_:Exception){null}
    fun saveSession(session: Session?) = put("session",session?.toJson()?.toString())
    fun drafts():JSONObject=try{JSONObject(get("drafts")?:"{}")}catch(_:Exception){JSONObject()}
    fun saveDrafts(value:JSONObject)=put("drafts",value.toString())
    fun theme():String=get("theme")?:"system"
    fun saveTheme(value:String)=put("theme",value)
    fun pendingContext():String?=get("pending_context")
    fun savePendingContext(value:String?)=put("pending_context",value)
    fun pending(): String? = get("pending")
    fun savePending(id: String?) = put("pending",id)
}
