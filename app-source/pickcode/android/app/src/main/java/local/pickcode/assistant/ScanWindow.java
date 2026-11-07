package local.pickcode.assistant;

public final class ScanWindow {
    public static final long HOUR = 60L * 60 * 1000;
    public static final long INITIAL_HISTORY = 4 * 24 * HOUR;
    public static final long RECOVERY_OVERLAP = 24 * HOUR;
    private ScanWindow() {}
    public static long from(long lastSuccess, long now) {
        return Math.max(0, lastSuccess <= 0 ? now - INITIAL_HISTORY
                : Math.min(lastSuccess, now) - RECOVERY_OVERLAP);
    }
    public static boolean due(long lastSuccess, long now) {
        return lastSuccess <= 0 || now - lastSuccess >= HOUR || lastSuccess > now;
    }
}
