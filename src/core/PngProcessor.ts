import { unzlibSync, zlibSync } from 'fflate';

export interface ScanlineInfo {
    filterTypeOffset: number;
    dataStart: number;
    dataLength: number;
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

function crc32(data: Uint8Array, seed: number = 0): number {
    let crc = seed ^ 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const arr of arrays) totalLength += arr.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
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

    const headParts: Uint8Array[] = [bytes.slice(0, 8)];
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
            idatParts.push(bytes.slice(dataStart, dataStart + length));
            foundIdat = true;
        } else if (foundIdat) {
            tailParts.push(bytes.slice(pos, chunkEnd));
        } else {
            headParts.push(bytes.slice(pos, chunkEnd));
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
    return zlibSync(data, { level: 1 });
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

    for (const pass of passDimensions) {
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
            });
            offset += stride;
        }
    }

    return scanlines;
}

function filterNoneEncode(data: Uint8Array): Uint8Array {
    return new Uint8Array(data);
}

function filterNoneDecode(data: Uint8Array): Uint8Array {
    return new Uint8Array(data);
}

function filterSubEncode(data: Uint8Array, sampleSize: number): Uint8Array {
    const result = new Uint8Array(data);
    for (let i = data.length - 1; i >= sampleSize; i--) {
        result[i] = (data[i] - data[i - sampleSize]) & 0xff;
    }
    return result;
}

function filterSubDecode(data: Uint8Array, sampleSize: number): Uint8Array {
    const result = new Uint8Array(data);
    for (let i = sampleSize; i < data.length; i++) {
        result[i] = (result[i] + result[i - sampleSize]) & 0xff;
    }
    return result;
}

function filterUpEncode(data: Uint8Array, prev: Uint8Array | null): Uint8Array {
    if (!prev) return new Uint8Array(data);
    const result = new Uint8Array(data);
    for (let i = data.length - 1; i >= 0; i--) {
        result[i] = (data[i] - prev[i]) & 0xff;
    }
    return result;
}

function filterUpDecode(data: Uint8Array, prev: Uint8Array | null): Uint8Array {
    if (!prev) return new Uint8Array(data);
    const result = new Uint8Array(data);
    for (let i = 0; i < data.length; i++) {
        result[i] = (result[i] + prev[i]) & 0xff;
    }
    return result;
}

