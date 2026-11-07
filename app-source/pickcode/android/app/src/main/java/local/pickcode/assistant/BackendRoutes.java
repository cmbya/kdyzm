package local.pickcode.assistant;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Only an address supplied by the bound service may receive device credentials. */
final class BackendRoutes {
    interface Probe { boolean matches(String origin, String serviceId) throws Exception; }
    interface Clock { long millis(); }
    private final boolean development;
    private final Probe probe;
    private final Clock clock;
    private String primary = "", lan = "", identity = "", network = "";
    private long validUntil;
    private boolean reachable;

    BackendRoutes(boolean development) {
        this(development, BackendRoutes::probe, () -> System.nanoTime() / 1_000_000L);
    }
    BackendRoutes(boolean development, Probe probe, Clock clock) {
        this.development = development; this.probe = probe; this.clock = clock;
    }
    synchronized void configure(String bound, String candidate, String serviceId) {
        String nextPrimary = OnlineEndpoint.normalize(bound, development);
        String nextLan = "";
        if (serviceId != null && serviceId.matches("[a-f0-9]{32}") && candidate != null && !candidate.isEmpty()) {
            try { nextLan = OnlineEndpoint.normalize(candidate, development); }
            catch (IllegalArgumentException invalid) { /* A malformed optional route cannot disable the binding. */ }
        }
        if (nextPrimary.equals(nextLan)) nextLan = "";
        if (!nextPrimary.equals(primary) || !nextLan.equals(lan) || !String.valueOf(serviceId).equals(identity)) {
            reachable = false; validUntil = 0; network = "";
        }
        primary = nextPrimary; lan = nextLan; identity = String.valueOf(serviceId);
    }
    synchronized String[] select(String networkKey) {
        if (primary.isEmpty()) return new String[0];
        if (lan.isEmpty()) return new String[]{primary};
        long now = clock.millis();
        if (!String.valueOf(networkKey).equals(network) || now >= validUntil) {
            network = String.valueOf(networkKey);
            try { reachable = probe.matches(lan, identity); }
            catch (Exception unavailable) { reachable = false; }
            validUntil = now + (reachable ? 300_000 : 30_000);
        }
        return reachable ? new String[]{lan, primary} : new String[]{primary};
    }
    synchronized void failed(String origin) {
        if (lan.equals(origin)) { reachable = false; validUntil = clock.millis() + 30_000; }
    }

    static boolean probe(String origin, String serviceId) throws Exception {
        if (CookieHandler.getDefault() != null) return false;
        long deadline = System.nanoTime() + 1_800_000_000L;
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + "/health").openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(900); connection.setReadTimeout(900);
            connection.setUseCaches(false); connection.setAllowUserInteraction(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cookie", ""); connection.setRequestProperty("Authorization", "");
            if (connection.getResponseCode() != 200 || System.nanoTime() > deadline) return false;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream stream = connection.getInputStream()) {
                byte[] buffer = new byte[1024]; int count;
                while ((count = stream.read(buffer)) != -1) {
                    if (bytes.size() + count > 4096 || System.nanoTime() > deadline) return false;
                    bytes.write(buffer, 0, count);
                }
            }
            JSONObject body = OnlineClient.parse(bytes.toString(StandardCharsets.UTF_8.name()));
            return body.optBoolean("ok") && serviceId.equals(body.optString("serviceId"));
        } finally { connection.disconnect(); }
    }
}
