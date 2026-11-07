package local.pickcode.assistant;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.Map;

public final class WidgetRenderer {
    static final String PICK = "local.pickcode.assistant.WIDGET_PICK";
    static final String RECEIPT = "local.pickcode.assistant.WIDGET_RECEIPT";
    static final String REFRESH = "local.pickcode.assistant.WIDGET_REFRESH";
    private WidgetRenderer() {}
    static boolean isActiveWidget(Context context, int id, Class<?> expectedProvider) {
        AppWidgetProviderInfo info = AppWidgetManager.getInstance(context).getAppWidgetInfo(id);
        return info != null && info.provider != null && WidgetModel.ownedProvider(id,
                info.provider.getPackageName(), info.provider.getClassName(), expectedProvider == null ? null : expectedProvider.getName());
    }
    public static void updateAll(Context context) {
        try {
            JSONObject snapshot = AssistantStore.get(context).snapshot();
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            renderProvider(context, manager, SmallWidgetProvider.class, WidgetModel.Size.SMALL, snapshot);
            renderProvider(context, manager, ListWidgetProvider.class, WidgetModel.Size.LIST, snapshot);
            renderProvider(context, manager, LargeWidgetProvider.class, WidgetModel.Size.LARGE, snapshot);
        } catch (Exception ignored) { /* Keep last valid widget when local storage is temporarily unavailable. */ }
    }

