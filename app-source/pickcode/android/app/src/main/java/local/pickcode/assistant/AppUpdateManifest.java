package local.pickcode.assistant;

import org.json.JSONObject;
import org.json.JSONTokener;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/** The release manifest is untrusted input, including when served by the release repository. */
final class AppUpdateManifest {
    static final String PACKAGE_NAME = "local.pickcode.assistant";
    static final String ENDPOINT = "https://github.com/zsdd2/kdyzm/releases/latest/download/app-update.json";
    static final int MAX_MANIFEST_BYTES = 64 * 1024;
    static final long MAX_APK_BYTES = 80L * 1024 * 1024;
    private static final String VERSION = "(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})";
    private static final Set<String> FIELDS = new HashSet<>(Arrays.asList("schemaVersion", "packageName", "versionName",
            "versionCode", "minSdk", "tag", "apkUrl", "sha256", "size", "notes", "publishedAt"));
    final String versionName, tag, apkUrl, sha256, notes, publishedAt;
    final int versionCode, minSdk;
    final long size;

    static final class Failure extends Exception {
        Failure(String message) { super(message); }
    }

    private AppUpdateManifest(JSONObject data) throws Exception {
        if (data.length() != FIELDS.size()) throw invalid();
        for (java.util.Iterator<String> keys = data.keys(); keys.hasNext();) if (!FIELDS.contains(keys.next())) throw invalid();
        if (number(data, "schemaVersion", 1, 1) != 1 || !PACKAGE_NAME.equals(string(data, "packageName"))) throw invalid();
        versionName = string(data, "versionName");
        versionCode = (int) number(data, "versionCode", 1, Integer.MAX_VALUE);
        minSdk = (int) number(data, "minSdk", 1, 100);
        tag = string(data, "tag");
        apkUrl = string(data, "apkUrl");
        sha256 = string(data, "sha256");
        size = number(data, "size", 1, MAX_APK_BYTES);
        notes = string(data, "notes");
        publishedAt = string(data, "publishedAt");
        if (!versionName.matches(VERSION) || !tag.equals("app-v" + versionName)
                || !apkUrl.equals("https://github.com/zsdd2/kdyzm/releases/download/" + tag + "/PickCode-private-" + versionName + ".apk")
                || !sha256.matches("[0-9a-f]{64}") || notes.length() > 8000 || !validDate(publishedAt)) throw invalid();
        validateUrl(apkUrl, false);
    }

    static AppUpdateManifest parse(String raw) throws Failure {
        try {
            if (raw == null || raw.getBytes(StandardCharsets.UTF_8).length > MAX_MANIFEST_BYTES) throw invalid();
            JSONTokener parser = new JSONTokener(raw);
            Object value = parser.nextValue();
            if (!(value instanceof JSONObject) || parser.nextClean() != 0) throw invalid();
            return new AppUpdateManifest((JSONObject) value);
        } catch (Exception malformed) { throw invalid(); }
    }

    JSONObject publicJson() throws Exception {
        return new JSONObject().put("versionName", versionName).put("versionCode", versionCode).put("notes", notes)
                .put("size", size).put("publishedAt", publishedAt).put("tag", tag);
    }

    String availability(long currentVersion, int deviceSdk) {
        if (versionCode <= currentVersion) return "current";
        return minSdk > deviceSdk ? "unsupported" : "available";
    }

    boolean sameArtifact(AppUpdateManifest other) {
        return other != null && versionCode == other.versionCode && versionName.equals(other.versionName)
                && sha256.equals(other.sha256) && size == other.size;
    }

    boolean acceptsArchive(String archivePackage, long archiveCode, String archiveVersion, long installedCode,
                           byte[][] installedSigners, byte[][] archiveSigners) {
        return PACKAGE_NAME.equals(archivePackage) && versionCode == archiveCode && versionName.equals(archiveVersion)
                && installedCode > 0 && archiveCode > installedCode && sameSigners(installedSigners, archiveSigners);
    }

    static URI validateUrl(String raw, boolean redirect) throws Failure {
        try {
            if (raw == null || raw.length() > 8192 || raw.matches(".*[\\x00-\\x20\\x7f\\\\].*")) throw invalid();
            URI uri = new URI(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getPort() != -1 || uri.getRawFragment() != null) throw invalid();
            String host = uri.getHost().toLowerCase(Locale.ROOT), path = uri.getRawPath();
            if (path == null || !path.matches("/[A-Za-z0-9_./-]+") || path.contains("//")) throw invalid();
            for (String part : path.split("/")) if (part.equals(".") || part.equals("..")) throw invalid();
            if (host.equals("github.com")) {
                if (uri.getRawQuery() != null) throw invalid();
                if (path.equals("/zsdd2/kdyzm/releases/latest/download/app-update.json")) return uri;
                String prefix = "/zsdd2/kdyzm/releases/download/app-v";
                if (!path.startsWith(prefix)) throw invalid();
                String[] parts = path.substring(prefix.length()).split("/", -1);
                if (parts.length != 2 || !parts[0].matches(VERSION)) throw invalid();
                if (parts[1].equals("PickCode-private-" + parts[0] + ".apk") || (redirect && parts[1].equals("app-update.json"))) return uri;
            } else if (redirect && (host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com"))
                    && path.matches("/github-production-release-asset(?:-[A-Za-z0-9]+)?/[A-Za-z0-9_./-]+")) return uri;
            throw invalid();
        } catch (Exception malformed) { throw new Failure("更新地址未通过安全检查，请稍后重试"); }
    }

    static boolean sameSigners(byte[][] installed, byte[][] archive) {
        Set<String> left = signerSet(installed), right = signerSet(archive);
        return left != null && right != null && left.equals(right);
    }

    private static Set<String> signerSet(byte[][] values) {
        if (values == null || values.length == 0) return null;
        Set<String> result = new HashSet<>();
        for (byte[] value : values) {
            if (value == null || value.length == 0) return null;
            result.add(hex(value));
        }
        return result;
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    private static String string(JSONObject data, String key) throws Exception {
        Object value = data.get(key);
        if (!(value instanceof String)) throw invalid();
        return (String) value;
    }

    private static long number(JSONObject data, String key, long min, long max) throws Exception {
        Object value = data.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw invalid();
        long number = ((Number) value).longValue();
        if (number < min || number > max) throw invalid();
        return number;
    }

    private static boolean validDate(String value) {
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-](?:0[0-9]|1[0-4]):[0-5][0-9])")) return false;
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        format.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        return format.parse(value.substring(0, 19), position) != null && position.getIndex() == 19;
    }

    private static Failure invalid() { return new Failure("更新信息无效，请稍后重试"); }
}
