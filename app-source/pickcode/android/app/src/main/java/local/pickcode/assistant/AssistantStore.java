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
    private String snapshotCache;
    private long snapshotCachedAt;

    public static synchronized AssistantStore get(Context context) {
        if (instance == null) instance = new AssistantStore(context.getApplicationContext());
        return instance;
    }

    private AssistantStore(Context context) {
        super(context, "assistant.db", null, 1);
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
    }
    @Override public void onUpgrade(SQLiteDatabase db, int from, int to) {
        throw new IllegalStateException("Unsupported database version");
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
            ContentValues values = new ContentValues();
            values.put("id", 1);
            values.put("payload", output.getJSONObject("state").toString());
            if (state.isEmpty() || !"snapshot".equals(action)) db.replaceOrThrow("assistant_state", null, values);
            db.setTransactionSuccessful();
            result = output.getJSONObject("result");
        } finally { db.endTransaction(); }
        // Publish only committed state, and never expose a mutable shared JSONObject to callers.
        if (result.has("codes") && result.has("packages") && result.has("settings")) {
            snapshotCache = result.toString();
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
