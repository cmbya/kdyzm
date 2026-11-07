package local.pickcode.assistant;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public final class ScanWorker extends Worker {
    public ScanWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        try {
            if (!SmsScanner.allowed(context)) { WidgetRenderer.updateAll(context); return Result.success(); }
            if (getTags().contains("pickcode-hourly-scan")
                    && !AssistantStore.get(context).snapshot().getJSONObject("settings").optBoolean("autoScan"))
                return Result.success();
            if (isStopped()) return Result.retry();
            SmsScanner.scan(context, this::isStopped);
            return Result.success();
        } catch (SecurityException denied) { return Result.success(); }
        catch (Exception failure) { return getRunAttemptCount() < 3 ? Result.retry() : Result.failure(); }
    }
}
