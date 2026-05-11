import { test, expect, beforeAll } from 'bun:test';
import CanvasKitInit from 'canvaskit-wasm';
import { parsePngChunks, inflateCompressed, deflateFiltered, computeScanlines, rebuildPng, reencodeWithFilter, buildFilteredDataPool, buildFilterTypePool } from './PngProcessor.js';

let CanvasKit: any;

beforeAll(async () => {
    const path = require('path') as typeof import('path');
    const wasmDir = path.resolve(__dirname, '../../node_modules/canvaskit-wasm/bin');
    CanvasKit = await CanvasKitInit({
        locateFile: (file: string) => path.join(wasmDir, file),
    });
});

function makePngBytes(width: number, height: number): Uint8Array {
    const surface = CanvasKit.MakeSurface(width, height);
    const canvas = surface.getCanvas();
    const paint = new CanvasKit.Paint();

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const r = Math.floor((x / width) * 255);
            const g = Math.floor((y / height) * 255);
            const b = Math.floor(((x + y) / (width + height)) * 255);
            paint.setColor(CanvasKit.Color(r, g, b, 255));
            canvas.drawRect(CanvasKit.XYWHRect(x, y, 1, 1), paint);
        }
    }

    paint.delete();
    surface.flush();

    const img = surface.makeImageSnapshot();
    const pngBytes = img.encodeToBytes();
    img.delete();
    surface.dispose();

    return new Uint8Array(pngBytes!);
}

function canDecode(bytes: Uint8Array, width: number, height: number): boolean {
    try {
        const canvas = CanvasKit.MakeCanvas(width, height);
        const img = canvas.decodeImage(bytes);
        if (!img) return false;
        return true;
    } catch {
        return false;
    }
}

// ============================================================
// PNG Chunk Parsing
// ============================================================

test('parsePngChunks: extracts IHDR metadata correctly', () => {
    const png = makePngBytes(64, 48);
    const { metadata, compressedData } = parsePngChunks(png);

    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(48);
    expect(metadata.bitDepth).toBe(8);
    expect(metadata.colorType).toBe(6); // RGBA
    expect(metadata.sampleSize).toBe(4);
    expect(metadata.interlaced).toBe(false);
    expect(compressedData.length).toBeGreaterThan(0);
});

test('parsePngChunks: headBytes starts with PNG signature', () => {
    const png = makePngBytes(16, 16);
    const { metadata } = parsePngChunks(png);

    expect(metadata.headBytes[0]).toBe(137);
    expect(metadata.headBytes[1]).toBe(80);
    expect(metadata.headBytes[2]).toBe(78);
    expect(metadata.headBytes[3]).toBe(71);
});

test('parsePngChunks: tailBytes ends with IEND', () => {
    const png = makePngBytes(16, 16);
    const { metadata } = parsePngChunks(png);
    const tail = metadata.tailBytes;

    const typeOffset = tail.length - 8;
    expect(String.fromCharCode(tail[typeOffset])).toBe('I');
    expect(String.fromCharCode(tail[typeOffset + 1])).toBe('E');
    expect(String.fromCharCode(tail[typeOffset + 2])).toBe('N');
    expect(String.fromCharCode(tail[typeOffset + 3])).toBe('D');
});

// ============================================================
// Inflate / Deflate Roundtrip
// ============================================================

test('inflate then deflate roundtrips correctly', async () => {
    const png = makePngBytes(32, 32);
    const { compressedData } = parsePngChunks(png);

    const filteredData = await inflateCompressed(compressedData);
    expect(filteredData.length).toBeGreaterThan(0);

    const recompressed = await deflateFiltered(filteredData);
    const roundtripped = await inflateCompressed(recompressed);

    expect(roundtripped.length).toBe(filteredData.length);
    for (let i = 0; i < filteredData.length; i++) {
        expect(roundtripped[i]).toBe(filteredData[i]);
    }
});

// ============================================================
// Scanline Computation
// ============================================================

test('computeScanlines: correct count and offsets', async () => {
    const png = makePngBytes(64, 48);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);

    expect(scanlines.length).toBe(48);

    const bytesPerRow = 64 * 4;
    for (let i = 0; i < scanlines.length; i++) {
        expect(scanlines[i].filterTypeOffset).toBe(i * (1 + bytesPerRow));
        expect(scanlines[i].dataStart).toBe(i * (1 + bytesPerRow) + 1);
        expect(scanlines[i].dataLength).toBe(bytesPerRow);
    }
});

test('computeScanlines: total coverage matches filtered data length', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);

    const lastScanline = scanlines[scanlines.length - 1];
    const totalCovered = lastScanline.dataStart + lastScanline.dataLength;
    expect(totalCovered).toBe(filteredData.length);
});

// ============================================================
// Rebuild PNG (the critical test)
// ============================================================

test('rebuildPng: unmodified roundtrip produces valid loadable PNG', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);

    const rebuilt = await rebuildPng(filteredData, metadata);

    expect(rebuilt[0]).toBe(137);
    expect(rebuilt[1]).toBe(80);
    expect(rebuilt[2]).toBe(78);
    expect(rebuilt[3]).toBe(71);

    expect(canDecode(rebuilt, 32, 24)).toBe(true);
});

test('rebuildPng: modified filtered data produces valid PNG', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);

    const modified = new Uint8Array(filteredData);
    if (scanlines.length > 5) {
        modified[scanlines[5].dataStart + 10] = 200;
    }

    const rebuilt = await rebuildPng(modified, metadata);
    expect(canDecode(rebuilt, 32, 24)).toBe(true);
});

// ============================================================
// Reencode with Filter
// ============================================================

test('reencodeWithFilter: Sub filter produces valid PNG', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);

    const reencoded = reencodeWithFilter(filteredData, scanlines, metadata, 1);
    const rebuilt = await rebuildPng(reencoded, metadata);

    expect(canDecode(rebuilt, 32, 24)).toBe(true);

    const reScanlines = computeScanlines(reencoded, metadata);
    for (const sl of reScanlines) {
        expect(reencoded[sl.filterTypeOffset]).toBe(1);
    }
});

test('reencodeWithFilter: all 5 filter types produce valid PNG', async () => {
    const png = makePngBytes(16, 16);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);

    for (let filterType = 0; filterType <= 4; filterType++) {
        const reencoded = reencodeWithFilter(filteredData, scanlines, metadata, filterType);
        const rebuilt = await rebuildPng(reencoded, metadata);
        expect(canDecode(rebuilt, 16, 16)).toBe(true);
    }
});

// ============================================================
// Pool Building
// ============================================================

test('buildFilteredDataPool: excludes filter type bytes', async () => {
    const png = makePngBytes(16, 8);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);
    const pool = buildFilteredDataPool(filteredData, scanlines);
    const filterTypeOffsets = new Set(scanlines.map(s => s.filterTypeOffset));

    expect(pool.length).toBe(filteredData.length - scanlines.length);
    for (let i = 0; i < pool.length; i++) {
        const byteIdx = pool.resolve(i);
        expect(filterTypeOffsets.has(byteIdx)).toBe(false);
    }
});

test('buildFilterTypePool: returns all filter type offsets', async () => {
    const png = makePngBytes(16, 8);
    const { metadata, compressedData } = parsePngChunks(png);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);
    const pool = buildFilterTypePool(scanlines);

    expect(pool.length).toBe(8);
    for (let i = 0; i < scanlines.length; i++) {
        expect(pool[i]).toBe(scanlines[i].filterTypeOffset);
    }
});
