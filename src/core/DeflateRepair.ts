import { unzlibSync } from 'fflate';
import { computeAdler32 } from './PngProcessor.js';

export type DeflateSymbolKind = 'literal' | 'match' | 'eob' | 'stored';

export interface DeflateSymbolTrace {
    kind: DeflateSymbolKind;
    blockIndex: number;
    symbolIndex: number;
    bitStart: number;
    bitEnd: number;
    outputStart: number;
    outputEnd: number;
    literal?: number;
    length?: number;
    distance?: number;
}

export interface DeflateBlockTrace {
    index: number;
    bfinal: boolean;
    btype: 0 | 1 | 2;
    bitStart: number;
    bitEnd: number;
    bodyBitStart: number;
    bodyBitEnd: number;
    outputStart: number;
    outputEnd: number;
    treeBitStart?: number;
    treeBitEnd?: number;
    symbolStartIndex: number;
    symbolEndIndex: number;
}

export interface DeflateCheckpoint {
    blockIndex: number;
    symbolIndex: number;
    bitOffset: number;
    outputLength: number;
}

export interface DeflateParseErrorInfo {
    message: string;
    bitOffset: number;
    blockIndex: number;
    symbolIndex: number;
    outputLength: number;
}

export interface ZlibEnvelope {
    header: Uint8Array;
    payload: Uint8Array;
    footer: Uint8Array;
    providedAdler32: number;
}

interface ZlibTraceBase {
    envelope: ZlibEnvelope;
    output: Uint8Array;
    blocks: DeflateBlockTrace[];
    symbols: DeflateSymbolTrace[];
    checkpoints: DeflateCheckpoint[];
    payloadBitLength: number;
    computedAdler32: number;
}

export interface ZlibTraceSuccess extends ZlibTraceBase {
    ok: true;
}

export interface ZlibTraceFailure extends ZlibTraceBase {
    ok: false;
    error: DeflateParseErrorInfo;
}

export type ZlibTraceResult = ZlibTraceSuccess | ZlibTraceFailure;

export interface DeflateRepairAcceptance {
    ok: boolean;
    anchorOutputOffset?: number;
}

export interface DeflateRepairResult {
    ok: boolean;
    compressedData: Uint8Array;
    filteredData: Uint8Array;
    trace: ZlibTraceSuccess;
    repaired: boolean;
    strategy: string;
}

interface RepairAttempt {
    mode: 'replace' | 'suffix';
    startBit: number;
    endBit: number;
    name: string;
}

class DeflateParseError extends Error {
    readonly bitOffset: number;
    readonly blockIndex: number;
    readonly symbolIndex: number;
    readonly outputLength: number;

    constructor(message: string, bitOffset: number, blockIndex: number, symbolIndex: number, outputLength: number) {
        super(message);
        this.name = 'DeflateParseError';
        this.bitOffset = bitOffset;
        this.blockIndex = blockIndex;
        this.symbolIndex = symbolIndex;
        this.outputLength = outputLength;
    }
}

class BitReader {
    readonly bytes: Uint8Array;
    bitOffset = 0;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
    }

    get bitLength(): number {
        return this.bytes.length * 8;
    }

    get byteOffset(): number {
        return this.bitOffset >>> 3;
    }

    readBits(count: number): number {
        if (count < 0 || count > 24) {
            throw new Error(`Unsupported bit count: ${count}`);
        }
        let value = 0;
        for (let i = 0; i < count; i++) {
            if (this.bitOffset >= this.bitLength) {
                throw new DeflateParseError('Unexpected end of Deflate stream', this.bitOffset, -1, -1, -1);
            }
            const byte = this.bytes[this.bitOffset >>> 3];
            const bit = (byte >>> (this.bitOffset & 7)) & 1;
            value |= bit << i;
            this.bitOffset++;
        }
        return value;
    }

    alignByte(): void {
        this.bitOffset = (this.bitOffset + 7) & ~7;
    }

    readAlignedBytes(count: number): Uint8Array {
        if ((this.bitOffset & 7) !== 0) {
            throw new Error('BitReader is not byte-aligned');
        }
        const start = this.byteOffset;
        const end = start + count;
        if (end > this.bytes.length) {
            throw new DeflateParseError('Unexpected end of stored block', this.bitOffset, -1, -1, -1);
        }
        this.bitOffset += count * 8;
        return this.bytes.slice(start, end);
    }
}

class OutputBuffer {
    private bytes = new Uint8Array(1024);
    length = 0;

    private ensureCapacity(extra: number): void {
        const needed = this.length + extra;
        if (needed <= this.bytes.length) return;
        let size = this.bytes.length;
        while (size < needed) {
            size *= 2;
        }
        const next = new Uint8Array(size);
        next.set(this.bytes.subarray(0, this.length));
        this.bytes = next;
    }

