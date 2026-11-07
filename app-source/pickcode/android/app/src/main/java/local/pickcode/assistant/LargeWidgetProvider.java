package local.pickcode.assistant;

import android.app.ActivityOptions;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.net.Uri;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public final class LargeWidgetProvider extends SmallWidgetProvider {
    static final String UNDO = "local.pickcode.assistant.WIDGET_UNDO";
    static final String PLATFORM = "local.pickcode.assistant.WIDGET_PLATFORM";
    static final String PICKUP_PAGE = "local.pickcode.assistant.WIDGET_PICKUP_PAGE";
    static final String ROAD_PAGE = "local.pickcode.assistant.WIDGET_ROAD_PAGE";
    static final String STATION_TOGGLE = "local.pickcode.assistant.WIDGET_STATION_TOGGLE";
    static final String STATION_SELECT = "local.pickcode.assistant.WIDGET_STATION_SELECT";
    static final String COLLECTION = "local.pickcode.assistant.WIDGET_COLLECTION";
    private static final String PREFERENCES = "large-widget-undo";
    private static SharedPreferences filters(Context context) {
        return context.getSharedPreferences("large-widget-filters", Context.MODE_PRIVATE);
    }
    static String station(Context context, int id) { return filters(context).getString(id + ":station", ""); }
    static boolean stationExpanded(Context context, int id) { return filters(context).getBoolean(id + ":stationExpanded", false); }
    static String resolveStation(Context context, int id, List<JSONObject> pending) {
        String saved = station(context, id), current = WidgetModel.activeStation(pending, saved);
        if (!saved.equals(current)) selectStation(context, id, current);
        return current;
    }
    static String platform(Context context, int id) { return WidgetModel.platformFilter(filters(context).getString(id + ":platform", "")); }
    static int page(Context context, int id, boolean road) { return Math.max(0, filters(context).getInt(id + (road ? ":roadPage" : ":pickupPage"), 0)); }
    static void selectStation(Context context, int id, String station) {
        filters(context).edit().putString(id + ":station", station).putBoolean(id + ":stationExpanded", false).putInt(id + ":pickupPage", 0).apply();
    }
    static boolean changeFilter(Context context, int id, String action, String value) {
        if (PLATFORM.equals(action)) {
            String selected = WidgetModel.platformFilter(value);
            if (selected.isEmpty()) return false;
            filters(context).edit().putString(id + ":platform", selected.equals(platform(context, id)) ? "" : selected)
                    .putInt(id + ":roadPage", 0).apply();
        } else if (PICKUP_PAGE.equals(action) || ROAD_PAGE.equals(action)) {
            if (value == null || !value.matches("\\d{1,6}")) return false;
            filters(context).edit().putInt(id + (ROAD_PAGE.equals(action) ? ":roadPage" : ":pickupPage"), Integer.parseInt(value)).apply();
        } else return false;
        return true;
    }
    @Override public void onDeleted(Context context, int[] ids) {
        SharedPreferences.Editor editor = filters(context).edit();
        for (int id : ids) for (String key : new String[]{":station", ":stationExpanded", ":platform", ":pickupPage", ":roadPage"}) editor.remove(id + key);
        editor.apply();
        super.onDeleted(context, ids);
    }

    static JSONObject undoRecord(Context context) {
        try { return new JSONObject(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString("record", "")); }
        catch (Exception absent) { return null; }
    }
    private static void saveUndo(Context context, JSONObject record) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putString("record", record == null ? "" : record.toString()).apply();
    }
    private static JSONObject code(JSONObject snapshot, String id) {
        JSONArray codes = snapshot.optJSONArray("codes");
        if (codes != null) for (int i = 0; i < codes.length(); i++) {
            JSONObject item = codes.optJSONObject(i);
            if (item != null && id.equals(item.optString("id"))) return item;
        }
        return null;
    }
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (COLLECTION.equals(action)) { receiveCollection(context, intent); return; }
        if (STATION_TOGGLE.equals(action)) {
            int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (!WidgetRenderer.isActiveWidget(context, widgetId, LargeWidgetProvider.class) || locked(context)) return;
            filters(context).edit().putBoolean(widgetId + ":stationExpanded", !stationExpanded(context, widgetId)).apply();
            WidgetRenderer.updateAll(context);
            return;
        }
        if (PLATFORM.equals(action) || PICKUP_PAGE.equals(action) || ROAD_PAGE.equals(action)) {
            int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (WidgetRenderer.isActiveWidget(context, widgetId, LargeWidgetProvider.class)
                    && changeFilter(context, widgetId, action, intent.getStringExtra("itemId"))) WidgetRenderer.updateAll(context);
            return;
        }
        if (!WidgetRenderer.PICK.equals(action) && !WidgetRenderer.RECEIPT.equals(action) && !UNDO.equals(action)) { super.onReceive(context, intent); return; }
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (!WidgetRenderer.isActiveWidget(context, widgetId, LargeWidgetProvider.class)) return;
        PendingResult pending = goAsync();
        PickCodeApplication.IO.execute(() -> {
            try {
                AssistantStore store = AssistantStore.get(context);
                synchronized (store) {
                    if (!WidgetRenderer.isActiveWidget(context, widgetId, LargeWidgetProvider.class)) return;
                    JSONObject snapshot = store.snapshot();
                    String id = intent.getStringExtra("itemId");
                    if (UNDO.equals(action)) {
                        JSONObject record = undoRecord(context);
                        if (record == null || !record.optString("id").equals(id) || record.optLong("at") != intent.getLongExtra("undoAt", -1)) return;
                        JSONObject payload = WidgetModel.undoPayload(snapshot, record, System.currentTimeMillis());
                        saveUndo(context, null);
                        if (payload != null) store.dispatch("receipt".equals(record.optString("kind")) ? "pickShipments" : "pickMembers", payload);
                    } else if (WidgetRenderer.RECEIPT.equals(action)) {
                        JSONObject payload = WidgetModel.receiptPayload(snapshot, id);
                        if (payload == null) return;
                        JSONObject after = store.dispatch("pickShipments", payload);
                        saveUndo(context, WidgetModel.receiptUndoRecord(snapshot, after, id, System.currentTimeMillis()));
                        scheduleUndoExpiry(context);
                    } else {
                        JSONObject item = WidgetModel.pendingItem(snapshot, id);
                        if (item == null || WidgetModel.largeRequiresDetail(item)) return;
                        JSONArray members = WidgetModel.singlePendingMembers(item);
                        if (members.length() != 1) return;
                        JSONObject after = store.dispatch("pickMembers", new JSONObject().put("id", id).put("memberIds", members).put("picked", true));
                        JSONObject record = WidgetModel.undoRecord(item, code(after, id), System.currentTimeMillis());
                        saveUndo(context, record);
                        scheduleUndoExpiry(context);
                    }
                }
                WidgetRenderer.updateAll(context);
                if (UNDO.equals(action)) OnlineSyncScheduler.refresh(context, false);
            } catch (Exception ignored) { WidgetRenderer.updateAll(context); }
            finally { pending.finish(); }
        });
    }
    /** The mutable fill-in cannot change the template's fixed widget identity or collection kind. */
    static int collectionWidgetId(Intent intent) {
        Uri data = intent.getData();
        if (!COLLECTION.equals(intent.getAction()) || data == null || !"pickcode".equals(data.getScheme())
                || !"collection".equals(data.getAuthority()) || data.getPathSegments().size() != 2) return AppWidgetManager.INVALID_APPWIDGET_ID;
        try {
            int id = Integer.parseInt(data.getPathSegments().get(0));
            if (id <= 0 || id != intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)) return AppWidgetManager.INVALID_APPWIDGET_ID;
            return id;
        } catch (NumberFormatException invalid) { return AppWidgetManager.INVALID_APPWIDGET_ID; }
    }
    private static boolean locked(Context context) {
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isKeyguardLocked();
    }
    private void receiveCollection(Context context, Intent intent) {
        int widgetId = collectionWidgetId(intent);
        if (!WidgetRenderer.isActiveWidget(context, widgetId, LargeWidgetProvider.class)) return;
        String kind = intent.getData().getPathSegments().get(1), action = intent.getStringExtra("rowAction"), itemId = intent.getStringExtra("itemId");
        try {
            JSONObject snapshot = AssistantStore.get(context).snapshot();
            List<JSONObject> pending = WidgetModel.pending(snapshot);
            if ("stations".equals(kind)) {
                if (!STATION_SELECT.equals(action) || locked(context) || !stationExpanded(context, widgetId)
                        || itemId == null || !WidgetModel.stations(pending, "").contains(itemId)) return;
                selectStation(context, widgetId, itemId);
                WidgetRenderer.updateAll(context);
                return;
            }
            if (!"pickups".equals(kind)) return;
            String selected = resolveStation(context, widgetId, pending);
            if (WidgetRenderer.RECEIPT.equals(action)) {
                if (!selected.isEmpty() || WidgetModel.receiptPayload(snapshot, itemId) == null) return;
            } else {
                JSONObject item = WidgetModel.pendingItem(snapshot, itemId);
                if (item == null || !selected.isEmpty() && !selected.equals(WidgetModel.stationKey(item))) return;
                if (WidgetModel.COPY_ACTION.equals(action) || WidgetModel.DETAIL_ACTION.equals(action)) {
                    PendingIntent activity = WidgetModel.COPY_ACTION.equals(action) ? WidgetRenderer.copy(context, widgetId, itemId)
                            : WidgetRenderer.detail(context, widgetId, itemId);
                    // Forward this user-initiated collection click to the existing copy/detail entrypoint.
                    ActivityOptions options = ActivityOptions.makeBasic();
                    if (Build.VERSION.SDK_INT >= 34) options.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                    activity.send(context, 0, null, null, null, null, options.toBundle());
                    return;
                }
                if (!WidgetRenderer.PICK.equals(action)) return;
            }
            onReceive(context, new Intent(intent).setAction(action));
        } catch (Exception unavailable) { WidgetRenderer.updateAll(context); }
    }
    private static void scheduleUndoExpiry(Context context) {
        new Handler(Looper.getMainLooper()).postDelayed(() -> PickCodeApplication.IO.execute(() -> {
            WidgetRenderer.updateAll(context);
            OnlineSyncScheduler.refresh(context, false);
        }), WidgetModel.UNDO_WINDOW_MS + 100);
    }
}
