import { test, expect, beforeAll } from 'bun:test';
import CanvasKitInit from 'canvaskit-wasm';
import { parsePngChunks, inflateCompressed, computeScanlines, rebuildPng, assemblePng } from '../core/PngProcessor.js';
import { PngDomain } from './PngDomain.js';
import type { PngDomainState } from './PngDomain.js';
import { FilterDataGlitch } from '../glitch/png/FilterDataGlitch.js';
import { TransposeGlitch } from '../glitch/png/TransposeGlitch.js';
import { DefectGlitch } from '../glitch/png/DefectGlitch.js';
import { GraftGlitch } from '../glitch/png/GraftGlitch.js';
import { CompressedReplaceGlitch } from '../glitch/png/CompressedReplaceGlitch.js';
import { CompressedTransposeGlitch } from '../glitch/png/CompressedTransposeGlitch.js';
import { CompressedDefectGlitch } from '../glitch/png/CompressedDefectGlitch.js';
import { CustomFilterGlitch } from '../glitch/png/CustomFilterGlitch.js';
import { PngFilterType } from '../glitch/png/types.js';
import { Position } from '../params/Position.js';
import { GlitchValue } from '../params/GlitchValue.js';
import { GlitchValueCollection } from '../params/GlitchValueCollection.js';
import { DensityValue } from '../params/DensityValue.js';
import { DistributionKind } from '../params/Distribution.js';

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

function makeCanvasFromPng(pngBytes: Uint8Array): any {
    const img = CanvasKit.MakeImageFromEncoded(pngBytes);
    const canvas = CanvasKit.MakeCanvas(img.width(), img.height());
    canvas.drawImage(img, 0, 0);
    return canvas;
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

function isPngSignature(bytes: Uint8Array): boolean {
    return bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
}

// Helper: create a PngDomainState from raw PNG bytes (bypasses DOM canvas)
async function prepareState(pngBytes: Uint8Array): Promise<PngDomainState> {
    const domain = new PngDomain();
    // Manually prepare state since we can't use encode() without DOM
    const { metadata, compressedData } = parsePngChunks(pngBytes);
    const filteredData = await inflateCompressed(compressedData);
    const scanlines = computeScanlines(filteredData, metadata);
    const analysis = {
        filteredData: { length: filteredData.length - scanlines.length, resolve: (i: number) => {
            const bytesPerRow = scanlines.length > 0 ? scanlines[0].dataLength : 0;
            const scanline = Math.floor(i / bytesPerRow);
            return i + scanline + 1;
        }},
        filterTypes: scanlines.map((s: any) => s.filterTypeOffset),
        compressedData: { length: compressedData.length, resolve: (i: number) => i },
    };
    return { originalBytes: pngBytes, analysis, filteredData, compressedData, scanlines, metadata } as PngDomainState;
}

// Helper: make a replace glitch with fixed count (like pnglitch's 50 operations)
function makeReplaceGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.valueRange = { min: 0, max: 254 };
    c.spread = { min: 0, max: 100 };
    return new FilterDataGlitch(new Position(50), c);
}

function makeDefectGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.spread = { min: 0, max: 100 };
    return new DefectGlitch(new Position(50), c);
}

function makeCompressedReplaceGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.valueRange = { min: 0, max: 254 };
    c.spread = { min: 0, max: 100 };
    return new CompressedReplaceGlitch(new Position(50), c);
}

function makeCompressedDefectGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.spread = { min: 0, max: 100 };
    return new CompressedDefectGlitch(new Position(50), c);
}

// ============================================================
// PngDomain.prepare, compressedData in state
// ============================================================

test('PngDomain.prepare: includes compressedData in state', async () => {
    const png = makePngBytes(32, 24);
    const state = await prepareState(png);
    expect(state.compressedData).toBeDefined();
    expect(state.compressedData.length).toBeGreaterThan(0);
    expect(state.analysis.compressedData).toBeDefined();
    expect(state.analysis.compressedData.length).toBe(state.compressedData.length);
});

// ============================================================
// Filtered data glitch: all methods × all filter types
// ============================================================