    pushByte(value: number): void {
        this.ensureCapacity(1);
        this.bytes[this.length++] = value & 0xff;
    }

    pushBytes(values: Uint8Array): void {
        this.ensureCapacity(values.length);
        this.bytes.set(values, this.length);
        this.length += values.length;
    }

    copyMatch(distance: number, length: number): void {
        if (distance <= 0 || distance > this.length) {
            throw new DeflateParseError(`Invalid distance: ${distance}`, -1, -1, -1, this.length);
        }
        this.ensureCapacity(length);
        for (let i = 0; i < length; i++) {
            const src = this.length - distance;
            this.bytes[this.length++] = this.bytes[src];
        }
    }

    toUint8Array(): Uint8Array {
        return this.bytes.slice(0, this.length);
    }
}

interface HuffmanTree {
    entries: Map<number, number>;
    maxLength: number;
    empty: boolean;
}

const LENGTH_BASES = [
    3, 4, 5, 6, 7, 8, 9, 10,
    11, 13, 15, 17,
    19, 23, 27, 31,
    35, 43, 51, 59,
    67, 83, 99, 115,
    131, 163, 195, 227,
    258,
] as const;

const LENGTH_EXTRA_BITS = [
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1,
    2, 2, 2, 2,
    3, 3, 3, 3,
    4, 4, 4, 4,
    5, 5, 5, 5,
    0,
] as const;

const DISTANCE_BASES = [
    1, 2, 3, 4, 5, 7, 9, 13,
    17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073,
    4097, 6145, 8193, 12289, 16385, 24577,
] as const;

const DISTANCE_EXTRA_BITS = [
    0, 0, 0, 0, 1, 1, 2, 2,
    3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13,
] as const;

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;
const FIXED_LITERAL_LENGTHS = buildFixedLiteralLengths();
const FIXED_DISTANCE_LENGTHS = new Array(32).fill(5);
const FIXED_LITERAL_TREE = buildHuffmanTree(FIXED_LITERAL_LENGTHS);
const FIXED_DISTANCE_TREE = buildHuffmanTree(FIXED_DISTANCE_LENGTHS);

function buildFixedLiteralLengths(): number[] {
    const lengths = new Array(288).fill(0);
    for (let i = 0; i <= 143; i++) lengths[i] = 8;
    for (let i = 144; i <= 255; i++) lengths[i] = 9;
    for (let i = 256; i <= 279; i++) lengths[i] = 7;
    for (let i = 280; i <= 287; i++) lengths[i] = 8;
    return lengths;
}

function reverseBits(code: number, length: number): number {
    let reversed = 0;
    for (let i = 0; i < length; i++) {
        reversed = (reversed << 1) | ((code >>> i) & 1);
    }
    return reversed;
}

function buildHuffmanTree(lengths: number[]): HuffmanTree {
    let maxLength = 0;
    let usedSymbols = 0;
    for (const length of lengths) {
        if (length > maxLength) maxLength = length;
        if (length > 0) usedSymbols++;
    }
    if (maxLength === 0) {
        return { entries: new Map(), maxLength: 0, empty: true };
    }

    const blCount = new Array(maxLength + 1).fill(0);
    for (const length of lengths) {
        if (length > 0) blCount[length]++;
    }

    let left = 1;
    for (let bits = 1; bits <= maxLength; bits++) {
        left = (left << 1) - blCount[bits];
        if (left < 0) {
            throw new Error('Oversubscribed Huffman tree');
        }
    }
    if (left > 0 && usedSymbols > 1) {
        throw new Error('Incomplete Huffman tree');
    }

    const nextCode = new Array(maxLength + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxLength; bits++) {
        code = (code + blCount[bits - 1]) << 1;
        nextCode[bits] = code;
    }

    const entries = new Map<number, number>();
    for (let symbol = 0; symbol < lengths.length; symbol++) {
        const length = lengths[symbol];
        if (length === 0) continue;
        const canonical = nextCode[length]++;
        if (canonical >= (1 << length)) {
            throw new Error('Oversubscribed Huffman tree');
        }
        const reversed = reverseBits(canonical, length);
        const key = (length << 16) | reversed;
        if (entries.has(key)) {
            throw new Error('Duplicate Huffman code');
        }
        entries.set(key, symbol);
    }

    return { entries, maxLength, empty: false };
}

