/**
 * Shared S3 test server: a local `moto` server (python -m moto.server) if available, or any endpoint
 * given via S3_TEST_ENDPOINT / S3_TEST_KEY / S3_TEST_SECRET / S3_TEST_BUCKET. `available` is false when neither works.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AwsV4Signer } from 'aws4fetch';

export const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT ?? '',
  accessKeyId: process.env.S3_TEST_KEY ?? 'testing',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'testing',
  bucket: process.env.S3_TEST_BUCKET ?? 'edgedock-test',
  available: false,
};
let proc: ChildProcess | null = null;

async function waitUp(url: string, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

export async function startS3(bucket = s3.bucket): Promise<typeof s3> {
  if (!s3.endpoint) {
    const port = 15000 + Math.floor(Math.random() * 20000);
    try {
      proc = spawn('python3', ['-m', 'moto.server', '-p', String(port)], { stdio: 'ignore' });
      proc.on('error', () => {});
      s3.endpoint = `http://127.0.0.1:${port}`;
      if (!(await waitUp(s3.endpoint))) return s3;
    } catch {
      return s3;
    }
  }
  const s = await new AwsV4Signer({ url: `${s3.endpoint}/${bucket}`, method: 'PUT', accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, service: 's3', region: 'us-east-1' }).sign();
  const r = await fetch(s.url, { method: 'PUT', headers: s.headers }).catch(() => null);
  s3.available = !!r && (r.ok || r.status === 409);
  return s3;
}

export function stopS3() {
  proc?.kill();
  proc = null;
}
