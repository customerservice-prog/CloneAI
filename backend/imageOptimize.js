import sharp from 'sharp';

const MAX_WIDTH = 2048;
const JPEG_QUALITY = 82;

/**
 * Downscale large screenshots and re-encode as JPEG to reduce vision-model payload size.
 * Falls back to the original buffer if processing fails.
 */
export async function optimizeImageForModel(buffer, mime) {
  if (!buffer?.length) return { buffer, mime: mime || 'image/png' };
  try {
    const pipeline = sharp(buffer).rotate();
    const meta = await pipeline.metadata();
    let img = pipeline;
    if (meta.width && meta.width > MAX_WIDTH) {
      img = img.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    }
    const out = await img.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch (e) {
    console.warn('Image optimize skipped:', e.message);
    return { buffer, mime: mime || 'image/png' };
  }
}
