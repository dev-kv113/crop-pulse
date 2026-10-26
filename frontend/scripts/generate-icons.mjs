/**
 * Renders assets/app-icon.svg into the PNG sizes a web app manifest needs.
 *
 *   npm run icons
 *
 * Two shapes are produced:
 *   - "any"      the icon as drawn, used in browser tabs and task switchers
 *   - "maskable" the same art inset into a safe zone, because Android crops
 *                icons to whatever shape the launcher uses (circle, squircle,
 *                rounded square). Without the inset, the leaves get clipped.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../assets/app-icon.svg");
const outDir = resolve(here, "../public/icons");

const BRAND_NAVY = "#1e1a5f";

await mkdir(outDir, { recursive: true });

for (const size of [192, 512]) {
  await sharp(source, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(resolve(outDir, `icon-${size}.png`));

  // Android may crop up to 20% from each edge, so the art occupies the middle
  // 80% and the rest is brand colour.
  const inner = Math.round(size * 0.8);
  await sharp({
    create: {
      width: size, height: size, channels: 4,
      background: BRAND_NAVY,
    },
  })
    .composite([
      {
        input: await sharp(source, { density: 384 }).resize(inner, inner).png().toBuffer(),
        gravity: "centre",
      },
    ])
    .png()
    .toFile(resolve(outDir, `icon-${size}-maskable.png`));
}

// iOS ignores the manifest and reads this one from a <link> tag.
await sharp(source, { density: 384 })
  .resize(180, 180)
  .flatten({ background: BRAND_NAVY })
  .png()
  .toFile(resolve(outDir, "apple-touch-icon.png"));

// A tiny favicon for browser tabs.
await sharp(source, { density: 384 }).resize(48, 48).png()
  .toFile(resolve(outDir, "favicon-48.png"));

console.log("Icons written to public/icons/");
