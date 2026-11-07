package local.pickcode.assistant;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.InterruptedIOException;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Public update assets never share the authenticated sync client; platform TLS verification stays intact. */
final class AppUpdateTransport {
    interface Connections { HttpURLConnection open(URI uri) throws Exception; }
    interface Progress { void bytes(long count); }
    static final class Selection {
        final AppUpdateManifest release;
        final String backendOrigin;
        final String bindingOrigin;
        volatile String source;
        Selection(AppUpdateManifest release, String backendOrigin) {
            this(release, backendOrigin, backendOrigin);
        }
        Selection(AppUpdateManifest release, String backendOrigin, String bindingOrigin) {
            this.release = release;
            this.backendOrigin = backendOrigin;
            this.bindingOrigin = bindingOrigin;
            source = backendOrigin == null ? "github" : "backend";
        }
    }
    static final class Operation {
        private volatile boolean cancelled;
        private HttpURLConnection connection;
        synchronized void attach(HttpURLConnection value) throws InterruptedIOException {
            check(); connection = value;
        }
        synchronized void detach(HttpURLConnection value) { if (connection == value) connection = null; }
        synchronized void cancel() { cancelled = true; if (connection != null) connection.disconnect(); }
        void check() throws InterruptedIOException {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("更新已取消");
        }
        boolean cancelled() { return cancelled; }
    }

    private final Connections connections;
    private final boolean development;
    AppUpdateTransport() { this(uri -> (HttpURLConnection) uri.toURL().openConnection(), BuildConfig.DEBUG); }
    AppUpdateTransport(Connections connections) { this(connections, false); }
    AppUpdateTransport(Connections connections, boolean development) { this.connections = connections; this.development = development; }

    Selection check(String boundOrigin, long currentVersion, int deviceSdk, Operation operation) throws Exception {
        return checkRoutes(boundOrigin == null ? new String[0] : new String[]{boundOrigin}, currentVersion, deviceSdk, operation);
    }
    Selection checkRoutes(String[] origins, long currentVersion, int deviceSdk, Operation operation) throws Exception {
        Selection backend = null;
        String binding = origins.length == 0 ? null : origins[origins.length - 1];
        for (String boundOrigin : origins) {
            try {
                String origin = OnlineEndpoint.normalize(boundOrigin, development);
                backend = new Selection(check(origin + "/app-updates/app-update.json", false, operation), origin,
                        OnlineEndpoint.normalize(binding, development));
                if (!backend.release.availability(currentVersion, deviceSdk).equals("current")) return backend;
            } catch (Exception unavailable) { operation.check(); }
        }
        try { return new Selection(check(operation), null); }
        catch (Exception unavailable) {
            operation.check();
            if (backend != null) return backend;
            throw unavailable;
        }
    }

    AppUpdateManifest check(Operation operation) throws Exception {
        return check(AppUpdateManifest.ENDPOINT, true, operation);
    }

