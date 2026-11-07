package local.pickcode.assistant;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

public final class OnlineSyncScheduler {
    private static final String PERIODIC = "pickcode-hourly-online";
    private static final String REFRESH = "pickcode-refresh-online";
    private static final String ENHANCEMENT = "pickcode-station-enhancement";
    private static final String ENHANCEMENT_PERIODIC = "pickcode-station-periodic";
    private static final String ENHANCEMENT_FOLLOWUP = "pickcode-station-followup";
    private OnlineSyncScheduler() {}
    private static Constraints network() { return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(); }
    public static void configure(Context context, boolean bound) {
        WorkManager manager = WorkManager.getInstance(context);
        if (!bound) { manager.cancelUniqueWork(PERIODIC); manager.cancelUniqueWork(REFRESH); cancelEnhancement(context); return; }
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(OnlineSyncWorker.class, 1, TimeUnit.HOURS, 15, TimeUnit.MINUTES)
                        .setConstraints(network()).build());
    }
    public static void refresh(Context context, boolean force) {
        if (!SecretStore.online(context).configured()) return;
        WorkManager.getInstance(context).enqueueUniqueWork(REFRESH, ExistingWorkPolicy.KEEP,
                new OneTimeWorkRequest.Builder(OnlineSyncWorker.class).setConstraints(network())
                        .setInputData(new Data.Builder().putBoolean("force", force).build()).build());
    }
    /** Scanning queues constrained work only; it never waits for a credential or HTTP request. */
    public static void maybeEnhance(Context context, JSONObject snapshot) {
        String session = configureEnhancement(context, snapshot);
        JSONObject enhancement = snapshot == null ? null : snapshot.optJSONObject("stationEnhancement");
        JSONObject feedback = snapshot == null ? null : snapshot.optJSONObject("matchingFeedback");
        boolean stationPending = OnlineSyncManager.stationCandidatesEnabled(snapshot) && enhancement != null && enhancement.optInt("pendingCount") > 0;
        boolean feedbackPending = OnlineSyncManager.matchingFeedbackEnabled(snapshot) && feedback != null
                && (feedback.optInt("pendingCount") > 0 || feedback.optInt("pendingWithdrawalCount") > 0);
        if (session.isEmpty() || !stationPending && !feedbackPending) return;
        WorkManager.getInstance(context).enqueueUniqueWork(ENHANCEMENT, ExistingWorkPolicy.KEEP,
                new OneTimeWorkRequest.Builder(OnlineSyncWorker.class).setConstraints(network()).setInputData(stationSession(session)).build());
    }
    static String configureEnhancement(Context context, JSONObject snapshot) {
        if (!SecretStore.online(context).configured() || !OnlineSyncManager.enhancementEnabled(snapshot)) {
            cancelEnhancement(context); return "";
        }
        String session = OnlineSyncManager.get(context).scheduledSessionKey();
        if (session.isEmpty()) { cancelEnhancement(context); return ""; }
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(ENHANCEMENT_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE,
                new PeriodicWorkRequest.Builder(OnlineSyncWorker.class, 15, TimeUnit.MINUTES)
                        .setInitialDelay(15, TimeUnit.MINUTES).setConstraints(network()).setInputData(stationSession(session)).build());
        return session;
    }
    static void followupEnhancement(Context context, String session) {
        if (session == null || session.isEmpty()) return;
        WorkManager.getInstance(context).enqueueUniqueWork(ENHANCEMENT_FOLLOWUP, ExistingWorkPolicy.REPLACE,
                new OneTimeWorkRequest.Builder(OnlineSyncWorker.class).setInitialDelay(30, TimeUnit.SECONDS)
                        .setConstraints(network()).setInputData(stationSession(session)).build());
    }
    static void cancelEnhancement(Context context) {
        WorkManager manager = WorkManager.getInstance(context);
        manager.cancelUniqueWork(ENHANCEMENT); manager.cancelUniqueWork(ENHANCEMENT_PERIODIC); manager.cancelUniqueWork(ENHANCEMENT_FOLLOWUP);
    }
    private static Data stationSession(String session) { return new Data.Builder().putString("stationSession", session).build(); }
}
