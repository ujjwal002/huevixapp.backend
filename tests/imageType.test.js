import { describe, it, expect } from 'vitest';
import { sniffImageExt } from '../src/utils/imageType.js';

const bytes = (...b) => Buffer.from(b);

describe('sniffImageExt — magic-byte image detection', () => {
  it('detects JPEG', () => {
    expect(sniffImageExt(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe('jpg');
  });

  it('detects PNG', () => {
    expect(sniffImageExt(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))).toBe(
      'png'
    );
  });

  it('detects GIF87a and GIF89a', () => {
    expect(sniffImageExt(Buffer.from('GIF87a......'))).toBe('gif');
    expect(sniffImageExt(Buffer.from('GIF89a......'))).toBe('gif');
  });

  it('detects WEBP', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBP')]);
    expect(sniffImageExt(webp)).toBe('webp');
  });

  it('detects HEIC via ftyp brand', () => {
    const heic = Buffer.concat([bytes(0, 0, 0, 0), Buffer.from('ftyp'), Buffer.from('heic')]);
    expect(sniffImageExt(heic)).toBe('heic');
  });

  it('rejects an SVG payload (the XSS vector this guard exists for)', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffImageExt(svg)).toBeNull();
  });

  it('rejects an HTML payload', () => {
    expect(sniffImageExt(Buffer.from('<!DOCTYPE html><script>evil()</script>'))).toBeNull();
  });

  it('rejects buffers shorter than 12 bytes', () => {
    expect(sniffImageExt(bytes(0xff, 0xd8))).toBeNull();
  });

  it('rejects non-buffer input', () => {
    expect(sniffImageExt(null)).toBeNull();
    expect(sniffImageExt('not a buffer')).toBeNull();
  });
});