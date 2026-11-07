package local.pickcode.assistant;

import java.net.URI;
import java.net.URISyntaxException;

/** Pure policy used by both navigation and resource interception, with JVM attack-case tests. */
public final class TrustedOrigin {
    private TrustedOrigin() {}
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
