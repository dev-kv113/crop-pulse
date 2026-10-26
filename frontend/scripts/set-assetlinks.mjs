/**
 * Writes public/.well-known/assetlinks.json from a signing-key fingerprint.
 *
 *   npm run assetlinks -- <SHA256_FINGERPRINT>
 *
 * This file is how Android decides that https://app.yourdomain.com and the Play
 * Store app com.geotrans.cropanalytics are the same product. If it is missing,
 * wrong, or unreachable, the installed app still works but shows a browser
 * address bar across the top - which is exactly the thing a Trusted Web Activity
 * exists to avoid.
 *
 * Get the fingerprint from Play Console -> Setup -> App integrity -> App signing
 * (use the "App signing key certificate" SHA-256, not the upload key), or from
 * your own keystore:
 *
 *   keytool -list -v -keystore my.keystore -alias my-alias | grep SHA256
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "com.geotrans.cropanalytics";

const fingerprint = (process.argv[2] ?? "").trim().toUpperCase();

// 32 bytes, printed as colon-separated hex pairs.
if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
  console.error(
    "Pass the SHA-256 fingerprint as colon-separated hex pairs, e.g.\n" +
      "  npm run assetlinks -- AA:BB:CC:...:FF\n" +
      `Got: ${fingerprint || "(nothing)"}`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../public/.well-known/assetlinks.json");

const body = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: PACKAGE_NAME,
      sha256_cert_fingerprints: [fingerprint],
    },
  },
];

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(body, null, 2)}\n`);
console.log(`Wrote ${out}\n  package    : ${PACKAGE_NAME}\n  fingerprint: ${fingerprint}`);
