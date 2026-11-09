package local.pickcode.assistant;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

final class PickupShareImage {
    static final int MAX_PNG_BYTES = 1_350_000;
    static final int MAX_DATA_URL_LENGTH = 1_800_022;
    private static final String PREFIX = "data:image/png;base64,";
    private static final byte[] PNG_SIGNATURE = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};

    private PickupShareImage() {}

    static byte[] decode(JSONObject payload) {
        if (payload.length() != 1 || !(payload.opt("dataUrl") instanceof String)) throw invalid();
        String value = payload.optString("dataUrl");
        if (value.length() > MAX_DATA_URL_LENGTH || !value.startsWith(PREFIX)) throw invalid();
        String encoded = value.substring(PREFIX.length());
        if (encoded.isEmpty() || encoded.length() % 4 != 0) throw invalid();
        for (int i = 0; i < encoded.length(); i++) {
            char c = encoded.charAt(i);
            if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9')
                    && c != '+' && c != '/' && !(c == '=' && i >= encoded.length() - 2)) throw invalid();
        }
        byte[] png;
        try { png = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException malformed) { throw invalid(); }
        if (png.length > MAX_PNG_BYTES || png.length < 57 || !Arrays.equals(PNG_SIGNATURE, Arrays.copyOf(png, 8))) throw invalid();
        validateChunks(png);
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(png, 0, png.length, options);
        if (!"image/png".equals(options.outMimeType) || options.outWidth != 960 || options.outHeight < 1
                || options.outHeight > 12000 || (long) options.outWidth * options.outHeight > 12_000_000) throw invalid();
        validateDeflate(png, (long) options.outWidth * options.outHeight * 8 + options.outHeight * 8L);
        // Decode only a small sample to reject corrupt image data without allocating the full long image.
        options.inJustDecodeBounds = false;
        options.inSampleSize = 1;
        while (options.outHeight / options.inSampleSize > 1024) options.inSampleSize *= 2;
        Bitmap sample = BitmapFactory.decodeByteArray(png, 0, png.length, options);
        if (sample == null) throw invalid();
        sample.recycle();
        return png;
    }

    private static void validateChunks(byte[] png) {
        boolean imageData = false;
        for (int offset = 8; offset <= png.length - 12;) {
            int length = number(png, offset), type = number(png, offset + 4);
            if (length < 0 || length > png.length - offset - 12) throw invalid();
            if (offset == 8 && (type != 0x49484452 || length != 13)) throw invalid();
            CRC32 crc = new CRC32(); crc.update(png, offset + 4, length + 4);
            if ((int) crc.getValue() != number(png, offset + length + 8)) throw invalid();
            if (type == 0x49444154 && length > 0) imageData = true;
            offset += length + 12;
            if (type == 0x49454e44) {
                if (length != 0 || offset != png.length || !imageData) throw invalid();
                return;
            }
        }
        throw invalid();
    }

    private static int number(byte[] value, int offset) {
        return (value[offset] & 255) << 24 | (value[offset + 1] & 255) << 16
                | (value[offset + 2] & 255) << 8 | (value[offset + 3] & 255);
    }

    private static void validateDeflate(byte[] png, long maxInflated) {
        Inflater inflater = new Inflater();
        byte[] buffer = new byte[8192];
        long total = 0;
        try {
            for (int offset = 8; offset < png.length;) {
                int length = number(png, offset);
                if (number(png, offset + 4) == 0x49444154 && length > 0) {
                    if (inflater.finished()) throw invalid();
                    inflater.setInput(png, offset + 8, length);
                    while (!inflater.needsInput() && !inflater.finished()) {
                        int count = inflater.inflate(buffer);
                        total += count;
                        if (total > maxInflated || (count == 0 && !inflater.finished() && !inflater.needsInput())) throw invalid();
                    }
                    if (inflater.finished() && inflater.getRemaining() != 0) throw invalid();
                }
                offset += length + 12;
            }
            if (!inflater.finished()) throw invalid();
        } catch (DataFormatException malformed) { throw invalid(); }
        finally { inflater.end(); }
    }

    private static IllegalArgumentException invalid() { return new IllegalArgumentException("取件长图无效或过大，请减少勾选后重新生成"); }

    static File cache(Context context, byte[] png) throws IOException {
        File directory = new File(context.getCacheDir(), "pickup-share");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法准备图片缓存");
        File[] previous = directory.listFiles();
        long expired = System.currentTimeMillis() - 24 * 60 * 60 * 1000L;
        if (previous != null) for (File file : previous)
            if (file.isFile() && file.getName().startsWith("pickup-") && file.getName().endsWith(".png") && file.lastModified() < expired) file.delete();
        File file = File.createTempFile("pickup-", ".png", directory);
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(png); }
        catch (IOException failure) { file.delete(); throw failure; }
        return file;
    }

    static Intent share(Context context, File file) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".pickup-share", file);
        Intent send = new Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri("取件清单", uri));
        return send;
    }

    static Intent saveIntent() {
        return new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/png").putExtra(Intent.EXTRA_TITLE, "取件清单.png");
    }

    static void save(Context context, File file, Uri destination) throws IOException {
        if (destination == null || !"content".equals(destination.getScheme()) || destination.getAuthority() == null
                || destination.getAuthority().startsWith(context.getPackageName() + ".")) throw new IOException("请使用系统文件选择器保存图片");
        try (FileInputStream input = new FileInputStream(file);
             OutputStream output = context.getContentResolver().openOutputStream(destination, "wt")) {
            if (output == null) throw new IOException("无法写入所选位置");
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("图片保存已取消");
                output.write(buffer, 0, count);
            }
        }
    }
}
