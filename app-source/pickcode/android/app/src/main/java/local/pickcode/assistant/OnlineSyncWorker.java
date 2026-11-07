package local.pickcode.assistant;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;

/** Online sync remains available when SMS permission or automatic SMS scanning is disabled. */
public final class OnlineSyncWorker extends Worker {
    public OnlineSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    @NonNull @Override public Result doWork() {
        if (isStopped()) return Result.retry();
        try {
            OnlineSyncManager manager = OnlineSyncManager.get(getApplicationContext());
            String session = getInputData().getString("stationSession");
            JSONObject snapshot = session == null ? manager.sync(getInputData().getBoolean("force", false)) : manager.syncStationEnhancement(session);
            JSONObject online = snapshot.optJSONObject("online");
            String code = online == null ? "" : online.optString("errorCode");
            if (("network_error".equals(code) || "server_error".equals(code) || "rate_limited".equals(code)) && getRunAttemptCount() < 3)
                return Result.retry();
            return Result.success();
        } catch (Exception unavailable) { return getRunAttemptCount() < 3 ? Result.retry() : Result.failure(); }
    }
}