    private AppUpdateManifest check(String endpoint, boolean github, Operation operation) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        fetch(endpoint, github, AppUpdateManifest.MAX_MANIFEST_BYTES, -1, null, bytes, operation, count -> {}, 60_000);
        return AppUpdateManifest.parse(bytes.toString(StandardCharsets.UTF_8.name()));
    }

    void download(AppUpdateManifest release, OutputStream destination, Operation operation, Progress progress) throws Exception {
        fetch(release.apkUrl, true, release.size, release.size, release.sha256, destination, operation, progress, 600_000);
    }

    void download(Selection selected, File destination, String currentBackendOrigin, Operation operation, Progress progress) throws Exception {
        downloadRoutes(selected, destination, currentBackendOrigin == null ? new String[0] : new String[]{currentBackendOrigin}, operation, progress);
    }
    void downloadRoutes(Selection selected, File destination, String[] currentOrigins, Operation operation, Progress progress) throws Exception {
        boolean completed = false;
        try {
            operation.check();
            String currentBinding = currentOrigins.length == 0 ? null : currentOrigins[currentOrigins.length - 1];
            if (selected.source.equals("backend") && sameBackend(selected.bindingOrigin, currentBinding)) for (String candidate : currentOrigins) {
                try {
                    String origin = OnlineEndpoint.normalize(candidate, development);
                    downloadFile(selected.release, origin + "/app-updates/PickCode-private-" + selected.release.versionName + ".apk",
                            false, destination, operation, progress);
                    completed = true;
                    return;
                } catch (Exception unavailable) {
                    operation.check();
                    removePartial(destination);
                    progress.bytes(0);
                }
            }
            operation.check();
            selected.source = "github";
            progress.bytes(0);
            downloadFile(selected.release, selected.release.apkUrl, true, destination, operation, progress);
            completed = true;
        } finally {
            if (!completed) removePartial(destination);
        }
    }

    private boolean sameBackend(String expected, String current) {
        try { return expected != null && expected.equals(OnlineEndpoint.normalize(current, development)); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private void downloadFile(AppUpdateManifest release, String url, boolean github, File destination,
                              Operation operation, Progress progress) throws Exception {
        // Each source starts with an empty file; bytes from different responses are never combined.
        try (FileOutputStream output = new FileOutputStream(destination, false)) {
            fetch(url, github, release.size, release.size, release.sha256, output, operation, progress, 600_000);
            output.getFD().sync();
        }
    }

    private static void removePartial(File file) throws AppUpdateManifest.Failure {
        if (file.exists() && !file.delete()) throw new AppUpdateManifest.Failure("无法清理更新缓存，请重启应用后重试");
    }

    private void fetch(String initial, boolean github, long limit, long exactSize, String hash, OutputStream destination,
                       Operation operation, Progress progress, long budgetMillis) throws Exception {
        URI uri = github ? AppUpdateManifest.validateUrl(initial, false) : new URI(initial);
        long deadline = System.nanoTime() + budgetMillis * 1_000_000L;
        // A process-wide cookie handler could silently add credentials to an otherwise public request.
        if (CookieHandler.getDefault() != null) throw new AppUpdateManifest.Failure("当前网络环境无法安全检查更新，请重启应用后重试");
        for (int redirects = 0; redirects <= 5; redirects++) {
            checkDeadline(operation, deadline);
            HttpURLConnection connection = connections.open(uri);
            try {
                operation.attach(connection);
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(15_000);
                connection.setAllowUserInteraction(false);
                connection.setUseCaches(false);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept", "application/octet-stream, application/json");
                connection.setRequestProperty("Accept-Encoding", "identity");
                connection.setRequestProperty("Cookie", "");
                connection.setRequestProperty("Cookie2", "");
                connection.setRequestProperty("Authorization", "");
                connection.setRequestProperty("Proxy-Authorization", "");
                int status = connection.getResponseCode();
                checkDeadline(operation, deadline);
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    if (!github) throw new AppUpdateManifest.Failure("后台更新地址发生跳转，请稍后重试");
                    if (redirects == 5) throw new AppUpdateManifest.Failure("更新下载跳转过多，请稍后重试");
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new AppUpdateManifest.Failure("更新服务暂不可用，请稍后重试");
                    // Validate the unresolved form as well so traversal is never hidden by URI.resolve().
                    String pathOnly = location.split("\\?", 2)[0];
                    if (pathOnly.contains("%") || pathOnly.contains("..") || location.matches(".*[\\x00-\\x20\\x7f\\\\].*"))
                        throw new AppUpdateManifest.Failure("更新地址未通过安全检查，请稍后重试");
                    uri = AppUpdateManifest.validateUrl(uri.resolve(location).toString(), true);
                    continue;
                }
                if (status != 200) throw new AppUpdateManifest.Failure("更新服务暂不可用，请检查网络后重试");
                String encoding = connection.getHeaderField("Content-Encoding");
                if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw new AppUpdateManifest.Failure("更新下载格式无效，请重试");
                String declaredLength = connection.getHeaderField("Content-Length");
                long length = declaredLength == null ? -1 : Long.parseLong(declaredLength);
                if (length > limit || (exactSize >= 0 && length >= 0 && length != exactSize)) throw sizeError();
                try (InputStream source = connection.getInputStream()) {
                    copy(source, destination, limit, exactSize, hash, operation, progress, deadline);
                }
                return;
            } finally { operation.detach(connection); connection.disconnect(); }
        }
    }

    static void verify(InputStream source, long size, String sha256, Operation operation) throws Exception {
        copy(source, null, size, size, sha256, operation, count -> {}, System.nanoTime() + 120_000_000_000L);
    }

    static void copy(InputStream source, OutputStream destination, long limit, long exactSize, String hash,
                     Operation operation, Progress progress, long deadline) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32 * 1024];
        long count = 0;
        for (;;) {
            checkDeadline(operation, deadline);
            int read = source.read(buffer);
            if (read == -1) break;
            if (count + read > limit) throw sizeError();
            checkDeadline(operation, deadline);
            if (destination != null) destination.write(buffer, 0, read);
            digest.update(buffer, 0, read);
            count += read;
            progress.bytes(count);
        }
        checkDeadline(operation, deadline);
        if (exactSize >= 0 && count != exactSize) throw sizeError();
        if (hash != null && !hash.equals(AppUpdateManifest.hex(digest.digest())))
            throw new AppUpdateManifest.Failure("安装包校验失败，请重新下载");
    }

    private static void checkDeadline(Operation operation, long deadline) throws Exception {
        operation.check();
        if (System.nanoTime() > deadline) throw new AppUpdateManifest.Failure("更新连接超时，请检查网络后重试");
    }
    private static AppUpdateManifest.Failure sizeError() { return new AppUpdateManifest.Failure("安装包大小不符，请重新下载"); }
}
