package local.pickcode.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Private, opt-in suggestions. Scanning never waits for network and saving always needs approval. */
public final class SmsAiManager {
    interface Clock { long now(); }
    static final int MAX_PENDING = 20;
    static final long MAX_AGE = 7L * 24 * 60 * 60 * 1000;
    private static final Executor WORKER = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "pickcode-ai-templates");
        thread.setDaemon(true);
        return thread;
    });
    private static SmsAiManager instance;

    interface Backend {
        String sessionKey() throws Exception;
        JSONObject service() throws Exception;
        JSONObject generate(JSONObject request) throws Exception;
        Object sessionLock();
    }

    private final AssistantStore store;
    private final Context context;
    private final SharedPreferences preferences;
    private final Backend backend;
    private final Executor worker;
    private final Clock clock;
    private final AtomicReference<Scan> nextScan = new AtomicReference<>();
    private final AtomicBoolean scheduled = new AtomicBoolean();
    private volatile boolean enabled;
    private volatile long generation;
    private String channelId = "", sessionKey = "";
    private String serviceRevision = "";
    private JSONObject serviceSnapshot = new JSONObject();
    private long serviceCheckedAt;
    private JSONArray pending = new JSONArray(), seen = new JSONArray();

    private static final class Scan {
        final JSONArray messages;
        final JSONObject snapshot;
        final long generation;
        Scan(JSONArray messages, JSONObject snapshot, long generation) {
            this.messages = messages; this.snapshot = snapshot; this.generation = generation;
        }
    }

    public static synchronized SmsAiManager get(Context context) {
        if (instance == null) {
            Context app = context.getApplicationContext();
            OnlineSyncManager online = OnlineSyncManager.get(app);
            instance = new SmsAiManager(app, new Backend() {
                @Override public String sessionKey() throws Exception { return online.aiSessionKey(); }
                @Override public JSONObject service() throws Exception { return online.aiChannels().getJSONObject("service"); }
                @Override public JSONObject generate(JSONObject request) throws Exception { return online.generateAiTemplate(request); }
                @Override public Object sessionLock() { return online; }
            }, WORKER, System::currentTimeMillis);
        }
        return instance;
    }

    SmsAiManager(Context context, Backend backend, Executor worker, Clock clock) {
        this.context = context.getApplicationContext();
        store = AssistantStore.get(context);
        preferences = context.getSharedPreferences("private_sms_ai", Context.MODE_PRIVATE);
        this.backend = backend; this.worker = worker; this.clock = clock;
        try {
            JSONObject saved = new JSONObject(preferences.getString("state", "{}"));
            enabled = Boolean.TRUE.equals(saved.opt("enabled"));
            channelId = saved.optString("channelId"); sessionKey = saved.optString("sessionKey");
            serviceRevision = saved.optString("serviceRevision"); serviceCheckedAt = saved.optLong("serviceCheckedAt");
            if (saved.optJSONObject("service") != null) serviceSnapshot = saved.getJSONObject("service");
            if (saved.optJSONArray("pending") != null) pending = saved.getJSONArray("pending");
            if (saved.optJSONArray("seen") != null) seen = saved.getJSONArray("seen");
            for (int i = 0; i < pending.length(); i++) {
                JSONObject item = pending.getJSONObject(i);
                if ("generating".equals(item.optString("status"))) item.put("status", "queued");
            }
            // Existing explicit consent remains valid, but results tied to an old phone-selected channel do not.
            if (enabled && serviceRevision.isEmpty() && pending.length() > 0) discardPending();
        } catch (Exception invalid) { enabled = false; pending = new JSONArray(); seen = new JSONArray(); }
        schedule();
    }

    public synchronized JSONObject status() throws Exception {
        refreshSession();
        return statusValue();
    }

    public JSONObject configure(JSONObject options) throws Exception {
        if (!(options.opt("enabled") instanceof Boolean)) throw new IllegalArgumentException("请明确选择是否开启 AI 建议");
        if ("legacy-deepseek".equals(options.optString("channelId"))) throw new IllegalArgumentException("请使用后台默认AI服务");
        boolean nextEnabled = options.getBoolean("enabled");
        String binding = backend.sessionKey();
        if (nextEnabled && binding.isEmpty()) throw new IllegalArgumentException("请先绑定已配置AI服务的后台");
        JSONObject remote = nextEnabled ? backend.service() : null;
        synchronized (this) {
            refreshSession();
            if (!binding.equals(sessionKey)) throw new OnlineClient.Failure("ai_session_changed", "后台绑定已变化，请重新开启建议");
            if (remote != null) {
                observeService(remote, binding);
                if (!remote.optBoolean("available")) throw OnlineClient.aiFailure(409, remote.optString("code"));
            }
            if (!nextEnabled || !enabled) { generation++; discardPending(); nextScan.set(null); }
            enabled = nextEnabled; sessionKey = binding;
            persist(); return statusValue();
        }
    }

    public synchronized void observeService(JSONObject remote, String observedSession) throws Exception {
        synchronized (backend.sessionLock()) {
            refreshSession();
            if (!observedSession.equals(sessionKey)) throw new OnlineClient.Failure("ai_session_changed", "后台绑定已变化，请重新读取AI服务");
            String id = remote.getString("channelId"), revision = remote.getString("revision");
            if (!id.equals(channelId) || !revision.equals(serviceRevision)) {
                generation++; discardPending();
                Scan waiting = nextScan.get();
                if (waiting != null) nextScan.compareAndSet(waiting, new Scan(waiting.messages, waiting.snapshot, generation));
            }
            channelId = id; serviceRevision = revision; serviceSnapshot = new JSONObject(remote.toString()); serviceCheckedAt = clock.now(); persist();
        }
    }

    private void discardPending() throws Exception {
        Set<String> abandoned = new HashSet<>();
        for (int i = 0; i < pending.length(); i++) abandoned.add(fingerprint(pending.getJSONObject(i).optString("sourceSample")));
        for (int i = seen.length() - 1; i >= 0; i--) if (abandoned.contains(seen.getJSONObject(i).optString("fingerprint"))) seen.remove(i);
        pending = new JSONArray();
    }

    /** One replaceable overlap-scan slot prevents unbounded raw-message retention during a slow request. */
    public void capture(JSONArray scanMessages, JSONObject postIngestSnapshot) {
        long capturedGeneration = generation;
        if (!enabled || scanMessages == null || postIngestSnapshot == null) return;
        Scan scan = new Scan(scanMessages, postIngestSnapshot, capturedGeneration);
        nextScan.set(scan);
        if (!enabled || capturedGeneration != generation) { nextScan.compareAndSet(scan, null); return; }
        schedule();
    }

    public synchronized JSONObject analyzeNow() throws Exception {
        refreshSession();
        if (!enabled) throw new IllegalStateException("请先开启 AI 建议");
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.getJSONObject(i);
            if ("failed".equals(item.optString("status"))) item.put("status", "queued").remove("error");
        }
        persist(); schedule();
        return statusValue();
    }

    public synchronized JSONObject ignore(String id) throws Exception {
        refreshSession();
        int index = indexOf(id);
        if (index < 0) throw new IllegalArgumentException("建议已过期或已处理");
        pending.remove(index);
        persist();
        return statusValue();
    }

    public JSONObject approve(String id) throws Exception {
        String observedSession = backend.sessionKey();
        JSONObject remote = backend.service();
        observeService(remote, observedSession);
        if (!remote.optBoolean("available")) throw OnlineClient.aiFailure(409, remote.optString("code"));
        synchronized (this) {
        // Keep the session comparison and local rule save atomic with backend bind/unbind operations.
        synchronized (backend.sessionLock()) {
            refreshSession();
            int index = indexOf(id);
            if (!enabled || index < 0 || !"ready".equals(pending.getJSONObject(index).optString("status")))
                throw new IllegalStateException("建议未验证、已过期或后台绑定已变化");
            if (!SmsScanner.allowed(context)) throw new IllegalStateException("短信读取权限已关闭，请重新授权后确认建议");
            JSONObject item = pending.getJSONObject(index);
            if (knownBodies(store.snapshot()).contains(item.getString("sourceSample"))) {
                pending.remove(index); persist();
                throw new IllegalStateException("此短信已被现有规则处理，无需重复保存建议");
            }
            JSONObject candidate = validate(item.getJSONObject("candidate"), item.getString("sourceSample"), item.getString("expectedCode")).put("origin", "ai");
            store.saveRuleAndIngest(candidate, item.optJSONObject("sourceMessage"));
            pending.remove(index);
            persist();
            WidgetRenderer.updateAll(context);
            return statusValue();
        }
        }
    }

    private void schedule() {
        synchronized (this) { if (!enabled || nextScan.get() == null && nextQueued() == null) return; }
        if (!scheduled.compareAndSet(false, true)) return;
        try { worker.execute(this::drain); }
        catch (RuntimeException unavailable) { scheduled.set(false); }
    }

    private void drain() {
        try {
            while (true) {
                JSONObject item;
                String selectedChannel, selectedSession, selectedRevision;
                long selectedGeneration;
                String observedSession;
                synchronized (this) {
                    refreshSession();
                    if (!enabled || nextScan.get() == null && nextQueued() == null) return;
                    observedSession = sessionKey;
                }
                JSONObject remote = backend.service();
                observeService(remote, observedSession);
                synchronized (this) {
                    refreshSession();
                    if (!enabled) { nextScan.set(null); return; }
                    if (!serviceSnapshot.optBoolean("available")) { deferScan("后台默认AI服务暂不可用，请恢复后台服务后重试"); return; }
                    Scan scan = nextScan.getAndSet(null);
                    if (scan != null && scan.generation == generation) collect(scan);
                    item = nextQueued();
                    if (item == null) return;
                    item.put("status", "generating");
                    selectedChannel = channelId; selectedSession = sessionKey; selectedRevision = serviceRevision; selectedGeneration = generation;
                    persist();
                    item = new JSONObject(item.toString());
                }
                JSONObject validated = null;
                try {
                    AiTemplatePrivacy.Prepared prepared = AiTemplatePrivacy.prepare(item.getString("sourceSample"), item.getString("expectedCode"));
                    JSONObject response = backend.generate(prepared.request(selectedChannel));
                    observeService(backend.service(), selectedSession);
                    validated = validate(response.getJSONObject("candidate"), item.getString("sourceSample"), prepared.actualCode).put("origin", "ai");
                } catch (Exception rejected) { /* Store only a fixed error; remote exception text may contain request data. */ }
                synchronized (this) {
                    refreshSession();
                    int index = indexOf(item.getString("id"));
                    if (!enabled || generation != selectedGeneration || !selectedChannel.equals(channelId) || !selectedRevision.equals(serviceRevision)
                            || !selectedSession.equals(sessionKey) || index < 0) continue;
                    JSONObject current = pending.getJSONObject(index);
                    if (validated == null) current.put("status", "failed").put("error", "此建议未通过生成或本机校验，可重试或手动设置");
                    else current.put("candidate", validated).put("status", "ready")
                            .put("validation", new JSONObject().put("passed", true).put("negativeCases", 8).put("local", true));
                    persist();
                }
            }
        } catch (Exception unavailable) {
            // Local scan success is independent of private suggestion storage and AI availability.
            try { synchronized (this) { deferScan("未能读取后台AI服务，请恢复连接后重试"); } }
            catch (Exception localFailure) { nextScan.set(null); }
        } finally {
            scheduled.set(false);
            if (nextScan.get() != null && enabled) schedule();
        }
    }

    private void deferScan(String message) throws Exception {
        Scan scan = nextScan.getAndSet(null);
        if (enabled && scan != null && scan.generation == generation) collect(scan);
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.getJSONObject(i);
            if ("queued".equals(item.optString("status"))) item.put("status", "failed").put("error", message);
        }
        persist();
    }

    private void collect(Scan scan) throws Exception {
        Set<String> known = knownBodies(scan.snapshot);
        known.addAll(knownBodies(store.snapshot()));
        for (int i = pending.length() - 1; i >= 0; i--)
            if (known.contains(pending.getJSONObject(i).optString("sourceSample"))) pending.remove(i);
        long now = clock.now();
        for (int i = scan.messages.length() - 1; i >= 0 && pending.length() < MAX_PENDING; i--) {
            JSONObject message = scan.messages.optJSONObject(i);
            if (message == null) continue;
            String source = message.optString("body");
            long date = message.optLong("date");
            if (date <= 0 || date < now - MAX_AGE || date > now + 60_000 || known.contains(source)) continue;
            String fingerprint = fingerprint(source);
            if (seen(fingerprint)) continue;
            AiTemplatePrivacy.Prepared prepared;
            try { prepared = AiTemplatePrivacy.prepare(source, ""); }
            catch (IllegalArgumentException manual) { continue; }
            pending.put(new JSONObject().put("id", UUID.randomUUID().toString()).put("createdAt", now)
                    .put("sourceSample", source).put("expectedCode", prepared.actualCode).put("candidate", JSONObject.NULL)
                    .put("sourceMessage", new JSONObject().put("id", message.optString("id")).put("address", message.optString("address"))
                            .put("body", source).put("date", date).put("receivedAt", message.optLong("receivedAt", date))
                            .put("sentAt", message.optLong("sentAt")))
                    .put("status", "queued"));
            seen.put(new JSONObject().put("fingerprint", fingerprint).put("createdAt", now));
        }
        prune(); persist();
    }

    static Set<String> knownBodies(JSONObject snapshot) {
        Set<String> result = new HashSet<>();
        for (String key : new String[]{"codes", "reminders", "ignored"}) {
            JSONArray items = snapshot.optJSONArray(key);
            if (items == null) continue;
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                if (item.has("body")) result.add(item.optString("body"));
                if (item.has("sourceBody")) result.add(item.optString("sourceBody"));
                JSONArray sources = item.optJSONArray("sources");
                if (sources != null) for (int j = 0; j < sources.length(); j++) {
                    JSONObject source = sources.optJSONObject(j);
                    if (source != null) result.add(source.optString("body"));
                }
            }
        }
        return result;
    }

    /** Available to manual generation too: validation always uses the original, device-local sample. */
    public JSONObject validate(JSONObject candidate, String source, String expected) throws Exception {
        AiTemplatePrivacy.Prepared prepared = AiTemplatePrivacy.prepare(source, expected);
        AiTemplatePrivacy.checkCandidate(candidate, prepared);
        JSONObject validated = store.validateCandidate(candidate, source, prepared.actualCode);
        AiTemplatePrivacy.checkCandidate(validated, prepared);
        for (String negative : AiTemplatePrivacy.negativeSamples(prepared)) {
            boolean matched = false;
            try { store.validateCandidate(validated, negative, negative.contains(AiTemplatePrivacy.DUMMY_CODE) ? AiTemplatePrivacy.DUMMY_CODE : "123456"); matched = true; }
            catch (Exception expectedRejection) { /* A pickup template must reject these non-pickup cases. */ }
            if (matched) throw new IllegalArgumentException("AI 模板误识别了验证或支付信息");
        }
        return validated;
    }

    private void refreshSession() throws Exception {
        String current = backend.sessionKey();
        boolean changed = !current.equals(sessionKey) || (enabled && current.isEmpty());
        if (changed) {
            generation++; enabled = false; pending = new JSONArray(); seen = new JSONArray(); nextScan.set(null); sessionKey = current;
            channelId = ""; serviceRevision = ""; serviceSnapshot = new JSONObject(); serviceCheckedAt = 0;
        }
        boolean expired = prune();
        if (changed || expired) persist();
    }

    private boolean prune() {
        long threshold = clock.now() - MAX_AGE;
        boolean changed = false;
        for (int i = pending.length() - 1; i >= 0; i--) {
            JSONObject item = pending.optJSONObject(i);
            if (item == null || item.optLong("createdAt") < threshold || i >= MAX_PENDING) { pending.remove(i); changed = true; }
        }
        for (int i = seen.length() - 1; i >= 0; i--) {
            JSONObject item = seen.optJSONObject(i);
            if (item == null || item.optLong("createdAt") < threshold) { seen.remove(i); changed = true; }
        }
        while (seen.length() > 200) { seen.remove(0); changed = true; }
        return changed;
    }

    private boolean seen(String fingerprint) {
        for (int i = 0; i < seen.length(); i++) if (fingerprint.equals(seen.optJSONObject(i).optString("fingerprint"))) return true;
        return false;
    }

    private static String fingerprint(String source) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8));
        StringBuilder encoded = new StringBuilder();
        for (byte value : digest) encoded.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return encoded.toString();
    }

    private int indexOf(String id) {
        for (int i = 0; i < pending.length(); i++) if (pending.optJSONObject(i).optString("id").equals(id)) return i;
        return -1;
    }

    private JSONObject nextQueued() {
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.optJSONObject(i);
            if ("queued".equals(item.optString("status"))) return item;
        }
        return null;
    }

    private JSONObject statusValue() throws Exception {
        JSONArray visible = new JSONArray(pending.toString());
        for (int i = 0; i < visible.length(); i++) visible.getJSONObject(i).remove("sourceMessage");
        return new JSONObject().put("enabled", enabled).put("channelId", channelId).put("pending", visible)
                .put("mode", "backend_default").put("service", serviceSnapshot.length() == 0 ? JSONObject.NULL : new JSONObject(serviceSnapshot.toString())).put("serviceCheckedAt", serviceCheckedAt)
                .put("pendingCount", pending.length()).put("maxPending", MAX_PENDING).put("retentionDays", 7)
                .put("safeSummary", "只发送已脱敏的最小模板片段；原短信和真实取件码留在本机，确认后才保存规则");
    }

    private void persist() throws Exception {
        JSONObject value = new JSONObject().put("enabled", enabled).put("channelId", channelId).put("sessionKey", sessionKey)
                .put("serviceRevision", serviceRevision).put("service", serviceSnapshot).put("serviceCheckedAt", serviceCheckedAt)
                .put("pending", pending).put("seen", seen);
        if (!preferences.edit().putString("state", value.toString()).commit()) throw new IllegalStateException("无法保存 AI 建议设置");
    }
}
