package local.pickcode.assistant;

import java.net.URI;

/** No URL credentials, proxy paths, fragments, or public cleartext transports. */
public final class OnlineEndpoint {
    private OnlineEndpoint() {}
    public static String normalize(String input, boolean development) {
        try {
            if (input == null || input.length() > 2048) throw new IllegalArgumentException();
            URI uri = new URI(input.trim());
            String host = uri.getHost();
            boolean loopback = "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host)
                    || "[::1]".equals(host) || "::1".equals(host);
            boolean secure = "https".equalsIgnoreCase(uri.getScheme());
            if ((!secure && !(development && loopback && "http".equalsIgnoreCase(uri.getScheme())))
                    || host == null || host.isEmpty() || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || (uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535))
                    || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) throw new IllegalArgumentException();
            int port = uri.getPort();
            if ((secure && port == 443) || (!secure && port == 80)) port = -1;
            return new URI(secure ? "https" : "http", null, host.toLowerCase(java.util.Locale.ROOT), port, null, null, null).toASCIIString();
        } catch (Exception invalid) { throw new IllegalArgumentException("请填写 HTTPS 服务地址（开发版本仅允许本机 HTTP）"); }
    }
    public static boolean validToken(String token) { return token != null && token.matches("[A-Za-z0-9._~-]{16,512}"); }
    public static boolean validCode(String code) { return code != null && code.matches("[A-Za-z0-9-]{4,128}"); }
    public static boolean validEtag(String etag) { return etag != null && etag.length() <= 256 && etag.matches("[\\x20-\\x7E]*"); }
}
