package local.pickcode.assistant;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

public class SmallWidgetProvider extends AppWidgetProvider {
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        PendingResult pending = goAsync();
        PickCodeApplication.IO.execute(() -> { try { WidgetRenderer.updateAll(context); } finally { pending.finish(); } });
    }
    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        onUpdate(context, manager, new int[]{id});
    }
    @Override public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (!WidgetRenderer.PICK.equals(action) && !WidgetRenderer.REFRESH.equals(action)) return;
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (!WidgetRenderer.isActiveWidget(context, widgetId, getClass())) return;
        PendingResult pending = goAsync();
        PickCodeApplication.IO.execute(() -> {
            try {
                if (!WidgetRenderer.isActiveWidget(context, widgetId, getClass())) return;
                if (WidgetRenderer.REFRESH.equals(action)) {
                    ScanScheduler.refresh(context);
                    OnlineSyncScheduler.refresh(context, true);
                }
                else {
                    String id = intent.getStringExtra("itemId");
                    AssistantStore.get(context).markPendingPicked(id);
                    WidgetRenderer.updateAll(context);
                    OnlineSyncScheduler.refresh(context, false);
                }
            } catch (Exception ignored) { /* Existing state remains intact; user can retry in app. */ }
            finally { pending.finish(); }
        });
    }
    @Override public void onRestored(Context context, int[] oldIds, int[] newIds) {
        onUpdate(context, AppWidgetManager.getInstance(context), newIds);
    }
}