    private static void renderProvider(Context context, AppWidgetManager manager, Class<?> provider, WidgetModel.Size size, JSONObject snapshot) throws Exception {
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, provider));
        if (ids.length == 0) return;
        List<JSONObject> pending = WidgetModel.pending(snapshot);
        for (int id : ids) {
            Bundle options = manager.getAppWidgetOptions(id);
            if (Build.VERSION.SDK_INT >= 31) {
                ArrayList<SizeF> sizes = options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES);
                if (sizes != null && !sizes.isEmpty()) {
                    Map<SizeF, RemoteViews> layouts = new LinkedHashMap<>();
                    for (SizeF dimensions : sizes) {
                        if (dimensions.getWidth() > 0 && dimensions.getHeight() > 0 && layouts.size() < 16)
                            layouts.put(dimensions, render(context, provider, id, size, (int) dimensions.getWidth(),
                                    (int) dimensions.getHeight(), pending, snapshot));
                    }
                    if (!layouts.isEmpty()) {
                        manager.updateAppWidget(id, new RemoteViews(layouts));
                        refreshCollections(manager, id, size);
                        continue;
                    }
                }
            }
            // Older launchers report portrait min-width/max-height and landscape max-width/min-height.
            RemoteViews portrait = render(context, provider, id, size,
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, size.width),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, size.height), pending, snapshot);
            RemoteViews landscape = render(context, provider, id, size,
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, size.width),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, size.height), pending, snapshot);
            manager.updateAppWidget(id, new RemoteViews(landscape, portrait));
            refreshCollections(manager, id, size);
        }
    }

    private static RemoteViews render(Context context, Class<?> provider, int id, WidgetModel.Size size, int width, int height,
                                      List<JSONObject> pending, JSONObject snapshot) throws Exception {
        if (size == WidgetModel.Size.LARGE) return renderLarge(context, provider, id, width, height, pending, snapshot);
        float fontScale = context.getResources().getConfiguration().fontScale;
        boolean privateMode = snapshot.getJSONObject("settings").optBoolean("widgetPrivacy");
        boolean hasCabinet = false;
        for (JSONObject item : pending) hasCabinet |= !WidgetModel.pickupCabinet(item, privateMode).isEmpty();
        WidgetModel.Layout layout = WidgetModel.layout(size, width, height, fontScale, hasCabinet);
        int shown = Math.min(layout.capacity, pending.size());
        int total = 0, remaining = 0;
        for (int i = 0; i < pending.size(); i++) {
            int count = WidgetModel.pendingCount(pending.get(i));
            total += count;
            if (i >= shown) remaining += count;
        }
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget);
        views.setViewPadding(R.id.widget_root, dp(context, 8), dp(context, 8), dp(context, 8), dp(context, 8));
        views.setTextViewText(R.id.widget_count, total + " 待取");
        views.setOnClickPendingIntent(R.id.widget_root, open(context));
        views.setOnClickPendingIntent(R.id.widget_refresh, action(context, provider, id, REFRESH, ""));
        views.removeAllViews(R.id.widget_rows);
        views.setViewVisibility(R.id.widget_rows, shown > 0 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_empty, shown == 0 ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.widget_empty, !pending.isEmpty() ? "放大卡片或打开助手查看" : "暂无待取包裹");
        long last = snapshot.optLong("lastScanAt");
        JSONObject online = snapshot.optJSONObject("online");
        if (online != null) last = Math.max(last, online.optLong("lastSuccessAt"));
        boolean scannedToday = last > 0 && new SimpleDateFormat("yyyyMMdd", Locale.CHINA).format(new Date(last))
                .equals(new SimpleDateFormat("yyyyMMdd", Locale.CHINA).format(new Date()));
        String updated = last > 0 ? new SimpleDateFormat(scannedToday ? "HH:mm" : "MM-dd HH:mm", Locale.CHINA)
                .format(new Date(last)) + " 更新" : "尚未更新";
        // The remaining count takes priority in a narrow footer; full scan time remains an accessibility description.
        views.setTextViewText(R.id.widget_status, remaining > 0 ? "还有 " + remaining + " 件 · " + updated : updated);
        views.setContentDescription(R.id.widget_status, updated + (remaining > 0 ? "，还有 " + remaining + " 件未显示" : ""));
        for (int i = 0; i < shown; i++) {
            JSONObject item = pending.get(i);
            RemoteViews row = new RemoteViews(context.getPackageName(), layout.compact ? R.layout.widget_row_compact : R.layout.widget_row);
            String cabinet = WidgetModel.pickupCabinet(item, privateMode);
            bindCabinet(context, row, R.id.row_cabinet, cabinet);
            row.setTextViewText(R.id.row_code, privateMode ? "••••••" : item.optString("code"));
            row.setTextViewTextSize(R.id.row_code, TypedValue.COMPLEX_UNIT_SP, layout.codeSp);
            row.setInt(R.id.row_code, "setMaxLines", layout.codeLines);
            row.setInt(R.id.row_pick, "setWidth", dp(context, layout.actionWidth));
            String company = item.optString("company");
            if (company.startsWith("菜鸟")) company = "菜鸟";
            if (company.startsWith("兔喜")) company = "兔喜";
            String address = WidgetModel.pickupStation(item, false);
            row.setTextViewText(R.id.row_company, privateMode ? "" : layout.compact && hasCabinet ? address : company);
            row.setViewVisibility(R.id.row_company, layout.compact && !privateMode && (layout.showDetails || hasCabinet) ? View.VISIBLE : View.GONE);
            row.setTextViewText(R.id.row_address, privateMode ? "隐私模式 · 进入应用复制" :
                    layout.compact ? address : company + (address.isEmpty() || company.isEmpty() ? "" : " · ") + address);
            row.setViewVisibility(R.id.row_address, layout.showDetails ? View.VISIBLE : View.GONE);
            row.setOnClickPendingIntent(R.id.row_code, copy(context, id, item.getString("id")));
            row.setContentDescription(R.id.row_code, privateMode ? "进入应用复制此取件码" : "复制取件码 " + item.optString("code"));
            boolean detailRequired = WidgetModel.requiresDetail(item);
            row.setTextViewText(R.id.row_pick, detailRequired ? "详情" : "取件");
            row.setOnClickPendingIntent(R.id.row_pick, detailRequired ? detail(context, id, item.getString("id"))
                    : action(context, provider, id, PICK, item.getString("id")));
            row.setContentDescription(R.id.row_pick, detailRequired ? "打开详情确认已取包裹及本次领取" : "标记此包裹已取件");
            views.addView(R.id.widget_rows, row);
        }
        return views;
    }

    private static RemoteViews renderLarge(Context context, Class<?> provider, int id, int width, int height,
                                           List<JSONObject> pending, JSONObject snapshot) throws Exception {
        WidgetModel.LargeLayout layout = WidgetModel.largeLayout(width, height, context.getResources().getConfiguration().fontScale);
        JSONObject settings = snapshot.optJSONObject("settings");
        boolean privacy = settings != null && settings.optBoolean("widgetPrivacy");
        String selectedStation = LargeWidgetProvider.resolveStation(context, id, pending), selectedPlatform = LargeWidgetProvider.platform(context, id);
        pending = WidgetModel.stationPending(pending, selectedStation);
        List<WidgetModel.RoadOrder> allRoad = WidgetModel.roadOrders(snapshot, privacy);
        List<WidgetModel.RoadOrder> road = WidgetModel.platformOrders(allRoad, selectedPlatform);
        List<WidgetModel.ReceiptShipment> receipts = selectedStation.isEmpty() ? WidgetModel.receiptShipments(snapshot, privacy) : new ArrayList<>();
        JSONObject undo = LargeWidgetProvider.undoRecord(context);
        boolean hasUndo = WidgetModel.undoPayload(snapshot, undo, System.currentTimeMillis()) != null;
        int total = WidgetModel.pickupTotal(pending);
        boolean choosingStation = LargeWidgetProvider.stationExpanded(context, id);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_large);
        views.setOnClickPendingIntent(R.id.large_pickup_count, open(context));
        views.setTextViewText(R.id.large_pickup_title, "待取");
        views.setInt(R.id.large_pickup_title, "setHeight", dp(context, layout.headerHeight));
        textDp(context, views, R.id.large_pickup_title, layout.textSp + 1);
        String count = total + "件";
        if (!receipts.isEmpty()) {
            count += " · " + receipts.size() + "件待确认";
        }
        views.setTextViewText(R.id.large_pickup_count, count);
        int countLength = 0;
        for (String line : count.split("\n")) countLength = Math.max(countLength, line.length());
        textDp(context, views, R.id.large_pickup_count, Math.min(layout.textSp - (receipts.isEmpty() ? 0 : 1), Math.max(7, (width > 0 ? width : 350) * .5f / countLength)));
        views.setContentDescription(R.id.large_pickup_count, "共 " + total + " 件待取，" + receipts.size() + " 件待确认，上下滑动查看全部，点击数量打开助手");
        String stationLabel = selectedStation.isEmpty() ? "全部站点" : privacy ? "站点已隐藏" : selectedStation;
        views.setTextViewText(R.id.large_station, stationLabel + " · " + total + (choosingStation ? " ▴" : " ▾"));
        textDp(context, views, R.id.large_station, layout.textSp - 1);
        views.setContentDescription(R.id.large_station, "选择取件站点，" + stationLabel + "，" + total + "件待取");
        views.setOnClickPendingIntent(R.id.large_station, action(context, provider, id, LargeWidgetProvider.STATION_TOGGLE, ""));
        views.setViewVisibility(R.id.large_pickup_rows, choosingStation ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.large_station_options, choosingStation ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.large_pickup_empty, !choosingStation && pending.isEmpty() && receipts.isEmpty() ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.large_pickup_empty, "暂无待取快递");
        textDp(context, views, R.id.large_pickup_empty, Math.min(16, layout.textSp + 2));
        bindCollection(context, views, id, width, height, snapshot, false);
        bindCollection(context, views, id, width, height, snapshot, true);
        views.removeAllViews(R.id.large_pickup_undo);
        views.setViewVisibility(R.id.large_pickup_undo, hasUndo && !choosingStation ? View.VISIBLE : View.GONE);
        if (hasUndo) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_large_undo);
            row.setInt(R.id.large_undo_button, "setHeight", dp(context, 44));
            row.setTextViewText(R.id.large_undo_message, "receipt".equals(undo.optString("kind")) ? "✓ 已确认收到" : "✓ 已标记领取");
            row.setOnClickPendingIntent(R.id.large_undo_button, undo(context, id, undo));
            views.addView(R.id.large_pickup_undo, row);
        }
        int roadShown = Math.min(layout.roadRows, road.size());
        boolean roadCycles = road.size() > roadShown && roadShown > 0;
        int roadPages = Math.max(1, road.size());
        int roadPage = Math.min(LargeWidgetProvider.page(context, id, true), roadPages - 1);
        views.setTextViewText(R.id.large_road_heading, width > 0 && width < 220 ? "代收" : "代收包裹");
        views.setTextViewText(R.id.large_road_count, allRoad.size() + "单");
        textDp(context, views, R.id.large_road_heading, layout.textSp);
        textDp(context, views, R.id.large_road_count, layout.textSp - 1);
        views.setInt(R.id.large_road_heading, "setHeight", dp(context, 16));
        int[] platformViews = {R.id.large_platform_taobao, R.id.large_platform_jd, R.id.large_platform_pdd};
        String[] platforms = {"taobao", "jd", "pdd"}, labels = {"淘宝", "京东", "拼多多"};
        for (int index = 0; index < platforms.length; index++) {
            int target = platformViews[index], countForPlatform = WidgetModel.platformOrders(allRoad, platforms[index]).size();
            boolean active = platforms[index].equals(selectedPlatform);
            views.setTextViewText(target, labels[index] + " " + (privacy ? "••" : countForPlatform));
            textDp(context, views, target, width < 320 ? 9 : 10);
            views.setInt(target, "setBackgroundResource", active ? R.drawable.widget_platform_filter_active : R.drawable.widget_platform_filter);
            views.setContentDescription(target, labels[index] + (privacy ? "，数量已隐藏，" : " " + countForPlatform + "单代收包裹，") + (active ? "已选，再点取消" : "筛选"));
            views.setOnClickPendingIntent(target, action(context, provider, id, LargeWidgetProvider.PLATFORM, platforms[index]));
        }
        // Remove old carousel children before binding the static footer on reapply: children share its view IDs.
        views.removeAllViews(R.id.large_road_rows);
        bindRoadFooter(context, views, provider, id, layout, snapshot, selectedPlatform, 0, 1);
        views.setViewVisibility(R.id.large_road_footer, roadCycles ? View.GONE : View.VISIBLE);
        views.setOnClickPendingIntent(R.id.large_road_content, packages(context, id));
        views.setContentDescription(R.id.large_road_content, "代收包裹共 " + road.size() + " 笔，"
                + (roadCycles ? "自动循环展示全部包裹，" : "另有 " + (road.size() - roadShown) + " 笔未显示，") + "打开包裹记录");
        views.setViewVisibility(R.id.large_road_empty, roadShown == 0 && layout.roadRows > 0 ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.large_road_empty, road.isEmpty() ? "暂无代收包裹" : "打开包裹记录查看 ›");
        textDp(context, views, R.id.large_road_empty, layout.textSp);
        if (roadCycles) {
            RemoteViews flipper = new RemoteViews(context.getPackageName(), roadShown == 2
                    ? R.layout.widget_large_road_flipper : R.layout.widget_large_road_flipper_single);
            // The visible window and its controls advance together: [A,B] -> [B,C], including wrap to A.
            for (int start = 0; start < road.size(); start++) {
                RemoteViews page = new RemoteViews(context.getPackageName(), R.layout.widget_large_road_page);
                for (int offset = 0; offset < roadShown; offset++)
                    page.addView(R.id.large_road_page, roadRow(context, layout, road.get((start + offset) % road.size())));
                bindRoadFooter(context, page, provider, id, layout, snapshot, selectedPlatform, start, roadPages);
                flipper.addView(R.id.large_road_flipper, page);
            }
            flipper.setInt(R.id.large_road_flipper, "setDisplayedChild", roadPage);
            views.addView(R.id.large_road_rows, flipper);
        } else {
            for (int i = 0; i < roadShown; i++) views.addView(R.id.large_road_rows, roadRow(context, layout, road.get(i)));
        }
        return views;
    }
    private static void refreshCollections(AppWidgetManager manager, int id, WidgetModel.Size size) {
        if (size == WidgetModel.Size.LARGE && Build.VERSION.SDK_INT < 31) {
            manager.notifyAppWidgetViewDataChanged(id, R.id.large_pickup_rows);
            manager.notifyAppWidgetViewDataChanged(id, R.id.large_station_options);
        }
    }
    private static void bindCollection(Context context, RemoteViews views, int id, int width, int height,
                                       JSONObject snapshot, boolean stations) throws Exception {
        int viewId = stations ? R.id.large_station_options : R.id.large_pickup_rows;
        views.setPendingIntentTemplate(viewId, collectionTemplate(context, id, stations));
        if (Build.VERSION.SDK_INT >= 31) {
            List<RemoteViews> rows = collectionRows(context, id, width, height, snapshot, stations);
            RemoteViews.RemoteCollectionItems.Builder items = new RemoteViews.RemoteCollectionItems.Builder()
                    .setHasStableIds(false).setViewTypeCount(stations ? 1 : 3);
            for (int index = 0; index < rows.size(); index++) items.addItem(index, rows.get(index));
            views.setRemoteAdapter(viewId, items.build());
        } else {
            views.setRemoteAdapter(viewId, WidgetListService.adapterIntent(context, id, width, height, stations));
        }
    }
    static List<RemoteViews> collectionRows(Context context, int id, int width, int height,
                                           JSONObject snapshot, boolean stations) throws Exception {
        List<JSONObject> allPending = WidgetModel.pending(snapshot);
        String selected = LargeWidgetProvider.resolveStation(context, id, allPending);
        JSONObject settings = snapshot.optJSONObject("settings");
        boolean privacy = settings != null && settings.optBoolean("widgetPrivacy");
        if (stations) {
            List<RemoteViews> result = new ArrayList<>();
            List<String> choices = WidgetModel.stations(allPending, selected);
            for (int index = 0; index < choices.size(); index++) {
                String station = choices.get(index);
                RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_station_row);
                String label = station.isEmpty() ? "全部站点" : privacy ? "站点 " + index : station;
                row.setTextViewText(R.id.station_option_label, label);
                row.setTextViewText(R.id.station_option_count, WidgetModel.pickupTotal(WidgetModel.stationPending(allPending, station)) + " 件");
                row.setTextViewText(R.id.station_option_selected, station.equals(selected) ? "✓" : "");
                row.setContentDescription(R.id.station_option, label + (station.equals(selected) ? "，已选" : "，选择站点"));
                row.setOnClickFillInIntent(R.id.station_option, collectionAction(LargeWidgetProvider.STATION_SELECT, station));
                result.add(row);
            }
            return result;
        }
        List<JSONObject> pending = WidgetModel.stationPending(allPending, selected);
        List<WidgetModel.ReceiptShipment> receipts = selected.isEmpty() ? WidgetModel.receiptShipments(snapshot, privacy) : new ArrayList<>();
        WidgetModel.LargeLayout layout = WidgetModel.largeLayout(width, height, context.getResources().getConfiguration().fontScale);
        boolean hasUndo = WidgetModel.undoPayload(snapshot, LargeWidgetProvider.undoRecord(context), System.currentTimeMillis()) != null;
        boolean singlePickup = WidgetModel.pickupTotal(pending) == 1 && pending.size() == 1 && receipts.isEmpty() && !hasUndo;
        Class<?> provider = LargeWidgetProvider.class;
        List<RemoteViews> pickupRows = new ArrayList<>();
        for (int i = 0; i < pending.size(); i++) {
            JSONObject item = pending.get(i);
            if (singlePickup) {
                pickupRows.add(singlePickupRow(context, provider, id, width, layout, item, privacy));
                continue;
            }
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_large_row);
            String owners = WidgetModel.pickupOwners(item, privacy), summary = WidgetModel.pickupTitle(item, privacy);
            String station = privacy ? "站点信息已隐藏" : WidgetModel.stationKey(item), cabinet = WidgetModel.pickupCabinet(item, privacy);
            bindCabinet(context, row, R.id.large_row_cabinet, cabinet);
            String code = privacy ? "••••••" : item.optString("code");
            Paint codePaint = new Paint();
            codePaint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
            codePaint.setTextSize(1);
            Paint cabinetPaint = new Paint();
            cabinetPaint.setTextSize(10);
            int badgeWidth = cabinet.isEmpty() ? 0 : Math.min(64, (int) Math.ceil(cabinetPaint.measureText(cabinet)) + 8) + 6;
            int ownerWidth = layout.ownerWidth;
            int codeWidth = (width > 0 ? width : WidgetModel.Size.LARGE.width) - 24 - layout.actionWidth
                    - (layout.showOwners ? 16 : 8) - ownerWidth - badgeWidth - 16;
            float minimumCodeWidth = codePaint.measureText(code) * 12;
            if (layout.showOwners && codeWidth < minimumCodeWidth) {
                int released = Math.min(Math.max(0, ownerWidth - 44), (int) Math.ceil(minimumCodeWidth - codeWidth));
                ownerWidth -= released; codeWidth += released;
            }
            float codeSize = Math.min(layout.codeSp, Math.max(12, codeWidth / Math.max(1, codePaint.measureText(code))));
            boolean wrapsCode = codePaint.measureText(code) * codeSize > codeWidth;
            row.setTextViewText(R.id.large_row_code, privacy ? "••••••" : item.optString("code"));
            textDp(context, row, R.id.large_row_code, wrapsCode ? 12 : codeSize);
            row.setInt(R.id.large_row_code, "setMaxLines", wrapsCode ? 2 : 1);
            row.setTextViewText(R.id.large_row_station, layout.showOwners ? station : station + " · " + owners + " · " + summary);
            textDp(context, row, R.id.large_row_station, wrapsCode ? Math.min(11, layout.textSp - 1) : layout.textSp - 1);
            row.setViewVisibility(R.id.large_row_owner_column, layout.showOwners ? View.VISIBLE : View.GONE);
            row.setTextViewText(R.id.large_row_owner, owners);
            row.setTextViewText(R.id.large_row_summary, summary);
            row.setViewVisibility(R.id.large_row_summary, summary.isEmpty() ? View.GONE : View.VISIBLE);
            row.setInt(R.id.large_row_owner, "setWidth", dp(context, ownerWidth));
            row.setInt(R.id.large_row_summary, "setWidth", dp(context, ownerWidth));
            textDp(context, row, R.id.large_row_owner, layout.textSp);
            textDp(context, row, R.id.large_row_summary, layout.textSp - 1);
            boolean detailRequired = WidgetModel.largeRequiresDetail(item);
            row.setTextViewText(R.id.large_row_pick, detailRequired ? "取件 ›" : "取件 ✓");
            row.setInt(R.id.large_row_pick, "setWidth", dp(context, layout.actionWidth));
            row.setInt(R.id.large_row_pick, "setHeight", dp(context, 44));
            textDp(context, row, R.id.large_row_pick, layout.textSp + 1);
            row.setOnClickFillInIntent(R.id.large_row_copy, collectionAction(WidgetModel.COPY_ACTION, item.optString("id")));
            row.setContentDescription(R.id.large_row_copy, privacy ? "进入应用复制此取件码" : "复制取件码 " + item.optString("code") + "，" + station);
            row.setOnClickFillInIntent(R.id.large_row_owner_column, collectionAction(WidgetModel.DETAIL_ACTION, item.optString("id")));
            row.setOnClickFillInIntent(R.id.large_row_pick, collectionAction(detailRequired ? WidgetModel.DETAIL_ACTION : PICK, item.optString("id")));
            row.setContentDescription(R.id.large_row_pick, detailRequired ? "进入应用逐件确认领取" : "标记此包裹已取件，可在七秒内撤销");
            row.setViewVisibility(R.id.large_row_divider, i == pending.size() - 1 && receipts.size() == 0 && !hasUndo ? View.INVISIBLE : View.VISIBLE);
            pickupRows.add(row);
        }
        List<RemoteViews> receiptRows = new ArrayList<>();
        for (int i = 0; i < receipts.size(); i++) {
            WidgetModel.ReceiptShipment item = receipts.get(i);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_receipt_row);
            row.setTextViewText(R.id.receipt_row_status, "已送达 · 待确认");
            row.setTextViewText(R.id.receipt_row_title, item.title);
            row.setTextViewText(R.id.receipt_row_owner, item.owner);
            row.setTextViewText(R.id.receipt_row_platform, item.platformLabel);
            row.setViewVisibility(R.id.receipt_row_owner_column, layout.showOwners && !privacy ? View.VISIBLE : View.GONE);
            if (!layout.showOwners && !privacy) row.setTextViewText(R.id.receipt_row_title, item.title + " · " + item.owner);
            row.setInt(R.id.receipt_row_owner, "setWidth", dp(context, layout.ownerWidth));
            row.setInt(R.id.receipt_row_platform, "setWidth", dp(context, layout.ownerWidth));
            textDp(context, row, R.id.receipt_row_status, layout.textSp - 1);
            textDp(context, row, R.id.receipt_row_title, Math.min(14, layout.textSp + 3));
            textDp(context, row, R.id.receipt_row_owner, layout.textSp);
            textDp(context, row, R.id.receipt_row_platform, layout.textSp - 1);
            row.setTextViewText(R.id.large_row_pick, width > 0 && width < 320 ? "收货" : "确认收到");
            row.setInt(R.id.large_row_pick, "setWidth", dp(context, layout.actionWidth));
            row.setInt(R.id.large_row_pick, "setHeight", dp(context, 44));
            textDp(context, row, R.id.large_row_pick, layout.textSp - 1);
            row.setBoolean(R.id.large_row_pick, "setEnabled", item.canPick);
            row.setFloat(R.id.large_row_pick, "setAlpha", item.canPick ? 1f : .45f);
            if (item.canPick) row.setOnClickFillInIntent(R.id.large_row_pick, collectionAction(RECEIPT, item.id));
            row.setContentDescription(R.id.large_row_pick, item.canPick ? "确认此包裹已收到，可在七秒内撤销" : "当前账号无权确认收货，请打开应用检查绑定");
            row.setViewVisibility(R.id.large_row_divider, i == receipts.size() - 1 && !hasUndo ? View.INVISIBLE : View.VISIBLE);
            receiptRows.add(row);
        }
        List<RemoteViews> result = new ArrayList<>();
        for (int index = 0; index < Math.max(pickupRows.size(), receiptRows.size()); index++) {
            if (index < pickupRows.size()) result.add(pickupRows.get(index));
            if (index < receiptRows.size()) result.add(receiptRows.get(index));
        }
        return result;
    }
    private static Intent collectionAction(String action, String itemId) {
        return new Intent().putExtra("rowAction", action).putExtra("itemId", itemId);
    }
    static PendingIntent collectionTemplate(Context context, int widgetId, boolean stations) {
        Intent intent = new Intent(context, LargeWidgetProvider.class).setAction(LargeWidgetProvider.COLLECTION)
                .setData(new Uri.Builder().scheme("pickcode").authority("collection")
                        .appendPath(Integer.toString(widgetId)).appendPath(stations ? "stations" : "pickups").build())
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(context, widgetId, intent, flags);
    }
    private static void bindRoadFooter(Context context, RemoteViews views, Class<?> provider, int id,
                                       WidgetModel.LargeLayout layout, JSONObject snapshot, String selectedPlatform, int page, int pages) {
        views.setTextViewText(R.id.large_road_scope, selectedPlatform.isEmpty() ? "全部平台" : "taobao".equals(selectedPlatform) ? "淘宝" : "jd".equals(selectedPlatform) ? "京东" : "拼多多");
        textDp(context, views, R.id.large_road_scope, 9);
        bindPager(context, views, provider, id, true, page, pages);
        long last = snapshot.optLong("lastScanAt");
        JSONObject online = snapshot.optJSONObject("online");
        if (online != null) last = Math.max(last, online.optLong("lastSuccessAt"));
        String time = last > 0 ? new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date(last)) : "刷新";
        views.setTextViewText(R.id.large_refresh_time, time);
        textDp(context, views, R.id.large_refresh_time, Math.max(8, layout.textSp - 3));
        views.setOnClickPendingIntent(R.id.large_refresh, action(context, provider, id, REFRESH, ""));
        views.setContentDescription(R.id.large_refresh, "刷新组件，" + (last > 0 ? "最近更新 " + time : "尚未更新"));
    }
    private static RemoteViews singlePickupRow(Context context, Class<?> provider, int id, int width,
                                               WidgetModel.LargeLayout layout, JSONObject item, boolean privacy) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_large_single_row);
        String cabinet = WidgetModel.pickupCabinet(item, privacy), station = privacy ? "站点信息已隐藏" : WidgetModel.stationKey(item);
        String code = privacy ? "••••••" : item.optString("code"), owner = privacy ? "••" : WidgetModel.pickupOwners(item, false);
        bindCabinet(context, row, R.id.large_row_cabinet, cabinet);
        Paint paint = new Paint();
        paint.setTextSize(layout.textSp);
        int ownerWidth = Math.min(76, Math.max(36, (int) Math.ceil(paint.measureText(owner)) + 12));
        paint.setTextSize(10);
        int cabinetWidth = cabinet.isEmpty() ? 0 : Math.min(64, (int) Math.ceil(paint.measureText(cabinet)) + 8) + 6;
        paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        paint.setTextSize(31);
        int codeWidth = (width > 0 ? width : WidgetModel.Size.LARGE.width) - 24 - ownerWidth - 8 - cabinetWidth - 16;
        int availableHeight = layout.pickupHeight - 28 - layout.headerHeight;
        float codeSize = Math.max(12, Math.min(Math.min(31, (availableHeight - 50) / 1.2f), codeWidth * 31f / Math.max(1, paint.measureText(code))));
        row.setViewPadding(R.id.large_single_row, 0, dp(context, Math.max(0, Math.min(14, availableHeight - 50 - (int) Math.ceil(codeSize * 1.2f)))), 0, 0);
        row.setTextViewText(R.id.large_row_code, code);
        paint.setTextSize(codeSize);
        row.setInt(R.id.large_row_code, "setWidth", dp(context, (int) Math.ceil(paint.measureText(code)) + 16));
        textDp(context, row, R.id.large_row_code, codeSize);
        row.setTextViewText(R.id.large_row_owner, owner);
        row.setInt(R.id.large_row_owner, "setWidth", dp(context, ownerWidth));
        textDp(context, row, R.id.large_row_owner, layout.textSp - 1);
        row.setTextViewText(R.id.large_row_station, station);
        String title = WidgetModel.pickupTitle(item, privacy);
        row.setTextViewText(R.id.large_row_summary, title);
        row.setViewVisibility(R.id.large_row_summary, title.isEmpty() ? View.GONE : View.VISIBLE);
        textDp(context, row, R.id.large_row_station, layout.textSp - 1);
        textDp(context, row, R.id.large_row_summary, layout.textSp - 1);
        boolean detailRequired = WidgetModel.largeRequiresDetail(item);
        row.setTextViewText(R.id.large_row_pick, detailRequired ? "取件 ›" : "取件 ✓");
        row.setInt(R.id.large_row_pick, "setWidth", dp(context, layout.actionWidth));
        textDp(context, row, R.id.large_row_pick, layout.textSp + 1);
        row.setOnClickFillInIntent(R.id.large_row_copy, collectionAction(WidgetModel.COPY_ACTION, item.optString("id")));
        row.setContentDescription(R.id.large_row_copy, privacy ? "进入应用复制此取件码" : "复制取件码 " + code + "，" + station);
        row.setOnClickFillInIntent(R.id.large_row_owner_column, collectionAction(WidgetModel.DETAIL_ACTION, item.optString("id")));
        row.setOnClickFillInIntent(R.id.large_single_detail, collectionAction(WidgetModel.DETAIL_ACTION, item.optString("id")));
        row.setOnClickFillInIntent(R.id.large_row_pick, collectionAction(detailRequired ? WidgetModel.DETAIL_ACTION : PICK, item.optString("id")));
        row.setContentDescription(R.id.large_row_pick, detailRequired ? "进入应用逐件确认领取" : "标记此包裹已取件，可在七秒内撤销");
        return row;
    }
    private static RemoteViews roadRow(Context context, WidgetModel.LargeLayout layout, WidgetModel.RoadOrder order) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_road_row);
        boolean waiting = "待发货".equals(order.status);
        row.setTextViewText(R.id.road_row_status, waiting ? "" : order.status);
        row.setViewVisibility(R.id.road_row_status, waiting ? View.GONE : View.VISIBLE);
        row.setTextColor(R.id.road_row_status, 0xFF738BA5);
        row.setTextViewText(R.id.road_row_platform, order.platformLabel);
        row.setViewVisibility(R.id.road_row_platform, order.platformLabel.isEmpty() ? View.GONE : View.VISIBLE);
        row.setTextViewText(R.id.road_row_title, order.title);
        row.setTextViewText(R.id.road_row_owner, order.owner);
        row.setInt(R.id.road_row_status, "setHeight", dp(context, layout.roadRowHeight - 4));
        textDp(context, row, R.id.road_row_status, layout.textSp - 1);
        textDp(context, row, R.id.road_row_platform, layout.textSp - 1);
        textDp(context, row, R.id.road_row_title, layout.textSp);
        textDp(context, row, R.id.road_row_owner, layout.textSp - 1);
        return row;
    }
    private static void bindCabinet(Context context, RemoteViews views, int viewId, String cabinet) {
        views.setTextViewText(viewId, cabinet);
        views.setViewVisibility(viewId, cabinet.isEmpty() ? View.GONE : View.VISIBLE);
        views.setContentDescription(viewId, cabinet.isEmpty() ? "" : "取件位置 " + cabinet);
        textDp(context, views, viewId, 10);
    }
    private static void textDp(Context context, RemoteViews views, int viewId, float size) {
        views.setTextViewTextSize(viewId, TypedValue.COMPLEX_UNIT_PX, size * context.getResources().getDisplayMetrics().density);
    }
    private static void bindPager(Context context, RemoteViews views, Class<?> provider, int id, boolean road, int page, int pages) {
        int previous = R.id.large_road_previous, next = R.id.large_road_next, number = R.id.large_road_page_number;
        String actionName = LargeWidgetProvider.ROAD_PAGE;
        String description = "代收包裹";
        views.setTextViewText(number, (page + 1) + "/" + pages);
        textDp(context, views, number, 9);
        views.setBoolean(previous, "setEnabled", page > 0);
        views.setBoolean(next, "setEnabled", page + 1 < pages);
        views.setFloat(previous, "setAlpha", page > 0 ? 1f : .35f);
        views.setFloat(next, "setAlpha", page + 1 < pages ? 1f : .35f);
        views.setOnClickPendingIntent(previous, action(context, provider, id, actionName, Integer.toString(Math.max(0, page - 1))));
        views.setOnClickPendingIntent(next, action(context, provider, id, actionName, Integer.toString(Math.min(pages - 1, page + 1))));
        views.setContentDescription(previous, "上一页" + description);
        views.setContentDescription(next, "下一页" + description);
    }
    private static PendingIntent packages(Context context, int widgetId) {
        Intent intent = new Intent().setComponent(new ComponentName(context, WidgetModel.DETAIL_COMPONENT))
                .setAction(WidgetModel.PACKAGES_ACTION).setData(new Uri.Builder().scheme("pickcode").authority("packages").appendPath(Integer.toString(widgetId)).build())
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private static PendingIntent undo(Context context, int widgetId, JSONObject record) {
        Intent intent = new Intent(context, LargeWidgetProvider.class).setAction(LargeWidgetProvider.UNDO)
                .setData(new Uri.Builder().scheme("pickcode").authority("undo").appendPath(Integer.toString(widgetId))
                        .appendPath(record.optString("id")).appendPath(Long.toString(record.optLong("at"))).build())
                .putExtra("itemId", record.optString("id")).putExtra("undoAt", record.optLong("at"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        return PendingIntent.getBroadcast(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private static PendingIntent open(Context context) {
        return PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static PendingIntent copy(Context context, int widgetId, String itemId) {
        Intent intent = new Intent().setComponent(new ComponentName(context, WidgetModel.COPY_COMPONENT))
                .setAction(WidgetModel.COPY_ACTION).setData(new Uri.Builder().scheme("pickcode").authority("copy")
                        .appendPath(Integer.toString(widgetId)).appendPath(itemId).build())
                .putExtra("itemId", itemId).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static PendingIntent detail(Context context, int widgetId, String itemId) {
        Intent intent = new Intent().setComponent(new ComponentName(context, WidgetModel.DETAIL_COMPONENT))
                .setAction(WidgetModel.DETAIL_ACTION).setData(new Uri.Builder().scheme("pickcode").authority("detail")
                        .appendPath(Integer.toString(widgetId)).appendPath(itemId).build())
                .putExtra("itemId", itemId).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private static PendingIntent action(Context context, Class<?> provider, int id, String action, String itemId) {
        Intent intent = new Intent(context, provider).setAction(action)
                .setData(new Uri.Builder().scheme("pickcode").authority("widget").appendPath(provider.getSimpleName())
                        .appendPath(Integer.toString(id)).appendPath(action).appendPath(itemId).build())
                .putExtra("itemId", itemId).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
