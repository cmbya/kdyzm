package local.pickcode.assistant;

import android.app.Activity;
import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Process-local ownership keeps downloads independent of WebView and SMS worker lifetimes. */
final class AppUpdateManager {
    @SuppressLint("StaticFieldLeak") // Construction retains only the application context, never an activity.
    private static AppUpdateManager instance;
    static synchronized AppUpdateManager get(Context context) {
        if (instance == null) instance = new AppUpdateManager(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler foreground = new Handler(Looper.getMainLooper());
    private final AppUpdateTransport transport = new AppUpdateTransport();
    private final File directory, partialFile, readyFile;
    private AppUpdateTransport.Operation active;
    private AppUpdateManifest release, readyRelease;
    private AppUpdateTransport.Selection selected;
    private String state = "idle", error = "";
    private long downloadedBytes, totalBytes;

    private AppUpdateManager(Context context) {
        this.context = context;
        directory = new File(context.getCacheDir(), "updates");
        partialFile = new File(directory, "update.apk.part");
        readyFile = new File(directory, "update.apk");
        // A killed process never resumes an unverified partial package.
        worker.execute(() -> { if (partialFile.exists()) partialFile.delete(); });
    }

    synchronized JSONObject status() throws Exception {
        int progress = totalBytes == 0 ? 0 : (int) Math.min(100, downloadedBytes * 100 / totalBytes);
        return new JSONObject().put("native", true).put("currentVersionName", BuildConfig.VERSION_NAME)
                .put("currentVersionCode", BuildConfig.VERSION_CODE).put("state", state).put("progress", progress)
                .put("downloadedBytes", downloadedBytes).put("totalBytes", totalBytes)
                .put("release", release == null ? JSONObject.NULL : release.publicJson()).put("error", error)
                .put("source", selected == null ? "" : selected.source)
                .put("installing", active != null && state.equals("ready"))
                .put("canInstall", state.equals("ready") && installPermissionGranted());
    }

    synchronized JSONObject check() throws Exception {
        if (active != null) return status();
        AppUpdateTransport.Operation operation = begin("checking");
        worker.execute(() -> {
            try {
                AppUpdateTransport.Selection selection = transport.checkRoutes(OnlineSyncManager.get(context).appUpdateOrigins(),
                        BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT, operation);
                AppUpdateManifest candidate = selection.release;
                String next = candidate.availability(BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT);
                boolean cached = false;
                if (next.equals("available") && readyFile.isFile()) {
                    try { validatePackage(candidate, readyFile, operation); cached = true; }
                    catch (Exception invalidCache) { discardReady(operation); }
                } else if (!next.equals("available")) discardReady(operation);
                operation.check();
                synchronized (this) {
                    if (!owns(operation)) return;
                    release = candidate;
                    selected = selection;
                    readyRelease = cached ? candidate : null;
                    state = cached ? "ready" : next;
                    totalBytes = candidate.size;
                    downloadedBytes = cached ? candidate.size : 0;
                    error = next.equals("unsupported") ? "新版本需要更高版本的 Android，当前设备暂不支持" : "";
                    active = null;
                }
            } catch (Exception failure) { failed(operation, failure, "检查更新失败，请检查网络后重试"); }
        });
        return status();
    }

    synchronized JSONObject download() throws Exception {
        if (active != null || release == null || !release.availability(BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT).equals("available")) return status();
        AppUpdateManifest candidate = release;
        AppUpdateTransport.Selection selection = selected;
        AppUpdateTransport.Operation operation = begin("downloading");
        downloadedBytes = 0;
        totalBytes = candidate.size;
        worker.execute(() -> {
            boolean completed = false;
            try {
                if (!directory.isDirectory() && !directory.mkdirs()) throw new AppUpdateManifest.Failure("无法创建更新缓存，请检查剩余空间");
                remove(partialFile);
                boolean cached = false;
                if (readyFile.isFile()) {
                    try { validatePackage(candidate, readyFile, operation); cached = true; }
                    catch (Exception invalidCache) { discardReady(operation); }
                }
                if (!cached) {
                    synchronized (this) { if (owns(operation)) readyRelease = null; }
                    if (directory.getUsableSpace() < candidate.size + 5L * 1024 * 1024)
                        throw new AppUpdateManifest.Failure("剩余空间不足，请清理空间后重试");
                    transport.downloadRoutes(selection, partialFile, OnlineSyncManager.get(context).appUpdateOrigins(), operation, count -> {
                        synchronized (this) { if (owns(operation)) downloadedBytes = count; }
                    });
                    validatePackage(candidate, partialFile, operation);
                    operation.check();
                    if (!partialFile.renameTo(readyFile)) throw new AppUpdateManifest.Failure("无法保存更新包，请重新下载");
                }
                synchronized (this) {
                    if (!owns(operation)) return;
                    readyRelease = candidate;
                    downloadedBytes = candidate.size;
                    state = "ready";
                    active = null;
                    completed = true;
                }
            } catch (Exception failure) { failed(operation, failure, "下载更新失败，请检查网络与剩余空间后重试"); }
            finally {
                if (partialFile.exists()) partialFile.delete();
                if (!completed) {
                    // A cancel between rename and publication must not leave an installable result.
                    synchronized (this) {
                        if (readyRelease == null && readyFile.exists()) readyFile.delete();
                    }
                }
            }
        });
        return status();
    }

    JSONObject cancel() throws Exception {
        AppUpdateTransport.Operation operation;
        JSONObject result;
        synchronized (this) {
            operation = active;
            active = null;
            state = baseState();
            error = "";
            downloadedBytes = state.equals("ready") && release != null ? release.size : 0;
            result = status();
        }
        if (operation != null) operation.cancel();
        return result;
    }

    synchronized JSONObject install(Activity activity) throws Exception {
        if (active != null || !state.equals("ready") || release == null || !release.sameArtifact(readyRelease)) return status();
        AppUpdateManifest candidate = release;
        AppUpdateTransport.Operation operation = begin("ready");
        WeakReference<Activity> caller = new WeakReference<>(activity);
        worker.execute(() -> {
            try {
                validatePackage(candidate, readyFile, operation);
                operation.check();
                foreground.post(() -> launchInstaller(caller, operation));
            } catch (Exception failure) {
                try { discardReady(operation); } catch (Exception ignored) { /* Retain the validation error. */ }
                failed(operation, failure, "安装包校验失败，请重新下载");
            }
        });
        return status();
    }

    private synchronized void launchInstaller(WeakReference<Activity> caller, AppUpdateTransport.Operation operation) {
        if (!owns(operation)) return;
        Activity activity = caller.get();
        try {
            if (!(activity instanceof MainActivity) || !((MainActivity) activity).canPresentUpdateInstaller()) {
                error = "请返回更新页面，再次点击安装";
                return;
            }
            if (!installPermissionGranted()) {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())));
            } else {
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".app-update", readyFile);
                Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.setClipData(ClipData.newRawUri("应用更新", uri));
                activity.startActivity(intent);
            }
            // Launching system UI is not an installation result; only the installed version on restart is authoritative.
        } catch (Exception failure) { error = "无法打开系统安装界面，请检查系统设置后重试"; }
        finally { active = null; }
    }

    private void validatePackage(AppUpdateManifest candidate, File apk, AppUpdateTransport.Operation operation) throws Exception {
        operation.check();
        if (!apk.isFile() || apk.length() != candidate.size) throw new AppUpdateManifest.Failure("安装包不完整，请重新下载");
        try (FileInputStream source = new FileInputStream(apk)) { AppUpdateTransport.verify(source, candidate.size, candidate.sha256, operation); }
        PackageManager packages = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = packages.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = packages.getPackageInfo(context.getPackageName(), flags);
        if (archive == null || installed == null || !AppUpdateManifest.PACKAGE_NAME.equals(installed.packageName) || archive.applicationInfo == null
                || installed.versionName == null || installed.versionName.isEmpty()
                || !candidate.acceptsArchive(archive.packageName, versionCode(archive), archive.versionName, versionCode(installed), signers(installed), signers(archive))
                || !candidate.availability(versionCode(installed), Build.VERSION.SDK_INT).equals("available")
                || (Build.VERSION.SDK_INT >= 24 && archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT))
            throw new AppUpdateManifest.Failure("安装包版本或签名不匹配，已拒绝安装，请重新下载官方更新");
        operation.check();
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo value) { return Build.VERSION.SDK_INT >= 28 ? value.getLongVersionCode() : value.versionCode; }

    @SuppressWarnings("deprecation")
    private static byte[][] signers(PackageInfo value) {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
                ? value.signingInfo == null ? null : value.signingInfo.getApkContentsSigners() : value.signatures;
        if (signatures == null) return null;
        byte[][] bytes = new byte[signatures.length][];
        for (int index = 0; index < signatures.length; index++) bytes[index] = signatures[index] == null ? null : signatures[index].toByteArray();
        return bytes;
    }

    private boolean installPermissionGranted() { return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls(); }
    private AppUpdateTransport.Operation begin(String next) {
        state = next;
        error = "";
        active = new AppUpdateTransport.Operation();
        return active;
    }
    private boolean owns(AppUpdateTransport.Operation operation) { return active == operation && !operation.cancelled(); }
    private String baseState() {
        if (release == null) return "idle";
        if (release.sameArtifact(readyRelease)) return "ready";
        return release.availability(BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT);
    }
    private synchronized void failed(AppUpdateTransport.Operation operation, Exception failure, String fallback) {
        if (!owns(operation)) return;
        if (release != null && !release.availability(BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT).equals("available")) {
            release = null;
            selected = null;
            readyRelease = null;
            downloadedBytes = 0;
            totalBytes = 0;
        }
        state = "error";
        error = failure instanceof AppUpdateManifest.Failure ? failure.getMessage() : fallback;
        active = null;
    }
    private void discardReady(AppUpdateTransport.Operation operation) throws Exception {
        synchronized (this) {
            operation.check();
            if (!owns(operation)) throw new java.io.InterruptedIOException("更新已取消");
            readyRelease = null;
        }
        remove(readyFile);
    }
    private static void remove(File file) throws AppUpdateManifest.Failure {
        if (file.exists() && !file.delete()) throw new AppUpdateManifest.Failure("无法清理更新缓存，请重启应用后重试");
    }
}
