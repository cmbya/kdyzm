package local.pickcode.assistant;

import java.net.URI;
import java.net.URISyntaxException;

/** Pure policy used by both navigation and resource interception, with JVM attack-case tests. */
public final class TrustedOrigin {
    static final String PRODUCT_IMAGE_SOURCES = "https://alicdn.com https://*.alicdn.com https://360buyimg.com https://*.360buyimg.com https://pddpic.com https://*.pddpic.com https://img.yangkeduo.com";
    private TrustedOrigin() {}
    public static boolean productImage(String value) {
        if (value == null || value.length() > 2048 || value.matches("(?s).*[\\s\\p{Z}\\x00-\\x1f\\x7f\\\\].*")) return false;
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                    && host != null && host.matches("(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*(?:alicdn\\.com|360buyimg\\.com|pddpic\\.com)|img\\.yangkeduo\\.com)");
        } catch (URISyntaxException invalid) { return false; }
    }
    public static boolean asset(String value) {
        try {
            URI uri = new URI(value);
            String path = uri.getPath();
            return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                    && uri.getPort() == -1 && uri.getUserInfo() == null && path != null
                    && path.startsWith("/assets/app/") && !path.contains("..") && !path.contains("\\");
        } catch (URISyntaxException | NullPointerException invalid) { return false; }
    }
    public static boolean document(String value) {
        if (!asset(value)) return false;
        try { return "/assets/app/index.html".equals(new URI(value).getPath()); }
        catch (URISyntaxException invalid) { return false; }
    }
}