function decodeSymbol(reader: BitReader, tree: HuffmanTree, blockIndex: number, symbolIndex: number, outputLength: number): number {
    if (tree.empty) {
        throw new DeflateParseError('Missing Huffman tree', reader.bitOffset, blockIndex, symbolIndex, outputLength);
    }
    let code = 0;
    for (let length = 1; length <= tree.maxLength; length++) {
        code |= reader.readBits(1) << (length - 1);
        const symbol = tree.entries.get((length << 16) | code);
        if (symbol !== undefined) {
            return symbol;
        }
    }
    throw new DeflateParseError('Invalid Huffman code', reader.bitOffset, blockIndex, symbolIndex, outputLength);
}

function readLength(reader: BitReader, symbol: number, blockIndex: number, symbolIndex: number, outputLength: number): number {
    if (symbol < 257 || symbol > 285) {
        throw new DeflateParseError(`Invalid length symbol: ${symbol}`, reader.bitOffset, blockIndex, symbolIndex, outputLength);
    }
    if (symbol === 285) return 258;
    const tableIndex = symbol - 257;
    const extraBits = LENGTH_EXTRA_BITS[tableIndex];
    return LENGTH_BASES[tableIndex] + reader.readBits(extraBits);
}

function readDistance(reader: BitReader, symbol: number, blockIndex: number, symbolIndex: number, outputLength: number): number {
    if (symbol < 0 || symbol >= DISTANCE_BASES.length) {
        throw new DeflateParseError(`Invalid distance symbol: ${symbol}`, reader.bitOffset, blockIndex, symbolIndex, outputLength);
    }
    const extraBits = DISTANCE_EXTRA_BITS[symbol];
    return DISTANCE_BASES[symbol] + reader.readBits(extraBits);
}

function readAdler32(footer: Uint8Array): number {
    if (footer.length !== 4) return 0;
    return ((footer[0] << 24) | (footer[1] << 16) | (footer[2] << 8) | footer[3]) >>> 0;
}

function rewriteAdler32Internal(stream: Uint8Array, adler32: number): Uint8Array {
    const next = new Uint8Array(stream);
    next[next.length - 4] = (adler32 >>> 24) & 0xff;
    next[next.length - 3] = (adler32 >>> 16) & 0xff;
    next[next.length - 2] = (adler32 >>> 8) & 0xff;
    next[next.length - 1] = adler32 & 0xff;
    return next;
}

export function splitZlibStream(data: Uint8Array): ZlibEnvelope {
    if (data.length < 6) {
        throw new Error('Zlib stream too short');
    }
    const header = data.slice(0, 2);
    const payload = data.slice(2, data.length - 4);
    const footer = data.slice(data.length - 4);
    return {
        header,
        payload,
        footer,
        providedAdler32: readAdler32(footer),
    };
}

function verifyZlibHeader(header: Uint8Array): void {
    if (header.length !== 2) {
        throw new Error('Invalid zlib header length');
    }
    const cmf = header[0];
    const flg = header[1];
    if ((cmf & 0x0f) !== 8) {
        throw new Error(`Unsupported zlib compression method: ${cmf & 0x0f}`);
    }
    if ((((cmf << 8) | flg) % 31) !== 0) {
        throw new Error('Invalid zlib header checksum');
    }
}

