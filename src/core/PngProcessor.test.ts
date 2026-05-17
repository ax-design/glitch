import { test, expect, beforeAll } from 'bun:test';
import CanvasKitInit from 'canvaskit-wasm';
import type { CanvasKit } from 'canvaskit-wasm';
import {
    parsePngChunks,
    inflateCompressed,
    deflateFiltered,
    computeScanlines,
    rebuildPng,
    reencodeWithFilter,
    buildFilteredDataPool,
    buildFilterTypePool,
} from './PngProcessor.js';
import { parseZlibDeflate, repairZlibDeflate } from './DeflateRepair.js';

let CanvasKit: CanvasKit;

beforeAll(async () => {
    const path = require('path') as typeof import('path');
    const wasmDir = path.resolve(__dirname, '../../node_modules/canvaskit-wasm/bin');
    CanvasKit = await CanvasKitInit({
        locateFile: (file: string) => path.join(wasmDir, file),
    });
});

function makePngBytes(width: number, height: number): Uint8Array {
    const surface = CanvasKit.MakeSurface(width, height)!;
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

function makeStoredZlibSample(): Uint8Array {
    return new Uint8Array([
        120, 1, 1, 30, 0, 225, 255,
        115, 116, 111, 114, 101, 100, 45, 98, 108, 111, 99, 107, 45, 115, 97, 109, 112, 108, 101, 45, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48,
        170, 171, 9, 179,
    ]);
}

function makeDynamicZlibSample(): Uint8Array {
    return new Uint8Array([
        120, 156, 21, 137, 49, 1, 0, 0, 12, 130, 204, 100, 38, 51, 153, 137, 88, 155, 23, 34, 68, 4, 3, 169, 232, 207, 216, 214, 76, 207, 191, 150, 61, 180, 81, 208, 1, 58, 10, 21, 125,
    ]);
}

function makeDynamicSampleOutput(): Uint8Array {
    return new Uint8Array([
        200, 100, 0, 200, 100, 200, 50, 200, 200, 200, 100, 150, 0, 200, 150, 100, 200, 50, 100, 50, 50, 50, 0, 200, 100, 150, 0, 0, 50, 50, 0, 0, 200, 150, 200, 100, 200, 50, 50, 200, 150, 200, 100, 150, 150, 100, 0, 100, 200, 0,
    ]);
}

function makeRepairAcceptance(expectedLength: number) {
    return (output: Uint8Array) => ({ ok: output.length === expectedLength });
}

test('parseZlibDeflate: parses stored block sample', async () => {
    const sample = makeStoredZlibSample();
    const parsed = parseZlibDeflate(sample);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const inflated = await inflateCompressed(sample);
    expect(parsed.output).toEqual(inflated);
    expect(parsed.blocks.length).toBe(1);
    expect(parsed.blocks[0].btype).toBe(0);
    expect(parsed.symbols.length).toBe(1);
    expect(parsed.symbols[0].kind).toBe('stored');
});

test('parseZlibDeflate: parses PNG data for browser-generated sample', async () => {
    const png = makePngBytes(32, 24);
    const { compressedData } = parsePngChunks(png);
    const parsed = parseZlibDeflate(compressedData);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const inflated = await inflateCompressed(compressedData);
    expect(parsed.output).toEqual(inflated);
    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(parsed.blocks[0].btype).toBeGreaterThanOrEqual(0);
    expect(parsed.blocks[0].btype).toBeLessThanOrEqual(2);
});

test('parseZlibDeflate: parses dynamic Huffman sample', async () => {
    const sample = makeDynamicZlibSample();
    const parsed = parseZlibDeflate(sample);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const inflated = await inflateCompressed(sample);
    expect(parsed.output).toEqual(inflated);
    expect(parsed.output).toEqual(makeDynamicSampleOutput());
    expect(parsed.blocks.length).toBe(1);
    expect(parsed.blocks[0].btype).toBe(2);
    expect(parsed.blocks[0].treeBitStart).toBeDefined();
    expect(parsed.blocks[0].treeBitEnd).toBeDefined();
});

test('repairZlibDeflate: repairs fixed Huffman byte corruption', async () => {
    const png = makePngBytes(48, 32);
    const { compressedData } = parsePngChunks(png);
    const baseline = parseZlibDeflate(compressedData);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const mutated = new Uint8Array(compressedData);
    mutated[12] ^= 0x5a;
    mutated[19] ^= 0x33;

    const repaired = repairZlibDeflate(mutated, baseline, makeRepairAcceptance(baseline.output.length));
    expect(repaired).not.toBeNull();
    if (!repaired) return;

    expect(repaired.filteredData.length).toBe(baseline.output.length);
    const reinflated = await inflateCompressed(repaired.compressedData);
    expect(reinflated).toEqual(repaired.filteredData);
});

test('repairZlibDeflate: repairs dynamic Huffman corruption', async () => {
    const sample = makeDynamicZlibSample();
    const baseline = parseZlibDeflate(sample);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const mutated = new Uint8Array(sample);
    mutated[8] ^= 0x80;

    const repaired = repairZlibDeflate(mutated, baseline, makeRepairAcceptance(baseline.output.length));
    expect(repaired).not.toBeNull();
    if (!repaired) return;

    const reinflated = await inflateCompressed(repaired.compressedData);
    expect(reinflated).toEqual(repaired.filteredData);
    expect(repaired.filteredData.length).toBe(baseline.output.length);
});

test('repairZlibDeflate: repairs stored block corruption with suffix fallback', async () => {
    const sample = makeStoredZlibSample();
    const baseline = parseZlibDeflate(sample);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const mutated = new Uint8Array(sample);
    mutated[10] ^= 0xff;
    mutated[11] ^= 0xff;

    const repaired = repairZlibDeflate(mutated, baseline, makeRepairAcceptance(baseline.output.length));
    expect(repaired).not.toBeNull();
    if (!repaired) return;

    const reinflated = await inflateCompressed(repaired.compressedData);
    expect(reinflated).toEqual(repaired.filteredData);
    expect(repaired.filteredData.length).toBe(baseline.output.length);
});

test('repairZlibDeflate: large transposed payload repairs quickly', async () => {
    const png = makePngBytes(384, 256);
    const { compressedData } = parsePngChunks(png);
    const baseline = parseZlibDeflate(compressedData);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const mutated = new Uint8Array(compressedData);
    const payload = mutated.slice(2, mutated.length - 4);
    const chunkCount = 4;
    const chunkSize = Math.floor(payload.length / chunkCount);
    const transposed = new Uint8Array(payload.length);
    let offset = 0;
    for (const idx of [2, 0, 3, 1]) {
        const start = idx * chunkSize;
        const end = idx === chunkCount - 1 ? payload.length : start + chunkSize;
        transposed.set(payload.subarray(start, end), offset);
        offset += end - start;
    }
    mutated.set(transposed, 2);

    const started = performance.now();
    const repaired = repairZlibDeflate(mutated, baseline, makeRepairAcceptance(baseline.output.length));
    const elapsed = performance.now() - started;

    expect(repaired).not.toBeNull();
    if (!repaired) return;

    expect(['block', 'block-suffix']).toContain(repaired.strategy);
    expect(elapsed).toBeLessThan(1000);

    const reinflated = await inflateCompressed(repaired.compressedData);
    expect(reinflated).toEqual(repaired.filteredData);
});

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
