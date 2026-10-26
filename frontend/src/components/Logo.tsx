/**
 * The GEOtrans logo.
 *
 * The image lives in `public/` rather than being imported, so replacing the
 * placeholder with the real brand asset is a file swap with no rebuild of the
 * component and no code change:
 *
 *   frontend/public/geotrans-logo.svg   <- drop the official SVG here
 *
 * If your asset is a PNG, save it as `geotrans-logo.png` and change SRC below.
 */

const SRC = "/geotrans-logo.svg";

export function Logo({ height = 30 }: { height?: number }) {
  return (
    <img
      className="logo"
      src={SRC}
      alt="GEOtrans Technologies"
      height={height}
      style={{ height }}
    />
  );
}
