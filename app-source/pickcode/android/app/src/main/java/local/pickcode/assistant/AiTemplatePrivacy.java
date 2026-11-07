package local.pickcode.assistant;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Constructs a tiny synthetic excerpt; real SMS content is never an outbound template sample. */
public final class AiTemplatePrivacy {
    public static final String DUMMY_CODE = "654321";
    private static final String MARKERS = "取件密码|取件编号|取件码|取货码|提货码|自提码|领取码|快递码";
    private static final Pattern MARKER = Pattern.compile(MARKERS);
    private static final Pattern CODE = Pattern.compile("(" + MARKERS + ")([ \\t]*(?:为|是)?[ \\t:：=→#【】\\[\\]（）()]{0,12})([A-Za-z0-9]+(?:[-－—–][A-Za-z0-9]+)*)(?![A-Za-z0-9－—–-])");
    private static final Pattern UNSAFE = Pattern.compile("验证码|校验码|动态密码|登录|登陆|支付|付款|转账|银行|信用卡|贷款|红包|优惠|促销|营销|退订|中奖|充值|口令|\\b(?:otp|verification|authentication|login|payment|bank|promotion|coupon)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SIGNATURE = Pattern.compile("【([^】]+)】|\\[([^\\]]+)\\]");
    private static final Set<String> BRANDS = new HashSet<>(Arrays.asList("菜鸟驿站", "菜鸟", "兔喜生活", "兔喜", "递管家", "丰巢", "中通快递", "中通", "圆通速递", "圆通", "申通快递", "申通", "韵达快递", "韵达", "极兔速递", "极兔", "顺丰速运", "顺丰", "邮政", "中国邮政", "京东物流", "京东"));

    private AiTemplatePrivacy() {}

    public static final class Prepared {
        public final String sample;
        public final String expectedCode = DUMMY_CODE;
        public final String actualCode;
        public final String marker;
        public final String signature;
        private final String delimiter;
        private final String suffix;

        private Prepared(String actualCode, String marker, String delimiter, String suffix, String signature) {
            this.actualCode = actualCode;
            this.marker = marker;
            this.delimiter = delimiter;
            this.suffix = suffix;
            this.signature = signature;
            sample = (signature.isEmpty() ? "" : "【" + signature + "】") + delimiter + DUMMY_CODE + suffix;
        }

        /** The only payload allowed to cross the network boundary. */
        public JSONObject request(String channelId) throws Exception {
            JSONObject result = new JSONObject().put("sample", sample).put("expectedCode", expectedCode);
            if (channelId != null && !channelId.isEmpty()) result.put("channelId", channelId);
            return result;
        }
    }

    public static Prepared prepare(String source, String expected) {
        if (source == null || source.isEmpty() || source.length() > 4096 || UNSAFE.matcher(source).find())
            throw new IllegalArgumentException("此短信不适合自动生成模板，请手动设置");
        Matcher markers = MARKER.matcher(source);
        int count = 0;
        while (markers.find()) count++;
        Matcher match = CODE.matcher(source);
        if (count != 1 || !match.find()) throw new IllegalArgumentException("需有且仅有一个明确的取件码，请手动核对");
        String code = normalize(match.group(3));
        if (!code.matches("(?=.*[0-9])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*") || code.length() < 3 || code.length() > 12
                || code.matches("[0-9]{9,}") || code.matches("(?i)(?:JT|YT|SF|JD|ZTO|STO|YTO)[0-9]{8,}"))
            throw new IllegalArgumentException("无法安全确定取件码，请手动核对");
        if (expected != null && !expected.trim().isEmpty() && !code.equals(normalize(expected.trim())))
            throw new IllegalArgumentException("预期取件码与短信不一致");
        String signature = "";
        Matcher signed = SIGNATURE.matcher(source);
        if (signed.find()) {
            String value = signed.group(1) == null ? signed.group(2) : signed.group(1);
            if (BRANDS.contains(value)) signature = value;
        }
        String after = source.substring(match.end());
        Matcher ending = Pattern.compile("^[ \\t，。；：、,.!！?？;:】\\]）)]{0,4}").matcher(after);
        String suffix = ending.find() ? ending.group() : "";
        return new Prepared(code, match.group(1), match.group(1) + match.group(2), suffix, signature);
    }

    /** Reject source-specific delimiters before invoking the existing local core validator. */
    public static void checkCandidate(JSONObject candidate, Prepared prepared) throws Exception {
        if (candidate == null || !"pickup".equals(candidate.optString("kind", "pickup")))
            throw new IllegalArgumentException("AI 模板类型不适用");
        String signature = candidate.optString("signature");
        if (!signature.isEmpty() && !signature.equals(prepared.signature)) throw new IllegalArgumentException("AI 模板签名不适用");
        JSONObject fields = candidate.optJSONObject("rules");
        JSONObject code = fields == null ? null : fields.optJSONObject("code");
        if (code == null) throw new IllegalArgumentException("AI 模板缺少取件码分隔符");
        String start = code.optString("start").trim(), end = code.optString("end").trim();
        if (!start.contains(prepared.marker) || !prepared.delimiter.contains(start)
                || (!end.isEmpty() && !prepared.suffix.contains(end)))
            throw new IllegalArgumentException("AI 模板分隔符不能用于原短信");
        for (String field : new String[]{"code", "express", "address"}) {
            JSONObject item = fields.optJSONObject(field);
            if (item == null) continue;
            for (String side : new String[]{"start", "end"}) {
                String value = item.optString(side);
                if (value.contains(DUMMY_CODE) || value.contains(prepared.actualCode) || value.contains("${") || value.contains("{{")
                        || value.matches(".*[<>].*") || (!"code".equals(field) && !value.isEmpty()))
                    throw new IllegalArgumentException("AI 模板包含虚构字段或特定取件码");
            }
        }
        JSONArray keywords = candidate.optJSONArray("keywords");
        if (keywords != null) for (int i = 0; i < keywords.length(); i++) {
            String keyword = keywords.optString(i);
            if (keyword.isEmpty() || keyword.contains(DUMMY_CODE) || keyword.contains(prepared.actualCode)
                    || !(prepared.delimiter.contains(keyword) || (!prepared.signature.isEmpty() && prepared.signature.contains(keyword))))
                throw new IllegalArgumentException("AI 模板关键词不能用于原短信");
        }
    }

    static String[] negativeSamples(Prepared prepared) {
        String prefix = prepared.signature.isEmpty() ? "" : "【" + prepared.signature + "】";
        return new String[]{prefix + "登录验证码123456", prefix + "支付验证码123456", prefix + "付款金额123456元",
                prefix + "银行卡尾号123456", prefix + "优惠码123456", prefix + "快递运单号SF123456789012",
                prefix + "登录验证码123456，" + prepared.delimiter + DUMMY_CODE + prepared.suffix,
                prefix + "支付密码123456，" + prepared.delimiter + DUMMY_CODE + prepared.suffix};
    }

    private static String normalize(String value) { return value.replace('－', '-').replace('—', '-').replace('–', '-'); }
}
