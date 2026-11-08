package local.pickcode.assistant;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** One transaction owns read -> core mutation -> write; UI/worker/widget never replace snapshots. */
public final class AssistantStore extends SQLiteOpenHelper {
    private static AssistantStore instance;
    private final CoreEngine engine;
    private volatile String snapshotCache;
    private volatile long snapshotCachedAt;
    private volatile DisplayCache displayCache;

    private static final class DisplayCache {
        final String snapshot, overview;
        DisplayCache(String snapshot, String overview) { this.snapshot = snapshot; this.overview = overview; }
    }

    public static synchronized AssistantStore get(Context context) {
        if (instance == null) instance = new AssistantStore(context.getApplicationContext());
        return instance;
    }

    private AssistantStore(Context context) {
        super(context, "assistant.db", null, 2);
        setWriteAheadLoggingEnabled(true);
        try (InputStream stream = context.getAssets().open("pickcode-core.js")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
            engine = new CoreEngine(bytes.toString(StandardCharsets.UTF_8.name()));
        } catch (Exception ex) { throw new IllegalStateException("本地解析引擎不可用，请重新安装应用", ex); }
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE assistant_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)");
        createDisplayCache(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int from, int to) {
        if (from == 1 && to == 2) createDisplayCache(db);
        else throw new IllegalStateException("Unsupported database version");
    }
    private static void createDisplayCache(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE assistant_display (id INTEGER PRIMARY KEY CHECK (id=1), snapshot TEXT NOT NULL, overview TEXT NOT NULL, revision INTEGER NOT NULL)");
    }

    // Display reads may use the last committed result while a mutation is still computing.
    public JSONObject displaySnapshot() throws Exception {
        try { return new JSONObject(display().snapshot); }
        catch (org.json.JSONException invalid) { return refreshSnapshot(); }
    }
    public JSONObject overview() throws Exception { return new JSONObject(display().overview); }
    boolean hasDisplaySnapshot() { return displayCache != null; }
    boolean displayNeedsRefresh() { return snapshotCache == null || android.os.SystemClock.elapsedRealtime() - snapshotCachedAt >= 1_000; }

    private DisplayCache display() throws Exception {
        DisplayCache saved = displayCache;
        if (saved != null) return saved;
        synchronized (this) {
            if (displayCache != null) return displayCache;
            try (Cursor row = getReadableDatabase().rawQuery("SELECT snapshot,overview FROM assistant_display WHERE id=1", null)) {
                if (row.moveToFirst()) {
                    try {
                        JSONObject summary = new JSONObject(row.getString(1));
                        if (summary.has("stats") && summary.has("online")) {
                            displayCache = new DisplayCache(row.getString(0), row.getString(1));
                        }
                    } catch (org.json.JSONException invalid) { /* Rebuild a damaged derived cache from the original state. */ }
                }
            }
            if (displayCache == null) snapshot();
            return displayCache;
        }
    }

    private static DisplayCache displayValue(JSONObject result, long revision) throws Exception {
        if (!result.has("codes") || !result.has("packages") || !result.has("settings")) return null;
        // Local and network queues can deliver replies in a different order than their commits.
        result.put("localRevision", revision);
        long total = 0, picked = 0;
        JSONArray codes = result.getJSONArray("codes");
        for (int i = 0; i < codes.length(); i++) {
            JSONObject item = codes.getJSONObject(i);
            long count = item.optLong("totalCount", 1);
            if (count == 0) count = 1;
            total += count;
            picked += count - (item.isNull("pendingCount") ? item.optBoolean("isPicked") ? 0 : 1 : item.getLong("pendingCount"));
        }
        JSONObject overview = new JSONObject().put("localRevision", revision).put("stats", new JSONObject().put("total", total).put("picked", picked))
                .put("online", result.getJSONObject("online"));
        return new DisplayCache(result.toString(), overview.toString());
    }

    public synchronized JSONObject snapshot() throws Exception { return dispatch("snapshot", new JSONObject()); }

    /** The visibility check and mutation share this monitor with every other store operation. */
    public synchronized boolean markPendingPicked(String id) throws Exception {
        JSONObject payload = WidgetModel.pickPayload(snapshot(), id);
        if (payload == null) return false;
        dispatch("update", payload);
        return true;
    }

    public synchronized JSONObject dispatch(String action, JSONObject payload) throws Exception {
        if ("snapshot".equals(action) && snapshotCache != null
                && android.os.SystemClock.elapsedRealtime() - snapshotCachedAt < 1_000) return new JSONObject(snapshotCache);
        return commitCommand(action, payload, null);
    }

    /** Confirmation commits the rule and its original SMS together, so a failed ingest is retryable. */
    public synchronized JSONObject saveRuleAndIngest(JSONObject rule, JSONObject sourceMessage) throws Exception {
        return commitCommand("saveRule", new JSONObject().put("rule", rule), sourceMessage);
    }

    private JSONObject commitCommand(String action, JSONObject payload, JSONObject sourceMessage) throws Exception {
        snapshotCache = null;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        JSONObject result;
        DisplayCache nextDisplay;
        try {
            String state = "";
            try (Cursor row = db.rawQuery("SELECT payload FROM assistant_state WHERE id=1", null)) {
                if (row.moveToFirst()) state = row.getString(0);
            }
            JSONObject request = new JSONObject().put("action", action).put("payload", payload);
            JSONObject output = new JSONObject(engine.dispatch(state, request.toString()));
            if (sourceMessage != null) {
                JSONObject nextState = output.getJSONObject("state");
                JSONObject ingest = new JSONObject().put("action", "ingest").put("payload", new JSONObject()
                        .put("messages", new JSONArray().put(sourceMessage)).put("scannedAt", nextState.optLong("lastScanAt")));
                output = new JSONObject(engine.dispatch(nextState.toString(), ingest.toString()));
            }
            result = output.getJSONObject("result");
            if (state.isEmpty() || !"snapshot".equals(action)) {
                ContentValues values = new ContentValues();
                values.put("id", 1);
                values.put("payload", output.getJSONObject("state").toString());
                db.replaceOrThrow("assistant_state", null, values);
            }
            long revision = 1;
            try (Cursor previous = db.rawQuery("SELECT revision FROM assistant_display WHERE id=1", null)) {
                if (previous.moveToFirst()) revision = previous.getLong(0) + 1;
            }
            nextDisplay = displayValue(result, revision);
            if (nextDisplay != null) {
                ContentValues cached = new ContentValues();
                cached.put("id", 1); cached.put("snapshot", nextDisplay.snapshot); cached.put("overview", nextDisplay.overview); cached.put("revision", revision);
                db.replaceOrThrow("assistant_display", null, cached);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        // Publish only committed state, and never expose a mutable shared JSONObject to callers.
        if (nextDisplay != null) {
            displayCache = nextDisplay;
            snapshotCache = nextDisplay.snapshot;
            snapshotCachedAt = android.os.SystemClock.elapsedRealtime();
        }
        return result;
    }

    public synchronized JSONObject refreshSnapshot() throws Exception {
        snapshotCache = null;
        return snapshot();
    }

    public JSONObject validateCandidate(JSONObject candidate, String sample, String expected) throws Exception {
        return new JSONObject(engine.validateCandidate(candidate.toString(), sample, expected));
    }
}
