package local.pickcode.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** The API secret is encrypted by a non-exportable Android Keystore key; backups are disabled. */
public final class SecretStore {
    public static final String DEFAULT_MODEL = "deepseek-flash";
    private final String alias;
    private final SharedPreferences preferences;
    public SecretStore(Context context) { this(context, "private_ai", "pickcode.deepseek.v1"); }
    private SecretStore(Context context, String name, String alias) {
        preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE);
        this.alias = alias;
    }
    public static SecretStore online(Context context) { return new SecretStore(context, "private_online", "pickcode.online.v1"); }
    public synchronized void clear() {
        if (!preferences.edit().clear().commit()) throw new IllegalStateException("无法清除设备凭证");
    }
    public synchronized boolean configured() { return preferences.contains("ciphertext"); }
    public synchronized String model() { return preferences.getString("model", DEFAULT_MODEL); }

    public synchronized void save(String value, String model) throws Exception {
        String secret = value.trim();
        String selectedModel = model.trim().isEmpty() ? DEFAULT_MODEL : model.trim();
        if (!selectedModel.matches("[A-Za-z0-9._:-]{1,80}")) throw new IllegalArgumentException("模型名称格式不正确");
        if (secret.isEmpty()) {
            if (!preferences.edit().remove("ciphertext").remove("iv").putString("model", selectedModel).commit())
                throw new IllegalStateException("无法保存密钥设置");
            return;
        }
        if (!secret.matches("[!-~]{8,512}")) throw new IllegalArgumentException("API Key 格式不正确");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        String encrypted = Base64.encodeToString(cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!preferences.edit().putString("ciphertext", encrypted)
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putString("model", selectedModel).commit()) throw new IllegalStateException("无法保存密钥设置");
    }

    public synchronized String read() throws Exception {
        if (!configured()) throw new IllegalStateException("请先设置 DeepSeek API Key");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128,
                Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(preferences.getString("ciphertext", ""), Base64.NO_WRAP)),
                StandardCharsets.UTF_8);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