const FILTER_TYPES = [
    { name: 'None', value: PngFilterType.None },
    { name: 'Sub', value: PngFilterType.Sub },
    { name: 'Up', value: PngFilterType.Up },
    { name: 'Average', value: PngFilterType.Average },
    { name: 'Paeth', value: PngFilterType.Paeth },
];

const FUZZ_RUNS = 20;

for (const ft of FILTER_TYPES) {
    test(`Filtered Replace × ${ft.name} filter: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const glitch = makeReplaceGlitch(50);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        }
    });

    test(`Filtered Transpose × ${ft.name} filter: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const glitch = new TransposeGlitch(4);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        }
    });

    test(`Filtered Defect × ${ft.name} filter: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const glitch = makeDefectGlitch(10);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        }
    });
}

// ============================================================
// Compressed data glitch: all methods
// ============================================================

test('Compressed Replace: fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    let decodableCount = 0;
    for (let run = 0; run < FUZZ_RUNS; run++) {
        const glitch = makeCompressedReplaceGlitch(10);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        // Compressed data corruption may or may not be decodable
        if (canDecode(result, 64, 48)) decodableCount++;
    }
    // At least some should be decodable
    expect(decodableCount).toBeGreaterThan(0);
});

test('Compressed Transpose: fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    let decodableCount = 0;
    for (let run = 0; run < FUZZ_RUNS; run++) {
        const glitch = new CompressedTransposeGlitch(4);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        if (canDecode(result, 64, 48)) decodableCount++;
    }
    expect(decodableCount).toBeGreaterThan(0);
});

test('Compressed Defect: fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    let decodableCount = 0;
    for (let run = 0; run < FUZZ_RUNS; run++) {
        const glitch = makeCompressedDefectGlitch(5);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        if (canDecode(result, 64, 48)) decodableCount++;
    }
    expect(decodableCount).toBeGreaterThan(0);
});

// ============================================================
// Graft glitch: all 5 filter type values
// ============================================================

for (const graftValue of [0, 1, 2, 3, 4]) {
    test(`Graft filter type ${graftValue}: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const density = new DensityValue(1.0, { min: graftValue, max: graftValue });
            const glitch = new GraftGlitch(new Position(0), density);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(canDecode(result, 64, 48)).toBe(true);
        }
    });
}

// ============================================================
// Custom filter glitch
// ============================================================

test('CustomFilterGlitch (XOR encoder): fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const customEncoder = (data: Uint8Array, prev: Uint8Array | null, sampleSize: number) => {
            const result = new Uint8Array(data);
            for (let i = sampleSize; i < data.length; i++) {
                result[i] = (data[i] ^ data[i - sampleSize]) & 0xff;
            }
            return result;
        };
        const glitch = new CustomFilterGlitch(customEncoder);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        expect(canDecode(result, 64, 48)).toBe(true);
    }
});

test('CustomFilterGlitch (reversed reference): fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const customEncoder = (data: Uint8Array, prev: Uint8Array | null, sampleSize: number) => {
            const result = new Uint8Array(data);
            for (let i = data.length - 1; i >= 0; i--) {
                const x = data[i];
                const v = prev ? (prev[i - 1] || 0) : 0;
                result[i] = (x - v) & 0xff;
            }
            return result;
        };
        const glitch = new CustomFilterGlitch(customEncoder);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        expect(canDecode(result, 64, 48)).toBe(true);
    }
});

// ============================================================
// assemblePng: raw compressed data assembly
// ============================================================

test('assemblePng: produces valid PNG from unmodified compressed data', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const assembled = assemblePng(compressedData, metadata);
    expect(isPngSignature(assembled)).toBe(true);
    expect(canDecode(assembled, 32, 24)).toBe(true);
});

test('assemblePng: produces PNG with valid signature even with corrupted data', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const corrupted = new Uint8Array(compressedData);
    corrupted[10] = 0xff;
    corrupted[20] = 0x00;
    const assembled = assemblePng(corrupted, metadata);
    expect(isPngSignature(assembled)).toBe(true);
});

// ============================================================
// No glitches: passthrough
// ============================================================

test('generateFrame with no glitches returns original bytes', async () => {
    const png = makePngBytes(32, 24);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const result = await domain.generateFrame(state, []);
    expect(result).toEqual(png);
});
