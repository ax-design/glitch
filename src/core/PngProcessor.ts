import { unzlibSync, zlibSync } from 'fflate';

export interface ScanlineInfo {
    filterTypeOffset: number;
    dataStart: number;
    dataLength: number;
    passIndex?: number;
}

export interface PngMetadata {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    sampleSize: number;
    interlaced: boolean;
    headBytes: Uint8Array;
    tailBytes: Uint8Array;
}

export interface PngChunkLayout {
    metadata: PngMetadata;
    compressedData: Uint8Array;
}

const COLOR_TYPE_SAMPLE_SIZE: Record<number, number> = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
};

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        if (c & 1) {
            c = 0xedb88320 ^ (c >>> 1);
        } else {
            c = c >>> 1;
        }
    }
    CRC_TABLE[i] = c;
}

function crc32(data: Uint8Array, seed: number = 0xffffffff): number {
    let crc = seed;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return crc;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    const len = arrays.length;
    for (let i = 0; i < len; i++) totalLength += arrays[i].length;
    
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < len; i++) {
        const arr = arrays[i];
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

export function parsePngChunks(bytes: Uint8Array): PngChunkLayout {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== signature[i]) {
            throw new Error('Invalid PNG signature');
        }
    }

    const headParts: Uint8Array[] = [bytes.subarray(0, 8)];
    const tailParts: Uint8Array[] = [];
    const idatParts: Uint8Array[] = [];
    let metadata: PngMetadata | null = null;
    let foundIdat = false;

    let pos = 8;
    while (pos < bytes.length) {
        const length = readUint32BE(bytes, pos);
        const typeStart = pos + 4;
        const type = String.fromCharCode(bytes[typeStart], bytes[typeStart + 1], bytes[typeStart + 2], bytes[typeStart + 3]);
        const dataStart = typeStart + 4;
        const chunkEnd = dataStart + length + 4;

        if (type === 'IHDR') {
            const width = readUint32BE(bytes, dataStart);
            const height = readUint32BE(bytes, dataStart + 4);
            const bitDepth = bytes[dataStart + 8];
            const colorType = bytes[dataStart + 9];
            const interlaced = bytes[dataStart + 12] === 1;
            const sampleSize = COLOR_TYPE_SAMPLE_SIZE[colorType] ?? 1;

            metadata = { width, height, bitDepth, colorType, sampleSize, interlaced, headBytes: new Uint8Array(0), tailBytes: new Uint8Array(0) };
        }

        if (type === 'IDAT') {
            idatParts.push(bytes.subarray(dataStart, dataStart + length));
            foundIdat = true;
        } else if (foundIdat) {
            tailParts.push(bytes.subarray(pos, chunkEnd));
        } else {
            headParts.push(bytes.subarray(pos, chunkEnd));
        }

        pos = chunkEnd;
    }

    if (!metadata) throw new Error('Missing IHDR chunk');
    if (idatParts.length === 0) throw new Error('Missing IDAT chunk');

    metadata.headBytes = concatUint8Arrays(headParts);
    metadata.tailBytes = concatUint8Arrays(tailParts);

    return {
        metadata,
        compressedData: concatUint8Arrays(idatParts),
    };
}

export async function inflateCompressed(data: Uint8Array): Promise<Uint8Array> {
    return unzlibSync(data);
}

export async function deflateFiltered(data: Uint8Array): Promise<Uint8Array> {
    // Level 0 (no compression) is much faster and reduces CPU usage significantly for animations.
    return zlibSync(data, { level: 0 });
}

export function computeScanlines(filteredData: Uint8Array, metadata: PngMetadata): ScanlineInfo[] {
    if (metadata.interlaced) {
        return computeInterlacedScanlines(filteredData, metadata);
    }

    const scanlines: ScanlineInfo[] = [];
    const bytesPerRow = metadata.width * metadata.sampleSize;
    const stride = 1 + bytesPerRow;

    for (let row = 0; row < metadata.height; row++) {
        const base = row * stride;
        scanlines.push({
            filterTypeOffset: base,
            dataStart: base + 1,
            dataLength: bytesPerRow,
        });
    }

    return scanlines;
}

