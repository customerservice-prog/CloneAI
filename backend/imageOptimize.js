import sharp from 'sharp';

const DEFAULT_MAX_WIDTH = 2048;
const JPEG_QUALITY = 82;

/**
 * Downscale large screenshots and re-encode as JPEG to reduce vision-model payload size.
 * Falls back to the original buffer if processing fails.
 * @param {Buffer} buffer
 * @param {string} mime
 * @param {{ maxWidth?: number, trimSolidBackground?: boolean }} [opts]
 */
export async function optimizeImageForModel(buffer, mime, opts = {}) {
  if (!buffer?.length) return { buffer, mime: mime || 'image/png' };
  const maxWidth = Math.min(
    4096,
    Math.max(480, Number(opts.maxWidth) || DEFAULT_MAX_WIDTH)
  );
  try {
    let img = sharp(buffer).rotate();
    if (opts.trimSolidBackground) {
      try {
        const thr = Math.min(80, Math.max(1, Number(opts.trimThreshold) || 28));
        img = img.trim({ threshold: thr });
      } catch {
        /* keep frame if trim fails (e.g. uniform image) */
      }
    }
    const meta = await img.metadata();
    let pipeline = img;
    if (meta.width && meta.width > maxWidth) {
      pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
    }
    const out = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch (e) {
    console.warn('Image optimize skipped:', e.message);
    return { buffer, mime: mime || 'image/png' };
  }
}
