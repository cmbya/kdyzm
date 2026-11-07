package local.pickcode.assistant;

import android.content.Context;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

public final class ScanScheduler {
    private static final String PERIODIC = "pickcode-hourly-scan";
    private ScanScheduler() {}
    public static void configure(Context context, boolean enabled) {
        WorkManager manager = WorkManager.getInstance(context);
        if (!enabled) { manager.cancelUniqueWork(PERIODIC); return; }
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(ScanWorker.class, 1, TimeUnit.HOURS,
                15, TimeUnit.MINUTES).addTag(PERIODIC).build();
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request);
    }
    public static void refresh(Context context) {
        WorkManager.getInstance(context).enqueueUniqueWork("pickcode-manual-scan", ExistingWorkPolicy.KEEP,
                new OneTimeWorkRequest.Builder(ScanWorker.class).build());
    }
}
