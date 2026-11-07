package local.pickcode.assistant;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Binder;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.ArrayList;
import java.util.List;

/** Collection fallback for Android 6–11; newer hosts receive RemoteCollectionItems directly. */
public final class WidgetListService extends RemoteViewsService {
    static Intent adapterIntent(Context context, int widgetId, int width, int height, boolean stations) {
        return new Intent(context, WidgetListService.class)
                .setData(new Uri.Builder().scheme("pickcode").authority("widget-list")
                        .appendPath(Integer.toString(widgetId)).appendPath(stations ? "stations" : "pickups")
                        .appendPath(Integer.toString(width)).appendPath(Integer.toString(height)).build())
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId).putExtra("width", width).putExtra("height", height)
                .putExtra("stations", stations);
    }
    @Override public RemoteViewsFactory onGetViewFactory(Intent intent) { return new Factory(getApplicationContext(), intent); }
    static final class Factory implements RemoteViewsFactory {
        private final Context context;
        private final int widgetId, width, height;
        private final boolean stations, valid;
        private List<RemoteViews> rows = new ArrayList<>();
        Factory(Context context, Intent intent) {
            this.context = context;
            widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            width = intent.getIntExtra("width", 350); height = intent.getIntExtra("height", 250);
            stations = intent.getBooleanExtra("stations", false);
            valid = adapterIntent(context, widgetId, width, height, stations).getData().equals(intent.getData())
                    && width > 0 && width <= 2000 && height > 0 && height <= 2000;
        }
        @Override public void onCreate() { onDataSetChanged(); }
        @Override public void onDataSetChanged() {
            long identity = Binder.clearCallingIdentity();
            try {
                if (!valid || !WidgetRenderer.isActiveWidget(context, widgetId, LargeWidgetProvider.class)) { rows = new ArrayList<>(); return; }
                rows = WidgetRenderer.collectionRows(context, widgetId, width, height, AssistantStore.get(context).snapshot(), stations);
            } catch (Exception unavailable) { rows = new ArrayList<>(); }
            finally { Binder.restoreCallingIdentity(identity); }
        }
        @Override public void onDestroy() { rows = new ArrayList<>(); }
        @Override public int getCount() { return rows.size(); }
        @Override public RemoteViews getViewAt(int position) { return position >= 0 && position < rows.size() ? rows.get(position) : null; }
        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return stations ? 1 : 3; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
