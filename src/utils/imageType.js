// Detect an image's real type from its leading bytes (magic numbers) instead of
// trusting the client-declared Content-Type (which multer's fileFilter takes on
// faith). Returns a canonical extension ('jpg'|'png'|'gif'|'webp'|'heic') or
// null if the buffer isn't a supported image — so a mislabeled or hostile file
// can't be persisted under a type it isn't.
export function sniffImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // GIF: "GIF87a" / "GIF89a"
  const head6 = buffer.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';

  // WEBP: "RIFF" .... "WEBP"
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  // HEIC/HEIF: "....ftyp<brand>" with an HEIF brand code
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    const heifBrands = [
      'heic',
      'heix',
      'hevc',
      'hevx',
      'mif1',
      'msf1',
      'heim',
      'heis',
      'hevm',
      'hevs',
    ];
    if (heifBrands.includes(brand)) return 'heic';
  }

  return null;
}