function toParseError(error: unknown, reader: BitReader, blockIndex: number, symbolIndex: number, outputLength: number): DeflateParseError {
    if (error instanceof DeflateParseError) {
        const bitOffset = error.bitOffset >= 0 ? error.bitOffset : reader.bitOffset;
        const block = error.blockIndex >= 0 ? error.blockIndex : blockIndex;
        const symbol = error.symbolIndex >= 0 ? error.symbolIndex : symbolIndex;
        const outLen = error.outputLength >= 0 ? error.outputLength : outputLength;
        return new DeflateParseError(error.message, bitOffset, block, symbol, outLen);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DeflateParseError(message, reader.bitOffset, blockIndex, symbolIndex, outputLength);
}

function recordCheckpoint(checkpoints: DeflateCheckpoint[], blockIndex: number, symbolIndex: number, bitOffset: number, outputLength: number, interval: number): void {
    if (interval <= 0) return;
    if (symbolIndex === 0 || (symbolIndex % interval) === 0) {
        checkpoints.push({ blockIndex, symbolIndex, bitOffset, outputLength });
    }
}

function ensureZeroPadding(_reader: BitReader, _blockIndex: number, _symbolIndex: number, _outputLength: number): void {
    // RFC 1951 allows the final Deflate byte to contain unused padding bits.
    // They are not semantically part of the stream, so we intentionally ignore them.
}

function decodeDynamicTrees(reader: BitReader, blockIndex: number, symbolIndex: number, outputLength: number): {
    literalTree: HuffmanTree;
    distanceTree: HuffmanTree;
    treeBitStart: number;
    treeBitEnd: number;
} {
    const treeBitStart = reader.bitOffset;
    const hlit = reader.readBits(5) + 257;
    const hdist = reader.readBits(5) + 1;
    const hclen = reader.readBits(4) + 4;

    const codeLengthLengths = new Array(19).fill(0);
    for (let i = 0; i < hclen; i++) {
        codeLengthLengths[CODE_LENGTH_ORDER[i]] = reader.readBits(3);
    }

    const codeLengthTree = buildHuffmanTree(codeLengthLengths);
    const lengths: number[] = [];
    const total = hlit + hdist;
    while (lengths.length < total) {
        const symbol = decodeSymbol(reader, codeLengthTree, blockIndex, symbolIndex, outputLength);
        if (symbol <= 15) {
            lengths.push(symbol);
            continue;
        }
        if (symbol === 16) {
            if (lengths.length === 0) {
                throw new DeflateParseError('Repeat-without-previous in code lengths', reader.bitOffset, blockIndex, symbolIndex, outputLength);
            }
            const repeat = reader.readBits(2) + 3;
            const previous = lengths[lengths.length - 1];
            for (let i = 0; i < repeat; i++) lengths.push(previous);
            continue;
        }
        if (symbol === 17) {
            const repeat = reader.readBits(3) + 3;
            for (let i = 0; i < repeat; i++) lengths.push(0);
            continue;
        }
        if (symbol === 18) {
            const repeat = reader.readBits(7) + 11;
            for (let i = 0; i < repeat; i++) lengths.push(0);
            continue;
        }
        throw new DeflateParseError(`Invalid code length symbol: ${symbol}`, reader.bitOffset, blockIndex, symbolIndex, outputLength);
    }

    const literalLengths = lengths.slice(0, hlit);
    while (literalLengths.length < 288) literalLengths.push(0);
    const distanceLengths = lengths.slice(hlit, hlit + hdist);
    while (distanceLengths.length < 32) distanceLengths.push(0);

    return {
        literalTree: buildHuffmanTree(literalLengths),
        distanceTree: buildHuffmanTree(distanceLengths),
        treeBitStart,
        treeBitEnd: reader.bitOffset,
    };
}

export function parseZlibDeflate(data: Uint8Array, checkpointInterval: number = 64): ZlibTraceResult {
    let envelope: ZlibEnvelope;
    try {
        envelope = splitZlibStream(data);
        verifyZlibHeader(envelope.header);
    } catch (error) {
        const output = new Uint8Array(0);
        return {
            ok: false,
            envelope: error instanceof Error && data.length >= 6 ? splitZlibStream(data) : {
                header: data.slice(0, Math.min(2, data.length)),
                payload: data.length > 6 ? data.slice(2, data.length - 4) : new Uint8Array(0),
                footer: data.length >= 4 ? data.slice(Math.max(0, data.length - 4)) : new Uint8Array(0),
                providedAdler32: 0,
            },
            output,
            blocks: [],
            symbols: [],
            checkpoints: [],
            payloadBitLength: Math.max(0, (data.length - 6) * 8),
            computedAdler32: computeAdler32(output),
            error: {
                message: error instanceof Error ? error.message : String(error),
                bitOffset: 0,
                blockIndex: 0,
                symbolIndex: 0,
                outputLength: 0,
            },
        };
    }

    const reader = new BitReader(envelope.payload);
    const output = new OutputBuffer();
    const blocks: DeflateBlockTrace[] = [];
    const symbols: DeflateSymbolTrace[] = [];
    const checkpoints: DeflateCheckpoint[] = [];
    let blockIndex = 0;
    let symbolIndex = 0;

    try {
        let finalBlock = false;
        while (!finalBlock) {
            const blockBitStart = reader.bitOffset;
            const outputStart = output.length;
            const bfinal = reader.readBits(1) === 1;
            const btype = reader.readBits(2);
            finalBlock = bfinal;

            if (btype === 3) {
                throw new DeflateParseError('Reserved block type', reader.bitOffset, blockIndex, symbolIndex, output.length);
            }

            const block: DeflateBlockTrace = {
                index: blockIndex,
                bfinal,
                btype: btype as 0 | 1 | 2,
                bitStart: blockBitStart,
                bitEnd: blockBitStart,
                bodyBitStart: reader.bitOffset,
                bodyBitEnd: reader.bitOffset,
                outputStart,
                outputEnd: outputStart,
                symbolStartIndex: symbolIndex,
                symbolEndIndex: symbolIndex,
            };

            let literalTree = FIXED_LITERAL_TREE;
            let distanceTree = FIXED_DISTANCE_TREE;

            if (btype === 0) {
                reader.alignByte();
                const len = reader.readBits(16);
                const nlen = reader.readBits(16);
                if (((len ^ 0xffff) & 0xffff) !== nlen) {
                    throw new DeflateParseError('Invalid stored block length', reader.bitOffset, blockIndex, symbolIndex, output.length);
                }
                block.bodyBitStart = reader.bitOffset;
                const bitStart = reader.bitOffset;
                const stored = reader.readAlignedBytes(len);
                const outputBefore = output.length;
                output.pushBytes(stored);
                symbols.push({
                    kind: 'stored',
                    blockIndex,
                    symbolIndex,
                    bitStart,
                    bitEnd: reader.bitOffset,
                    outputStart: outputBefore,
                    outputEnd: output.length,
                });
                recordCheckpoint(checkpoints, blockIndex, symbolIndex, reader.bitOffset, output.length, checkpointInterval);
                symbolIndex++;
            } else {
                if (btype === 2) {
                    const dynamic = decodeDynamicTrees(reader, blockIndex, symbolIndex, output.length);
                    literalTree = dynamic.literalTree;
                    distanceTree = dynamic.distanceTree;
                    block.treeBitStart = dynamic.treeBitStart;
                    block.treeBitEnd = dynamic.treeBitEnd;
                    block.bodyBitStart = reader.bitOffset;
                }

                while (true) {
                    const symbolBitStart = reader.bitOffset;
                    const outputBefore = output.length;
                    const literalSymbol = decodeSymbol(reader, literalTree, blockIndex, symbolIndex, output.length);
                    if (literalSymbol < 256) {
                        output.pushByte(literalSymbol);
                        symbols.push({
                            kind: 'literal',
                            blockIndex,
                            symbolIndex,
                            bitStart: symbolBitStart,
                            bitEnd: reader.bitOffset,
                            outputStart: outputBefore,
                            outputEnd: output.length,
                            literal: literalSymbol,
                        });
                        recordCheckpoint(checkpoints, blockIndex, symbolIndex, reader.bitOffset, output.length, checkpointInterval);
                        symbolIndex++;
                        continue;
                    }
                    if (literalSymbol === 256) {
                        symbols.push({
                            kind: 'eob',
                            blockIndex,
                            symbolIndex,
                            bitStart: symbolBitStart,
                            bitEnd: reader.bitOffset,
                            outputStart: outputBefore,
                            outputEnd: output.length,
                        });
                        recordCheckpoint(checkpoints, blockIndex, symbolIndex, reader.bitOffset, output.length, checkpointInterval);
                        symbolIndex++;
                        break;
                    }
                    const length = readLength(reader, literalSymbol, blockIndex, symbolIndex, output.length);
                    const distanceSymbol = decodeSymbol(reader, distanceTree, blockIndex, symbolIndex, output.length);
                    const distance = readDistance(reader, distanceSymbol, blockIndex, symbolIndex, output.length);
                    output.copyMatch(distance, length);
                    symbols.push({
                        kind: 'match',
                        blockIndex,
                        symbolIndex,
                        bitStart: symbolBitStart,
                        bitEnd: reader.bitOffset,
                        outputStart: outputBefore,
                        outputEnd: output.length,
                        length,
                        distance,
                    });
                    recordCheckpoint(checkpoints, blockIndex, symbolIndex, reader.bitOffset, output.length, checkpointInterval);
                    symbolIndex++;
                }
            }

            block.bodyBitEnd = reader.bitOffset;
            block.bitEnd = reader.bitOffset;
            block.outputEnd = output.length;
            block.symbolEndIndex = symbolIndex;
            blocks.push(block);
            blockIndex++;
        }

        ensureZeroPadding(reader, blockIndex - 1, symbolIndex, output.length);
        const bytes = output.toUint8Array();
        return {
            ok: true,
            envelope,
            output: bytes,
            blocks,
            symbols,
            checkpoints,
            payloadBitLength: envelope.payload.length * 8,
            computedAdler32: computeAdler32(bytes),
        };
    } catch (error) {
        const parseError = toParseError(error, reader, blockIndex, symbolIndex, output.length);
        const bytes = output.toUint8Array();
        return {
            ok: false,
            envelope,
            output: bytes,
            blocks,
            symbols,
            checkpoints,
            payloadBitLength: envelope.payload.length * 8,
            computedAdler32: computeAdler32(bytes),
            error: {
                message: parseError.message,
                bitOffset: parseError.bitOffset,
                blockIndex: parseError.blockIndex,
                symbolIndex: parseError.symbolIndex,
                outputLength: parseError.outputLength,
            },
        };
    }
}

function getBit(bytes: Uint8Array, bitIndex: number): number {
    const byteIndex = bitIndex >>> 3;
    if (byteIndex >= bytes.length) return 0;
    return (bytes[byteIndex] >>> (bitIndex & 7)) & 1;
}

function setBit(bytes: Uint8Array, bitIndex: number, value: number): void {
    if (!value) return;
    bytes[bitIndex >>> 3] |= 1 << (bitIndex & 7);
}

function copyBitRange(target: Uint8Array, targetStartBit: number, source: Uint8Array, sourceStartBit: number, bitLength: number): void {
    let targetBit = targetStartBit;
    let sourceBit = sourceStartBit;
    let remaining = bitLength;

    while (remaining > 0 && ((targetBit & 7) !== 0 || (sourceBit & 7) !== 0)) {
        setBit(target, targetBit, getBit(source, sourceBit));
        targetBit++;
        sourceBit++;
        remaining--;
    }

    while (remaining >= 8) {
        target[targetBit >>> 3] = source[sourceBit >>> 3] ?? 0;
        targetBit += 8;
        sourceBit += 8;
        remaining -= 8;
    }

    while (remaining > 0) {
        setBit(target, targetBit, getBit(source, sourceBit));
        targetBit++;
        sourceBit++;
        remaining--;
    }
}

function splicePayloadBits(candidatePayload: Uint8Array, originalPayload: Uint8Array, attempt: RepairAttempt): Uint8Array {
    const candidateBitLength = candidatePayload.length * 8;
    const originalBitLength = originalPayload.length * 8;
    const start = clampBit(attempt.startBit, candidateBitLength);
    const originalStart = clampBit(attempt.startBit, originalBitLength);

    if (attempt.mode === 'suffix') {
        const outputBitLength = start + Math.max(0, originalBitLength - originalStart);
        const out = new Uint8Array(Math.ceil(outputBitLength / 8));
        copyBitRange(out, 0, candidatePayload, 0, start);
        copyBitRange(out, start, originalPayload, originalStart, Math.max(0, originalBitLength - originalStart));
        return out;
    }

    const candidateEnd = clampBit(attempt.endBit, candidateBitLength);
    const originalEnd = clampBit(attempt.endBit, originalBitLength);
    const middleBitLength = Math.max(0, originalEnd - originalStart);
    const suffixBitLength = Math.max(0, candidateBitLength - candidateEnd);
    const outputBitLength = start + middleBitLength + suffixBitLength;
    const out = new Uint8Array(Math.ceil(outputBitLength / 8));
    copyBitRange(out, 0, candidatePayload, 0, start);
    copyBitRange(out, start, originalPayload, originalStart, middleBitLength);
    copyBitRange(out, start + middleBitLength, candidatePayload, candidateEnd, suffixBitLength);
    return out;
}

function clampBit(bit: number, bitLength: number): number {
    return Math.max(0, Math.min(bit, bitLength));
}

function finalizeAcceptedStream(parsed: ZlibTraceSuccess): DeflateRepairResult {
    const compressedData = new Uint8Array(parsed.envelope.header.length + parsed.envelope.payload.length + 4);
    compressedData.set(parsed.envelope.header, 0);
    compressedData.set(parsed.envelope.payload, parsed.envelope.header.length);
    const adler = parsed.computedAdler32;
    const footerOffset = compressedData.length - 4;
    compressedData[footerOffset] = (adler >>> 24) & 0xff;
    compressedData[footerOffset + 1] = (adler >>> 16) & 0xff;
    compressedData[footerOffset + 2] = (adler >>> 8) & 0xff;
    compressedData[footerOffset + 3] = adler & 0xff;
    return {
        ok: true,
        compressedData,
        filteredData: parsed.output,
        trace: parsed,
        repaired: parsed.computedAdler32 !== parsed.envelope.providedAdler32,
        strategy: parsed.computedAdler32 !== parsed.envelope.providedAdler32 ? 'checksum-rewrite' : 'pass-through',
    };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

function evaluateCandidate(candidate: Uint8Array, acceptOutput: (output: Uint8Array) => DeflateRepairAcceptance): {
    accepted: boolean;
    parsed: ZlibTraceResult;
    acceptance: DeflateRepairAcceptance;
} {
    const parsed = parseZlibDeflate(candidate);
    const parsedAcceptance = parsed.ok
        ? acceptOutput(parsed.output)
        : { ok: false, anchorOutputOffset: parsed.error.outputLength };

    try {
        const inflated = unzlibSync(candidate);
        const acceptance = acceptOutput(inflated);
        if (!acceptance.ok) {
            return {
                accepted: false,
                parsed,
                acceptance,
            };
        }
        if (parsed.ok && parsedAcceptance.ok && sameBytes(parsed.output, inflated)) {
            return {
                accepted: true,
                parsed,
                acceptance,
            };
        }
        return {
            accepted: true,
            parsed: synthesizeTraceFromInflate(candidate, inflated, parsed),
            acceptance,
        };
    } catch {
        return {
            accepted: false,
            parsed,
            acceptance: parsedAcceptance,
        };
    }
}

function synthesizeTraceFromInflate(candidate: Uint8Array, inflated: Uint8Array, parsed: ZlibTraceResult): ZlibTraceSuccess {
    const envelope = splitZlibStream(candidate);
    const fallbackBlock = parsed.blocks[0] ?? {
        index: 0,
        bfinal: true,
        btype: 2 as 0 | 1 | 2,
        bitStart: 0,
        bitEnd: envelope.payload.length * 8,
        bodyBitStart: 0,
        bodyBitEnd: envelope.payload.length * 8,
        outputStart: 0,
        outputEnd: inflated.length,
        symbolStartIndex: 0,
        symbolEndIndex: 0,
    };
    return {
        ok: true,
        envelope,
        output: new Uint8Array(inflated),
        blocks: [{
            ...fallbackBlock,
            bitEnd: envelope.payload.length * 8,
            bodyBitEnd: envelope.payload.length * 8,
            outputEnd: inflated.length,
        }],
        symbols: parsed.symbols,
        checkpoints: parsed.checkpoints,
        payloadBitLength: envelope.payload.length * 8,
        computedAdler32: computeAdler32(inflated),
    };
}

function findAnchorSymbolIndex(trace: ZlibTraceSuccess, anchorOutputOffset?: number, failureBitOffset?: number): number {
    if (trace.symbols.length === 0) return -1;
    if (anchorOutputOffset !== undefined) {
        for (let i = 0; i < trace.symbols.length; i++) {
            if (trace.symbols[i].outputEnd > anchorOutputOffset) {
                return i;
            }
        }
        return trace.symbols.length - 1;
    }
    if (failureBitOffset !== undefined) {
        for (let i = 0; i < trace.symbols.length; i++) {
            if (trace.symbols[i].bitEnd > failureBitOffset) {
                return i;
            }
        }
        return trace.symbols.length - 1;
    }
    return trace.symbols.length - 1;
}

function findAnchorBlockIndex(trace: ZlibTraceSuccess, anchorSymbolIndex: number, failureBitOffset?: number): number {
    if (anchorSymbolIndex >= 0) {
        return trace.symbols[anchorSymbolIndex].blockIndex;
    }
    if (failureBitOffset !== undefined) {
        for (let i = 0; i < trace.blocks.length; i++) {
            if (trace.blocks[i].bitEnd >= failureBitOffset) {
                return i;
            }
        }
        return trace.blocks.length - 1;
    }
    return trace.blocks.length - 1;
}

function buildRepairAttempts(trace: ZlibTraceSuccess, candidatePayloadBits: number, anchorOutputOffset?: number, failureBitOffset?: number): RepairAttempt[] {
    const anchorSymbolIndex = findAnchorSymbolIndex(trace, anchorOutputOffset, failureBitOffset);
    const anchorBlockIndex = findAnchorBlockIndex(trace, anchorSymbolIndex, failureBitOffset);
    const anchorBlock = trace.blocks[Math.max(0, anchorBlockIndex)] ?? null;
    const attempts: RepairAttempt[] = [];
    const seen = new Set<string>();
    const sameLength = candidatePayloadBits === trace.payloadBitLength;
    const largeStream = trace.payloadBitLength > 262144;

    function add(mode: RepairAttempt['mode'], startBit: number, endBit: number, name: string): void {
        const clampedStart = clampBit(startBit, trace.payloadBitLength);
        const clampedEnd = clampBit(endBit, trace.payloadBitLength);
        if (mode === 'replace' && clampedEnd <= clampedStart) return;
        const key = `${mode}:${clampedStart}:${clampedEnd}`;
        if (seen.has(key)) return;
        seen.add(key);
        attempts.push({ mode, startBit: clampedStart, endBit: clampedEnd, name });
    }

    if (largeStream) {
        if (anchorBlock) {
            const blockCheckpoints = trace.checkpoints.filter((checkpoint) => checkpoint.blockIndex === anchorBlock.index);
            let checkpointStartBit = anchorBlock.bitStart;
            for (const checkpoint of blockCheckpoints) {
                if (checkpoint.symbolIndex <= Math.max(0, anchorSymbolIndex)) {
                    checkpointStartBit = checkpoint.bitOffset;
                } else {
                    break;
                }
            }
            add('suffix', anchorBlock.bitStart, trace.payloadBitLength, 'block-suffix');
            add('suffix', checkpointStartBit, trace.payloadBitLength, 'checkpoint-suffix');
        }
        const failureStart = failureBitOffset ?? (anchorBlock ? anchorBlock.bitStart : 0);
        add('suffix', failureStart, trace.payloadBitLength, 'failure-suffix');
        add('suffix', 0, trace.payloadBitLength, 'full-original');
        return attempts;
    }

    if (anchorSymbolIndex >= 0) {
        const radii = sameLength ? [0, 1, 2, 4, 8, 16] : [0, 2, 4, 8];
        for (const radius of radii) {
            const startSymbol = trace.symbols[Math.max(0, anchorSymbolIndex - radius)];
            const endSymbol = trace.symbols[Math.min(trace.symbols.length - 1, anchorSymbolIndex + radius)];
            if (sameLength) {
                add('replace', startSymbol.bitStart, endSymbol.bitEnd, `symbol-${radius}`);
            }
            add('suffix', startSymbol.bitStart, trace.payloadBitLength, `symbol-suffix-${radius}`);
        }
    }

    if (anchorBlock) {
        const blockCheckpoints = trace.checkpoints.filter((checkpoint) => checkpoint.blockIndex === anchorBlock.index);
        let checkpointStartBit = anchorBlock.bitStart;
        let checkpointEndBit = anchorBlock.bitEnd;
        for (const checkpoint of blockCheckpoints) {
            if (checkpoint.symbolIndex <= Math.max(0, anchorSymbolIndex)) {
                checkpointStartBit = checkpoint.bitOffset;
            }
            if (checkpoint.symbolIndex > Math.max(0, anchorSymbolIndex)) {
                checkpointEndBit = checkpoint.bitOffset;
                break;
            }
        }
        if (sameLength) {
            add('replace', checkpointStartBit, checkpointEndBit, 'checkpoint-window');
            add('replace', anchorBlock.bitStart, anchorBlock.bitEnd, 'block');
        }
        add('suffix', checkpointStartBit, trace.payloadBitLength, 'checkpoint-suffix');
        add('suffix', anchorBlock.bitStart, trace.payloadBitLength, 'block-suffix');
    }

    const failureStart = failureBitOffset ?? (anchorBlock ? anchorBlock.bitStart : 0);
    add('suffix', failureStart, trace.payloadBitLength, 'failure-suffix');
    add('suffix', 0, trace.payloadBitLength, 'full-original');

    return attempts;
}

export function repairZlibDeflate(
    candidate: Uint8Array,
    baseline: ZlibTraceSuccess,
    acceptOutput: (output: Uint8Array) => DeflateRepairAcceptance = (output) => ({ ok: output.length === baseline.output.length }),
): DeflateRepairResult | null {
    const firstPass = evaluateCandidate(candidate, acceptOutput);
    if (firstPass.accepted && firstPass.parsed.ok) {
        const accepted = finalizeAcceptedStream(firstPass.parsed);
        accepted.strategy = accepted.repaired ? 'checksum-rewrite' : 'pass-through';
        return accepted;
    }

    let candidateEnvelope: ZlibEnvelope;
    try {
        candidateEnvelope = splitZlibStream(candidate);
    } catch {
        return null;
    }
    const candidatePayloadBits = candidateEnvelope.payload.length * 8;
    const failureBitOffset = firstPass.parsed.ok ? undefined : firstPass.parsed.error.bitOffset;
    const attempts = buildRepairAttempts(
        baseline,
        candidatePayloadBits,
        firstPass.acceptance.anchorOutputOffset,
        failureBitOffset,
    );

    for (const attempt of attempts) {
        const payload = splicePayloadBits(candidateEnvelope.payload, baseline.envelope.payload, attempt);
        const patched = new Uint8Array(2 + payload.length + 4);
        patched.set(candidateEnvelope.header, 0);
        patched.set(payload, 2);
        const evaluated = evaluateCandidate(rewriteAdler32Internal(patched, 0), acceptOutput);
        if (evaluated.accepted && evaluated.parsed.ok) {
            const accepted = finalizeAcceptedStream(evaluated.parsed);
            accepted.repaired = true;
            accepted.strategy = attempt.name;
            return accepted;
        }
    }

    return null;
}

export function rewriteZlibAdler32(data: Uint8Array, filteredData: Uint8Array): Uint8Array {
    return rewriteAdler32Internal(data, computeAdler32(filteredData));
}
