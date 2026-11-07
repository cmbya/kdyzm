package local.pickcode.assistant;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.Image;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.exifinterface.media.ExifInterface;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Only returns recognized text to the trusted WebView; it never opens URLs or exchanges a pairing code. */
public final class PairingScanActivity extends ComponentActivity {
    private static final int CAMERA_PERMISSION = 541, PICK_IMAGE = 542;
    private final ExecutorService images = Executors.newSingleThreadExecutor();
    private final AtomicBoolean analyzing = new AtomicBoolean();
    private BarcodeScanner barcode;
    private TextRecognizer text;
    private ProcessCameraProvider camera;
    private PreviewView preview;
    private TextView hint;
    private Button album;
    private volatile boolean finished;
    private Bitmap selectedBitmap;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(RESULT_CANCELED);
        barcode = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build());
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(20), dp(20), dp(20), dp(20)); layout.setBackgroundColor(0xffe8edf3);
        if (Build.VERSION.SDK_INT >= 35) layout.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
            view.setPadding(dp(20) + bars.left, dp(20) + bars.top, dp(20) + bars.right, dp(20) + bars.bottom); return insets;
        });
        TextView title = new TextView(this); title.setText("识别设备授权"); title.setTextSize(23); title.setTextColor(0xff172233);
        layout.addView(title);
        hint = new TextView(this); hint.setTextSize(14); hint.setTextColor(0xff536073); hint.setPadding(0, dp(12), 0, dp(18));
        hint.setText("对准后台授权二维码。识别后先核验服务与范围，确认才绑定。"); layout.addView(hint);
        preview = new PreviewView(this); preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        album = button("从相册识别二维码 / 文字授权码"); album.setOnClickListener(view -> pickImage()); layout.addView(album);
        Button cancel = button("取消识别"); cancel.setOnClickListener(view -> finish()); layout.addView(cancel);
        setContentView(layout);
        if ("image".equals(getIntent().getStringExtra("source"))) { if (savedInstanceState == null) pickImage(); }
        else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera();
        else requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private Button button(String label) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setTextSize(14);
        button.setTextColor(0xff0867ff); button.setMinHeight(dp(48)); return button;
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == CAMERA_PERMISSION) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startCamera();
            else hint.setText("相机权限未允许。可从相册识别，或返回使用粘贴、手动输入；重新扫码可在系统设置中允许相机。");
        }
    }

    private void startCamera() {
        final ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            if (finished || isDestroyed()) return;
            try {
                camera = future.get();
                Preview live = new Preview.Builder().build(); live.setSurfaceProvider(preview.getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                analysis.setAnalyzer(images, this::analyzeFrame);
                camera.unbindAll(); camera.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, live, analysis);
            } catch (Exception unavailable) { hint.setText("无法打开相机，可从相册识别，或返回手动输入。"); }
        }, ContextCompat.getMainExecutor(this));
    }

    @androidx.annotation.OptIn(markerClass = androidx.camera.core.ExperimentalGetImage.class)
    private void analyzeFrame(ImageProxy frame) {
        if (finished || !analyzing.compareAndSet(false, true)) { frame.close(); return; }
        Image image = frame.getImage();
        if (image == null) { analyzing.set(false); frame.close(); return; }
        try {
            barcode.process(InputImage.fromMediaImage(image, frame.getImageInfo().getRotationDegrees()))
                    .addOnSuccessListener(values -> { if (!values.isEmpty()) completeBarcodes(values, "camera"); })
                    .addOnFailureListener(error -> hint.setText("暂未识别成功，请靠近二维码或使用相册识别。"))
                    .addOnCompleteListener(task -> { analyzing.set(false); frame.close(); });
        } catch (RuntimeException unavailable) { analyzing.set(false); frame.close(); }
    }

    private void pickImage() {
        if (finished) return;
        if (camera != null) camera.unbindAll();
        try {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
            startActivityForResult(pick, PICK_IMAGE);
        } catch (RuntimeException unavailable) { hint.setText("无法打开相册选择器，请返回使用粘贴或手动输入。"); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_IMAGE || finished) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) { hint.setText("已取消图片选择，可重新选择图片或返回。"); return; }
        Uri uri = data.getData();
        if (!"content".equals(uri.getScheme())) { hint.setText("请选择系统相册或文件选择器中的图片。"); return; }
        album.setEnabled(false); hint.setText("正在本机识别图片，不会上传图片…");
        images.execute(() -> {
            try {
                Bitmap bitmap = readBitmap(uri);
                runOnUiThread(() -> { if (finished || isDestroyed()) { bitmap.recycle(); return; } selectedBitmap = bitmap; recognizeImage(bitmap); });
            } catch (Exception | OutOfMemoryError invalid) { runOnUiThread(() -> imageFailed("图片无法读取或过大，请裁剪清晰的二维码 / 授权码后重试。")); }
        });
    }

    private Bitmap readBitmap(Uri uri) throws Exception {
        try (android.content.res.AssetFileDescriptor descriptor = getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (descriptor != null && descriptor.getLength() > 20 * 1024 * 1024) throw new IllegalArgumentException();
        }
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(input, null, options); }
        if (options.outWidth < 1 || options.outHeight < 1 || options.outWidth > 32768 || options.outHeight > 32768) throw new IllegalArgumentException();
        options.inJustDecodeBounds = false; options.inSampleSize = 1; options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 2048) options.inSampleSize *= 2;
        Bitmap bitmap;
        try (InputStream input = getContentResolver().openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(input, null, options); }
        if (bitmap == null) throw new IllegalArgumentException();
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            ExifInterface exif = new ExifInterface(input); Matrix matrix = new Matrix();
            matrix.postRotate(exif.getRotationDegrees()); if (exif.isFlipped()) matrix.postScale(-1, 1);
            if (!matrix.isIdentity()) { Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true); if (rotated != bitmap) bitmap.recycle(); bitmap = rotated; }
        } catch (java.io.IOException unsupportedExif) { /* PNG/screenshots can have no EXIF; decoded pixels remain usable. */ }
        return bitmap;
    }

    private void recognizeImage(Bitmap bitmap) {
        final InputImage image = InputImage.fromBitmap(bitmap, 0);
        barcode.process(image).addOnSuccessListener(values -> {
            if (finished || isDestroyed()) return;
            if (!values.isEmpty()) { completeBarcodes(values, "image-qr"); return; }
            if (text == null) text = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
            text.process(image).addOnSuccessListener(result -> {
                if (result.getText().trim().isEmpty()) imageFailed("没有识别到二维码或文字，请裁剪更清晰的授权图片重试。");
                else complete(new JSONArray().put(result.getText()), "image-text");
            }).addOnFailureListener(error -> imageFailed("文字识别未完成，请重试或返回使用手动输入。"));
        }).addOnFailureListener(error -> imageFailed("二维码识别未完成，请重新选择图片。"));
    }

    private void completeBarcodes(List<Barcode> values, String source) {
        JSONArray texts = new JSONArray();
        for (Barcode value : values) if (value.getRawValue() != null && !value.getRawValue().trim().isEmpty() && texts.length() < 8) texts.put(value.getRawValue());
        if (texts.length() > 0) complete(texts, source);
    }
    private void complete(JSONArray texts, String source) {
        if (finished || isDestroyed()) return;
        for (int i = 0; i < texts.length(); i++) if (texts.optString(i).length() > 8192) { imageFailed("识别内容过长，请只保留一组授权信息后重试。"); return; }
        try {
            finished = true;
            setResult(RESULT_OK, new Intent().putExtra("recognition", new JSONObject().put("texts", texts).put("source", source).toString())); finish();
        } catch (Exception invalid) { finished = false; imageFailed("识别结果无效，请重试。"); }
    }
    private void imageFailed(String message) {
        if (finished || isDestroyed()) return;
        hint.setText(message); album.setEnabled(true);
        if (selectedBitmap != null) { selectedBitmap.recycle(); selectedBitmap = null; }
    }
    @Override protected void onDestroy() {
        finished = true;
        if (camera != null) camera.unbindAll();
        if (barcode != null) barcode.close(); if (text != null) text.close(); images.shutdownNow();
        // ML Kit may still hold the selected bitmap until its completion callback; let GC release it on close.
        selectedBitmap = null;
        super.onDestroy();
    }
}
