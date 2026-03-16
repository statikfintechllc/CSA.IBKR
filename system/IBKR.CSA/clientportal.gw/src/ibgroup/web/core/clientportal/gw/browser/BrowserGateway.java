package ibgroup.web.core.clientportal.gw.browser;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Browser-native IBKR Client Portal Gateway proxy.
 *
 * Designed to run inside CheerpJ 3.0 where {@code java.net.HttpURLConnection}
 * is transparently mapped to the browser's {@code fetch} API.  Unlike the
 * stock Vert.x / Netty gateway, this class never opens a {@link ServerSocket}
 * and never uses NIO channels — it is a pure request-level proxy that
 * JavaScript can call directly via CheerpJ's library-mode interop.
 *
 * <h3>Usage from JavaScript (via {@code cheerpjRunLibrary})</h3>
 * <pre>
 *   const lib = await cheerpjRunLibrary(classpath);
 *   const BG  = await lib.ibgroup.web.core.clientportal.gw.browser.BrowserGateway;
 *   await BG.init("https://api.ibkr.com", "v1");
 *   const json = await BG.proxy("GET", "/v1/api/iserver/auth/status", null);
 * </pre>
 */
public final class BrowserGateway {

    // ── Configuration ─────────────────────────────────────────────────────
    private static String  remoteHost  = "https://api.ibkr.com";
    private static String  ssoHost     = "https://gdcdyn.interactivebrokers.com";
    private static String  env         = "v1";
    private static boolean initialized = false;

    // ── Cookie jar (persisted across requests like a real browser session) ─
    private static final Map<String, String> cookies =
            new ConcurrentHashMap<>();

    // ── User-Agent sent with every outbound request ──────────────────────
    private static final String UA =
            "Mozilla/5.0 (CheerpJ; BrowserGateway) AppleWebKit/537.36";

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Initialise the bridge with the target IBKR host and service version.
     *
     * @param host IBKR API host, e.g. {@code "https://api.ibkr.com"}
     * @param sso  SSO host, e.g. {@code "https://gdcdyn.interactivebrokers.com"}
     * @param ver  Service environment, e.g. {@code "v1"}
     */
    public static void init(String host, String sso, String ver) {
        if (host != null && !host.isEmpty()) remoteHost = host;
        if (sso  != null && !sso.isEmpty())  ssoHost    = sso;
        if (ver  != null && !ver.isEmpty())  env        = ver;
        initialized = true;
    }

    /** @return {@code true} once {@link #init} has been called. */
    public static boolean isReady() {
        return initialized;
    }

    /** @return the remote host the proxy will call. */
    public static String getRemoteHost() { return remoteHost; }

    /** @return the SSO host used for authentication. */
    public static String getSsoHost() { return ssoHost; }

    /**
     * Proxy a single HTTP request to the IBKR backend.
     *
     * The path should be the full API path (e.g.
     * {@code /v1/api/iserver/auth/status}).  If the path starts with
     * {@code /sso/} it is sent to {@link #ssoHost}; all other paths go to
     * {@link #remoteHost}.
     *
     * @param method HTTP method (GET, POST, DELETE …)
     * @param path   API path including query string
     * @param body   Request body (JSON string) — may be {@code null}
     * @return JSON string: {@code {"status":200,"headers":{…},"body":"…"}}
     */
    public static String proxy(String method, String path, String body) {
        try {
            String base = path.startsWith("/sso/") ? ssoHost : remoteHost;
            URL url = new URL(base + path);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "application/json");
            conn.setInstanceFollowRedirects(false);

            // Attach cookies
            String cookieHeader = buildCookieHeader();
            if (!cookieHeader.isEmpty()) {
                conn.setRequestProperty("Cookie", cookieHeader);
            }

            // Body
            if (body != null && !body.isEmpty()) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();
            }

            int status = conn.getResponseCode();

            // Capture Set-Cookie
            captureCookies(conn);

