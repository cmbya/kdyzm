package local.pickcode.assistant;

import android.app.Application;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PickCodeApplication extends Application {
    // Serialized local actions, while network generation has a separate queue in the activity.
    public static final ExecutorService IO = Executors.newSingleThreadExecutor();
    @Override public void onCreate() {
        super.onCreate();
        IO.execute(() -> {
            try {
                AssistantStore.get(this).displaySnapshot();
            } catch (Exception ignored) { /* The activity presents storage failures to the user. */ }
        });
    }
}