function filterAverageEncode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number): Uint8Array {
    const result = new Uint8Array(data);
    for (let i = data.length - 1; i >= 0; i--) {
        const a = i >= sampleSize ? data[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        result[i] = (data[i] - (((a + b) / 2) | 0)) & 0xff;
    }
    return result;
}

function filterAverageDecode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number): Uint8Array {
    const result = new Uint8Array(data);
    for (let i = 0; i < data.length; i++) {
        const a = i >= sampleSize ? result[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        result[i] = (result[i] + (((a + b) / 2) | 0)) & 0xff;
    }
    return result;
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

function filterPaethEncode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number): Uint8Array {
    const result = new Uint8Array(data);
    for (let i = data.length - 1; i >= 0; i--) {
        const a = i >= sampleSize ? data[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        const c = (i >= sampleSize && prev) ? prev[i - sampleSize] : 0;
        result[i] = (data[i] - paethPredictor(a, b, c)) & 0xff;
    }
    return result;
}

function filterPaethDecode(data: Uint8Array, prev: Uint8Array | null, sampleSize: number): Uint8Array {
    const result = new Uint8Array(data);
    for (let i = 0; i < data.length; i++) {
        const a = i >= sampleSize ? result[i - sampleSize] : 0;
        const b = prev ? prev[i] : 0;
        const c = (i >= sampleSize && prev) ? prev[i - sampleSize] : 0;
        result[i] = (result[i] + paethPredictor(a, b, c)) & 0xff;
    }
    return result;
}

export type FilterFunction = (data: Uint8Array, prev: Uint8Array | null, sampleSize: number) => Uint8Array;

const ENCODE_FILTERS: Record<number, FilterFunction> = {
    0: (data) => filterNoneEncode(data),
    1: (data, _prev, sampleSize) => filterSubEncode(data, sampleSize),
    2: (data, prev) => filterUpEncode(data, prev),
    3: (data, prev, sampleSize) => filterAverageEncode(data, prev, sampleSize),
    4: (data, prev, sampleSize) => filterPaethEncode(data, prev, sampleSize),
};

const DECODE_FILTERS: Record<number, FilterFunction> = {
    0: (data) => filterNoneDecode(data),
    1: (data, _prev, sampleSize) => filterSubDecode(data, sampleSize),
    2: (data, prev) => filterUpDecode(data, prev),
    3: (data, prev, sampleSize) => filterAverageDecode(data, prev, sampleSize),
    4: (data, prev, sampleSize) => filterPaethDecode(data, prev, sampleSize),
};

export function decodeFilter(filterType: number, data: Uint8Array, prev: Uint8Array | null, sampleSize: number): Uint8Array {
    const fn = DECODE_FILTERS[filterType];
    if (!fn) return new Uint8Array(data);
    return fn(data, prev, sampleSize);
}

export function encodeFilter(filterType: number, data: Uint8Array, prev: Uint8Array | null, sampleSize: number): Uint8Array {
    const fn = ENCODE_FILTERS[filterType];
    if (!fn) return new Uint8Array(data);
    return fn(data, prev, sampleSize);
}

export function reencodeWithFilter(
    filteredData: Uint8Array,
    scanlines: ScanlineInfo[],
    metadata: PngMetadata,
    targetFilterType: number,
): Uint8Array {
    const result = new Uint8Array(filteredData.length);
    let prevDecoded: Uint8Array | null = null;

    for (const scanline of scanlines) {
        const currentFilterType = filteredData[scanline.filterTypeOffset];
        const currentData = filteredData.slice(scanline.dataStart, scanline.dataStart + scanline.dataLength);

        const decoded = decodeFilter(currentFilterType, currentData, prevDecoded, metadata.sampleSize);

        const reencoded = encodeFilter(targetFilterType, decoded, prevDecoded, metadata.sampleSize);

        result[scanline.filterTypeOffset] = targetFilterType;
        result.set(reencoded, scanline.dataStart);

        prevDecoded = decoded;
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
    let prevDecoded: Uint8Array | null = null;

    for (let i = 0; i < scanlines.length; i++) {
        const scanline = scanlines[i];
        const currentFilterType = filteredData[scanline.filterTypeOffset];
        const currentData = filteredData.slice(scanline.dataStart, scanline.dataStart + scanline.dataLength);

        const decoded = decodeFilter(currentFilterType, currentData, prevDecoded, metadata.sampleSize);

        const inRange = scanlineRange
            ? i >= scanlineRange.min && i <= scanlineRange.max
            : true;

        if (inRange) {
            const reencoded = customEncoder(decoded, prevDecoded, metadata.sampleSize);
            result[scanline.filterTypeOffset] = currentFilterType;
            result.set(reencoded, scanline.dataStart);
        } else {
            result[scanline.filterTypeOffset] = currentFilterType;
            result.set(currentData, scanline.dataStart);
        }

        prevDecoded = decoded;
    }

    return result;
}

export async function rebuildPng(filteredData: Uint8Array, metadata: PngMetadata): Promise<Uint8Array> {
    const compressed = await deflateFiltered(filteredData);
    return assemblePng(compressed, metadata);
}

function assemblePng(compressedData: Uint8Array, metadata: PngMetadata): Uint8Array {
    const typeBytes = new Uint8Array([73, 68, 65, 84]);
    const crcBase = crc32(typeBytes);
    const dataCrc = crc32(compressedData, crcBase);

    const idatLength = new Uint8Array(4);
    idatLength[0] = (compressedData.length >>> 24) & 0xff;
    idatLength[1] = (compressedData.length >>> 16) & 0xff;
    idatLength[2] = (compressedData.length >>> 8) & 0xff;
    idatLength[3] = compressedData.length & 0xff;

    const idatCrc = new Uint8Array(4);
    idatCrc[0] = (dataCrc >>> 24) & 0xff;
    idatCrc[1] = (dataCrc >>> 16) & 0xff;
    idatCrc[2] = (dataCrc >>> 8) & 0xff;
    idatCrc[3] = dataCrc & 0xff;

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
    const bytesPerRow = scanlines.length > 0 ? scanlines[0].dataLength : 0;
    const length = filteredData.length - scanlines.length;
    return {
        length,
        resolve(index: number): number {
            const scanline = Math.floor(index / bytesPerRow);
            return index + scanline + 1;
        },
    };
}

export function buildFilterTypePool(scanlines: ScanlineInfo[]): number[] {
    return scanlines.map(s => s.filterTypeOffset);
}