            // Read response
            InputStream is;
            try {
                is = conn.getInputStream();
            } catch (IOException e) {
                is = conn.getErrorStream();
            }

            String respBody = "";
            if (is != null) {
                respBody = readStream(is);
                is.close();
            }

            // Collect response headers
            StringBuilder hdrs = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() == null) continue;
                if (!first) hdrs.append(",");
                first = false;
                hdrs.append(jsonStr(entry.getKey().toLowerCase()));
                hdrs.append(":");
                hdrs.append(jsonStr(join(entry.getValue(), ",")));
            }
            hdrs.append("}");

            conn.disconnect();

            return "{\"status\":" + status
                    + ",\"headers\":" + hdrs.toString()
                    + ",\"body\":" + jsonStr(respBody)
                    + "}";

        } catch (Exception e) {
            return "{\"status\":0,\"error\":" + jsonStr(errMsg(e)) + "}";
        }
    }

    /**
     * Quick connectivity / auth-status check.
     * Hits {@code /v1/api/iserver/auth/status} via POST.
     *
     * @return JSON body from the endpoint (or error wrapper)
     */
    public static String authStatus() {
        return proxy("POST", "/" + env + "/api/iserver/auth/status", null);
    }

    /**
     * Send a keep-alive tickle.
     * Hits {@code /v1/api/tickle} via POST.
     *
     * @return JSON body from the endpoint (or error wrapper)
     */
    public static String tickle() {
        return proxy("POST", "/" + env + "/api/tickle", null);
    }

    /**
     * Initiate DH-based brokerage session.
     * Hits {@code /v1/api/iserver/auth/ssodh/init} via POST.
     *
     * @return JSON body from the endpoint (or error wrapper)
     */
    public static String ssoDHInit() {
        return proxy("POST", "/" + env + "/api/iserver/auth/ssodh/init",
                "{\"publish\":true,\"compete\":true}");
    }

    /**
     * Logout.
     * Hits {@code /v1/api/logout} via POST.
     *
     * @return JSON body from the endpoint (or error wrapper)
     */
    public static String logout() {
        String result = proxy("POST", "/" + env + "/api/logout", null);
        cookies.clear();
        return result;
    }

    /**
     * Return the SSO login URL that should be opened in a popup window.
     *
     * @return full URL string
     */
    public static String ssoLoginUrl() {
        return ssoHost + "/sso/Login?forwardTo=22&RL=1&ip2loc=US";
    }

    /**
     * Clear all stored cookies (useful on logout / reset).
     */
    public static void clearCookies() {
        cookies.clear();
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    private static String buildCookieHeader() {
        if (cookies.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : cookies.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append("=").append(e.getValue());
        }
        return sb.toString();
    }

    private static void captureCookies(HttpURLConnection conn) {
        Map<String, List<String>> headers = conn.getHeaderFields();
        if (headers == null) return;
        List<String> setCookies = headers.get("Set-Cookie");
        if (setCookies == null) setCookies = headers.get("set-cookie");
        if (setCookies == null) return;
        for (String raw : setCookies) {
            String nameVal = raw.split(";")[0];
            int eq = nameVal.indexOf('=');
            if (eq > 0) {
                cookies.put(nameVal.substring(0, eq).trim(),
                        nameVal.substring(eq + 1).trim());
            }
        }
    }

    private static String readStream(InputStream is) throws IOException {
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(is, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        char[] buf = new char[4096];
        int n;
        while ((n = reader.read(buf)) != -1) {
            sb.append(buf, 0, n);
        }
        reader.close();
        return sb.toString();
    }

    private static String jsonStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:   sb.append(c);      break;
            }
        }
        sb.append("\"");
        return sb.toString();
    }

    private static String join(List<String> list, String sep) {
        if (list == null || list.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(list.get(i));
        }
        return sb.toString();
    }

    private static String errMsg(Exception e) {
        String msg = e.getMessage();
        return msg != null ? msg : e.getClass().getName();
    }
}
