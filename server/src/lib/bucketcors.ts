import type { CorsRule, S3Driver } from '../storage/s3';

export type S3Provider = 'r2' | 'b2' | 'aws' | 'oss' | 'cos' | 'minio' | 'other';

export function detectProvider(host: string, preset?: string): S3Provider {
  const h = host.toLowerCase();
  if (h.endsWith('.r2.cloudflarestorage.com')) return 'r2';
  if (h.includes('backblazeb2.com')) return 'b2';
  if (h.endsWith('amazonaws.com')) return 'aws';
  if (h.endsWith('aliyuncs.com')) return 'oss';
  if (h.endsWith('myqcloud.com')) return 'cos';
  if (preset && ['r2', 'b2', 'aws', 'oss', 'cos', 'minio'].includes(preset)) return preset as S3Provider;
  return 'other';
}

/** Manual instructions (正體中文 + English) when PutBucketCors is not permitted / not supported. */
export function corsInstructions(provider: S3Provider, origin: string, bucket: string): { zh: string; en: string } {
  const json = JSON.stringify([{ AllowedOrigins: [origin], AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD', 'DELETE'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }], null, 2);
  switch (provider) {
    case 'r2':
      return {
        zh: `Cloudflare 主控台 → R2 → ${bucket} → 設定 → CORS 原則 → 新增，貼上：\n${json}\n（API Token 需具備「Admin Read & Write」權限才能用一鍵設定；「Object Read & Write」權限的 Token 無法修改 CORS。）`,
        en: `Cloudflare dashboard → R2 → ${bucket} → Settings → CORS policy → Add, paste:\n${json}\n(One-click setup needs an "Admin Read & Write" API token; "Object Read & Write" tokens cannot change CORS.)`,
      };
    case 'b2':
      return {
        zh: `B2 的 S3 相容 API 需要具備 writeBuckets 能力的 Application Key 才能 PutBucketCors。或使用 B2 CLI：\nb2 bucket update --cors-rules '[{"corsRuleName":"edgedock","allowedOrigins":["${origin}"],"allowedOperations":["s3_get","s3_put","s3_post","s3_head","s3_delete"],"allowedHeaders":["*"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]' ${bucket}\n注意：在 B2 網頁介面設定過「B2 Native」CORS 規則時，S3 API 無法覆寫，請先清除。`,
        en: `B2's S3 API needs an application key with the writeBuckets capability for PutBucketCors. Or use the B2 CLI:\nb2 bucket update --cors-rules '[{"corsRuleName":"edgedock","allowedOrigins":["${origin}"],"allowedOperations":["s3_get","s3_put","s3_post","s3_head","s3_delete"],"allowedHeaders":["*"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]' ${bucket}\nNote: rules created as "B2 Native" CORS in the web UI block S3 PutBucketCors — clear them first.`,
      };
    case 'aws':
      return {
        zh: `AWS 主控台 → S3 → ${bucket} → 權限 → 跨來源資源共用 (CORS) → 編輯，貼上：\n${json}\nIAM 使用者需要 s3:PutBucketCORS / s3:GetBucketCORS 權限才能一鍵設定。`,
        en: `AWS console → S3 → ${bucket} → Permissions → Cross-origin resource sharing (CORS) → Edit, paste:\n${json}\nThe IAM user needs s3:PutBucketCORS / s3:GetBucketCORS for one-click setup.`,
      };
    case 'oss':
      return {
        zh: `阿里雲 OSS 主控台 → Bucket ${bucket} → 資料安全 → 跨網域設定 → 建立規則：來源 ${origin}；允許方法 GET/PUT/POST/HEAD/DELETE；允許 Headers *；暴露 Headers ETag；快取 3600 秒。RAM 帳號需 oss:PutBucketCors 權限。`,
        en: `Aliyun OSS console → bucket ${bucket} → Data Security → CORS → Create rule: origin ${origin}; methods GET/PUT/POST/HEAD/DELETE; allowed headers *; expose ETag; max age 3600. The RAM user needs oss:PutBucketCors.`,
      };
    case 'cos':
      return {
        zh: `騰訊雲 COS 主控台 → 儲存桶 ${bucket} → 安全管理 → 跨網域存取 CORS 設定 → 新增規則：來源 ${origin}；操作 GET/PUT/POST/HEAD/DELETE；Allow-Headers *；Expose-Headers ETag；超時 3600。子帳號需 cos:PutBucketCORS 權限。`,
        en: `Tencent COS console → bucket ${bucket} → Security → CORS → Add rule: origin ${origin}; methods GET/PUT/POST/HEAD/DELETE; Allow-Headers *; Expose-Headers ETag; max age 3600. Sub-accounts need cos:PutBucketCORS.`,
      };
    case 'minio':
      return {
        zh: `MinIO 不支援逐 Bucket 的 PutBucketCors；請在伺服器設定全域 CORS：\nmc admin config set <alias> api cors_allow_origin="${origin}" && mc admin service restart <alias>\n（或環境變數 MINIO_API_CORS_ALLOW_ORIGIN=${origin}）。MinIO 預設會回傳 ETag 標頭。`,
        en: `MinIO does not implement per-bucket PutBucketCors; configure global CORS on the server:\nmc admin config set <alias> api cors_allow_origin="${origin}" && mc admin service restart <alias>\n(or env MINIO_API_CORS_ALLOW_ORIGIN=${origin}). MinIO exposes ETag by default.`,
      };
    default:
      return {
        zh: `請在服務商主控台為 Bucket ${bucket} 新增 CORS 規則：\n${json}\n若無法設定，上傳會自動改走 Worker 代理（較慢、受 Worker 請求大小限制，已自動分段）。`,
        en: `Add a CORS rule for bucket ${bucket} in your provider's console:\n${json}\nIf you cannot, uploads automatically go through the Worker proxy (slower, chunked to stay under the Worker body limit).`,
      };
  }
}

function originMatches(pattern: string, origin: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern.toLowerCase() === origin.toLowerCase();
  const re = new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(origin);
}

/** Does any rule allow PUT from `origin` and expose ETag? */
export function evaluateRules(rules: CorsRule[], origin: string): { allowsPut: boolean; exposesEtag: boolean; allowsGet: boolean } {
  let allowsPut = false;
  let allowsGet = false;
  let exposesEtag = false;
  for (const r of rules) {
    if (!r.allowedOrigins.some((o) => originMatches(o, origin))) continue;
    const methods = r.allowedMethods.map((m) => m.toUpperCase());
    if (methods.includes('PUT')) allowsPut = true;
    if (methods.includes('GET')) allowsGet = true;
    if (r.exposeHeaders.some((h) => h.toLowerCase() === 'etag' || h === '*')) exposesEtag = true;
  }
  return { allowsPut, allowsGet, exposesEtag };
}

export interface CorsCheckResult {
  origin: string;
  provider: S3Provider;
  /** null when GetBucketCors itself failed */
  rules: CorsRule[] | null;
  rulesError?: string;
  evaluation: ReturnType<typeof evaluateRules> | null;
  preflight: Awaited<ReturnType<S3Driver['simulatePreflight']>> | null;
  preflightError?: string;
  /** overall verdict from the server's point of view */
  ok: boolean;
  instructions: { zh: string; en: string };
}

export async function checkBucketCors(driver: S3Driver, origin: string, bucket: string, preset?: string): Promise<CorsCheckResult> {
  const provider = detectProvider(driver.endpointHost, preset);
  const out: CorsCheckResult = { origin, provider, rules: null, evaluation: null, preflight: null, ok: false, instructions: corsInstructions(provider, origin, bucket) };
  try {
    out.rules = await driver.getBucketCors();
    out.evaluation = evaluateRules(out.rules, origin);
  } catch (e) {
    out.rulesError = (e as Error).message;
  }
  try {
    out.preflight = await driver.simulatePreflight(origin);
  } catch (e) {
    out.preflightError = (e as Error).message;
  }
  const pf = out.preflight;
  const pfOk = !!pf && pf.status >= 200 && pf.status < 300 && !!pf.allowOrigin && (pf.allowOrigin === '*' || pf.allowOrigin.toLowerCase() === origin.toLowerCase());
  // preflight is the ground truth; fall back to the rule evaluation when the provider won't answer OPTIONS server-side
  out.ok = pfOk || (!pf && !!out.evaluation?.allowsPut);
  return out;
}
