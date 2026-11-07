package local.pickcode.assistant;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.Telephony;
import org.json.JSONArray;
import org.json.JSONObject;

public final class SmsScanner {
    public interface Cancellation { boolean cancelled(); }
    interface CursorQuery { Cursor query(String[] projection); }

    private static final String[] BASE_PROJECTION = {
            Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE
    };
    private static final String[] SENT_TIME_PROJECTION = {
            Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE,
            Telephony.Sms.DATE_SENT
    };

    private SmsScanner() {}
    public static boolean allowed(Context context) {
        return context.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    /** Serializing scans also prevents a slower scan from moving the successful cursor backwards. */
    public static JSONObject scan(Context context) throws Exception { return scan(context, () -> false); }

    public static synchronized JSONObject scan(Context context, Cancellation cancellation) throws Exception {
        if (cancellation.cancelled()) throw new InterruptedException();
        if (!allowed(context)) throw new SecurityException("请先授权读取短信");
        AssistantStore store = AssistantStore.get(context);
        long startedAt = System.currentTimeMillis();
        long from = ScanWindow.from(store.snapshot().optLong("lastScanAt"), startedAt);
        // Upper bound fixes the scan watermark. A 24h overlap recovers delayed SMS visibility.
        JSONArray messages = readMessages(projection -> context.getContentResolver().query(
                        Telephony.Sms.Inbox.CONTENT_URI, projection, "date >= ? AND date <= ?",
                        new String[]{Long.toString(from), Long.toString(startedAt)}, "date ASC, _id ASC"),
                cancellation);
        if (!allowed(context) || Thread.currentThread().isInterrupted() || cancellation.cancelled())
            throw new SecurityException("读取短信已取消");
        JSONObject result = store.dispatch("ingest", new JSONObject().put("messages", messages).put("scannedAt", startedAt));
        if (!Thread.currentThread().isInterrupted() && !cancellation.cancelled() && allowed(context)) {
            try { SmsAiManager.get(context).capture(messages, result); }
            catch (RuntimeException unavailable) { /* AI availability cannot invalidate a completed local scan. */ }
            try { OnlineSyncScheduler.maybeEnhance(context, result); }
            catch (RuntimeException unavailable) { /* The periodic sync can retry after a scheduler failure. */ }
        }
        WidgetRenderer.updateAll(context);
        return result;
    }

    static JSONArray readMessages(CursorQuery query, Cancellation cancellation) throws Exception {
        Cursor cursor;
        try {
            cursor = query.query(SENT_TIME_PROJECTION);
        } catch (RuntimeException unsupportedSentTime) {
            cursor = query.query(BASE_PROJECTION);
        }
        if (cursor == null) {
            cursor = query.query(BASE_PROJECTION);
        }
        if (cursor == null) throw new IllegalStateException("无法读取短信，请稍后重试");

        JSONArray messages = new JSONArray();
        try (Cursor rows = cursor) {
            int idIndex = rows.getColumnIndex(Telephony.Sms._ID);
            int addressIndex = rows.getColumnIndex(Telephony.Sms.ADDRESS);
            int bodyIndex = rows.getColumnIndex(Telephony.Sms.BODY);
            int dateIndex = rows.getColumnIndex(Telephony.Sms.DATE);
            int sentAtIndex = rows.getColumnIndex(Telephony.Sms.DATE_SENT);
            if (idIndex < 0 || dateIndex < 0) throw new IllegalStateException("短信字段不可用，请稍后重试");
            while (rows.moveToNext()) {
                if (Thread.currentThread().isInterrupted() || cancellation.cancelled()) throw new InterruptedException();
                if (messages.length() >= 50_000) throw new IllegalStateException("短信过多，本次扫描未完成");
                long receivedAt = rows.getLong(dateIndex);
                long sentAt = 0;
                if (sentAtIndex >= 0 && !rows.isNull(sentAtIndex)) {
                    long candidate = rows.getLong(sentAtIndex);
                    if (candidate > 0) sentAt = candidate;
                }
                messages.put(new JSONObject().put("id", rows.getString(idIndex))
                        .put("address", addressIndex < 0 || rows.isNull(addressIndex) ? "" : rows.getString(addressIndex))
                        .put("body", bodyIndex < 0 || rows.isNull(bodyIndex) ? "" : rows.getString(bodyIndex))
                        .put("date", receivedAt).put("receivedAt", receivedAt).put("sentAt", sentAt));
            }
        }
        return messages;
    }
}