function computeInterlacedScanlines(filteredData: Uint8Array, metadata: PngMetadata): ScanlineInfo[] {
    const passDimensions = [
        { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
        { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
        { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
        { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
        { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
        { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
        { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
    ];

    const scanlines: ScanlineInfo[] = [];
    let offset = 0;

    for (let passIdx = 0; passIdx < passDimensions.length; passIdx++) {
        const pass = passDimensions[passIdx];
        const passWidth = Math.ceil((metadata.width - pass.xStart) / pass.xStep);
        const passHeight = Math.ceil((metadata.height - pass.yStart) / pass.yStep);
        if (passWidth <= 0 || passHeight <= 0) continue;

        const bytesPerRow = passWidth * metadata.sampleSize;
        const stride = 1 + bytesPerRow;

        for (let row = 0; row < passHeight; row++) {
            scanlines.push({
                filterTypeOffset: offset,
                dataStart: offset + 1,
                dataLength: bytesPerRow,
                passIndex: passIdx,
            });
            offset += stride;
        }
    }

    return scanlines;
}

function filterNoneEncode(data: Uint8Array): Uint8Array {
    return data;
}

function filterNoneDecode(data: Uint8Array): Uint8Array {
    return data;
}

function filterSubEncode(data: Uint8Array, sampleSize: number, out: Uint8Array): void {
    out.set(data);
    for (let i = data.length - 1; i >= sampleSize; i--) {
        out[i] = (data[i] - data[i - sampleSize]) & 0xff;
    }
}

function filterSubDecode(data: Uint8Array, sampleSize: number, out: Uint8Array): void {
    out.set(data);
    for (let i = sampleSize; i < data.length; i++) {
        out[i] = (out[i] + out[i - sampleSize]) & 0xff;
    }
}

function filterUpEncode(data: Uint8Array, prev: Uint8Array | null, out: Uint8Array): void {
    if (!prev) {
        out.set(data);
        return;
    }
    for (let i = 0; i < data.length; i++) {
        out[i] = (data[i] - prev[i]) & 0xff;
    }
}

function filterUpDecode(data: Uint8Array, prev: Uint8Array | null, out: Uint8Array): void {
    if (!prev) {
        out.set(data);
        return;
    }
    for (let i = 0; i < data.length; i++) {
        out[i] = (data[i] + prev[i]) & 0xff;
    }
}

function filterAverageEncode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number, out: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
        const a = i >= sampleSize ? data[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        out[i] = (data[i] - (((a + b) / 2) | 0)) & 0xff;
    }
}

function filterAverageDecode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number, out: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
        const a = i >= sampleSize ? out[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        out[i] = (data[i] + (((a + b) / 2) | 0)) & 0xff;
    }
}

function paethPredictor(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function filterPaethEncode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number, out: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
        const a = i >= sampleSize ? data[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        const c = (i >= sampleSize && prev) ? prev[i - sampleSize] : 0;
        out[i] = (data[i] - paethPredictor(a, b, c)) & 0xff;
    }
}

function filterPaethDecode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number, out: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
        const a = i >= sampleSize ? out[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        const c = (i >= sampleSize && prev) ? prev[i - sampleSize] : 0;
        out[i] = (data[i] + paethPredictor(a, b, c)) & 0xff;
    }
}

export type FilterFunction = (data: Uint8Array, prev: Uint8Array | null, sampleSize: number) => Uint8Array;

export function decodeFilter(filterType: number, data: Uint8Array, prev: Uint8Array | null, sampleSize: number, out: Uint8Array): void {
    switch (filterType) {
        case 0: out.set(data); break;
        case 1: filterSubDecode(data, sampleSize, out); break;
        case 2: filterUpDecode(data, prev, out); break;
        case 3: filterAverageDecode(data, prev, sampleSize, out); break;
        case 4: filterPaethDecode(data, prev, sampleSize, out); break;
        default: out.set(data); break;
    }
}

export function encodeFilter(filterType: number, data: Uint8Array, prev: Uint8Array | null, sampleSize: number, out: Uint8Array): void {
    switch (filterType) {
        case 0: out.set(data); break;
        case 1: filterSubEncode(data, sampleSize, out); break;
        case 2: filterUpEncode(data, prev, out); break;
        case 3: filterAverageEncode(data, prev, sampleSize, out); break;
        case 4: filterPaethEncode(data, prev, sampleSize, out); break;
        default: out.set(data); break;
    }
}

export function reencodeWithFilter(
    filteredData: Uint8Array,
    scanlines: ScanlineInfo[],
    metadata: PngMetadata,
    targetFilterType: number,
): Uint8Array {
    const result = new Uint8Array(filteredData.length);
    const maxDataLength = Math.max(...scanlines.map(s => s.dataLength));
    const decodedBuf = new Uint8Array(maxDataLength);
    const prevBuf = new Uint8Array(maxDataLength);
    const reencodedBuf = new Uint8Array(maxDataLength);

    let hasPrev = false;
    let lastPass = -1;

    for (const scanline of scanlines) {
        if (scanline.passIndex !== undefined && scanline.passIndex !== lastPass) {
            hasPrev = false;
            lastPass = scanline.passIndex;
        }

        const currentFilterType = filteredData[scanline.filterTypeOffset];
        const currentData = filteredData.subarray(scanline.dataStart, scanline.dataStart + scanline.dataLength);
        const lineDecoded = decodedBuf.subarray(0, scanline.dataLength);
        const linePrev = hasPrev ? prevBuf.subarray(0, scanline.dataLength) : null;
        const lineReencoded = reencodedBuf.subarray(0, scanline.dataLength);

        decodeFilter(currentFilterType, currentData, linePrev, metadata.sampleSize, lineDecoded);
        encodeFilter(targetFilterType, lineDecoded, linePrev, metadata.sampleSize, lineReencoded);

        result[scanline.filterTypeOffset] = targetFilterType;
        result.set(lineReencoded, scanline.dataStart);

        prevBuf.set(lineDecoded);
        hasPrev = true;
    }

    return result;
}

export function reencodeWithCustomFilter(
    filteredData: Uint8Array,
    scanlines: ScanlineInfo[],
    metadata: PngMetadata,
    customEncoder: FilterFunction,
    scanlineRange?: { min: number; max: number },
): Uint8Array {
    const result = new Uint8Array(filteredData.length);
    const maxDataLength = Math.max(...scanlines.map(s => s.dataLength));
    const decodedBuf = new Uint8Array(maxDataLength);
    const prevBuf = new Uint8Array(maxDataLength);

    let hasPrev = false;
    let lastPass = -1;

    for (let i = 0; i < scanlines.length; i++) {
        const scanline = scanlines[i];
        if (scanline.passIndex !== undefined && scanline.passIndex !== lastPass) {
            hasPrev = false;
            lastPass = scanline.passIndex;
        }

        const currentFilterType = filteredData[scanline.filterTypeOffset];
        const currentData = filteredData.subarray(scanline.dataStart, scanline.dataStart + scanline.dataLength);
        const lineDecoded = decodedBuf.subarray(0, scanline.dataLength);
        const linePrev = hasPrev ? prevBuf.subarray(0, scanline.dataLength) : null;

        decodeFilter(currentFilterType, currentData, linePrev, metadata.sampleSize, lineDecoded);

        const inRange = scanlineRange
            ? i >= scanlineRange.min && i <= scanlineRange.max
            : true;

        result[scanline.filterTypeOffset] = currentFilterType;
        if (inRange) {
            const reencoded = customEncoder(lineDecoded, linePrev, metadata.sampleSize);
            result.set(reencoded, scanline.dataStart);
        } else {
            result.set(currentData, scanline.dataStart);
        }

        prevBuf.set(lineDecoded);
        hasPrev = true;
    }

    return result;
}

export function computeAdler32(data: Uint8Array): number {
    let s1 = 1;
    let s2 = 0;
    for (let i = 0; i < data.length; i++) {
        s1 = (s1 + data[i]) % 65521;
        s2 = (s2 + s1) % 65521;
    }
    return ((s2 << 16) | s1) >>> 0;
}

export async function rebuildPng(filteredData: Uint8Array, metadata: PngMetadata): Promise<Uint8Array> {
    const compressed = await deflateFiltered(filteredData);
    return assemblePng(compressed, metadata);
}

export function assemblePng(compressedData: Uint8Array, metadata: PngMetadata): Uint8Array {
    const typeBytes = new Uint8Array([73, 68, 65, 84]);
    
    // Calculate CRC32 of [Type][Data]
    let crcRaw = crc32(typeBytes);
    crcRaw = crc32(compressedData, crcRaw);
    const finalCrc = (crcRaw ^ 0xffffffff) >>> 0;

    const idatLength = new Uint8Array(4);
    idatLength[0] = (compressedData.length >>> 24) & 0xff;
    idatLength[1] = (compressedData.length >>> 16) & 0xff;
    idatLength[2] = (compressedData.length >>> 8) & 0xff;
    idatLength[3] = compressedData.length & 0xff;

    const idatCrc = new Uint8Array(4);
    idatCrc[0] = (finalCrc >>> 24) & 0xff;
    idatCrc[1] = (finalCrc >>> 16) & 0xff;
    idatCrc[2] = (finalCrc >>> 8) & 0xff;
    idatCrc[3] = finalCrc & 0xff;

    const parts = [
        metadata.headBytes,
        idatLength,
        typeBytes,
        compressedData,
        idatCrc,
        metadata.tailBytes,
    ];

    return concatUint8Arrays(parts);
}

export function buildFilteredDataPool(filteredData: Uint8Array, scanlines: ScanlineInfo[]): import('../params/Pool.js').VirtualPool {
    const length = filteredData.length - scanlines.length;
    const offsets = scanlines.map(s => s.filterTypeOffset);
    const dataLengths = scanlines.map(s => s.dataLength);
    const cumPixelCounts = new Uint32Array(scanlines.length + 1);
    for (let i = 0; i < scanlines.length; i++) {
        cumPixelCounts[i + 1] = cumPixelCounts[i] + dataLengths[i];
    }

    return {
        length,
        scanlineOffsets: offsets,
        resolve(index: number): number {
            // Find which scanline this index belongs to using binary search on cumPixelCounts
            let low = 0;
            let high = scanlines.length - 1;
            let sIdx = 0;
            while (low <= high) {
                const mid = (low + high) >>> 1;
                if (index >= cumPixelCounts[mid]) {
                    sIdx = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            const offsetInScanline = index - cumPixelCounts[sIdx];
            return scanlines[sIdx].dataStart + offsetInScanline;
        },
    };
}

export function buildFilterTypePool(scanlines: ScanlineInfo[]): number[] {
    return scanlines.map(s => s.filterTypeOffset);
}
