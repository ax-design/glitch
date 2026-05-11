import { isSafe } from './JpegBytes.js';

export interface JpegAnalysis {
    data: number[];
    dqt: number[];
    sof: number[];
    dht: number[];
}

export class JpegAnalyzer {
    static analyze(bytes: Uint8Array): JpegAnalysis {
        const markers: Array<{ pos: number; type: number }> = [];

        for (let i = 0; i < bytes.length - 1; i++) {
            if (bytes[i] === 0xff) {
                markers.push({ pos: i, type: bytes[i + 1] });
            }
        }

        const data: number[] = [];
        const dqt: number[] = [];
        const sof: number[] = [];
        const dht: number[] = [];

        for (const m of markers) {
            // DQT (Quantization Table)
            if (m.type === 0xdb) {
                const len = (bytes[m.pos + 2] << 8) | bytes[m.pos + 3];
                const start = m.pos + 5;
                const end = m.pos + len + 2;
                for (let k = start; k < end; k++) {
                    if (k < bytes.length && isSafe(bytes, k)) {
                        dqt.push(k);
                    }
                }
            }
            // SOF0 (Start of Frame 0 - Baseline DCT)
            else if (m.type === 0xc0) {
                sof.push(m.pos + 8);
            }
            // DHT (Define Huffman Table)
            else if (m.type === 0xc4) {
                const len = (bytes[m.pos + 2] << 8) | bytes[m.pos + 3];
                const segmentEnd = m.pos + len + 2;
                let current = m.pos + 4;

                while (current < segmentEnd) {
                    if (current + 17 > segmentEnd) break;

                    const infoByte = bytes[current];
                    const tableClass = infoByte >> 4;

                    let symbolCount = 0;
                    for (let j = 1; j <= 16; j++) {
                        symbolCount += bytes[current + j];
                    }

                    if (tableClass === 1) {
                        const symbolsStart = current + 17;
                        const symbolsEnd = symbolsStart + symbolCount;
                        for (let k = symbolsStart; k < symbolsEnd; k++) {
                            if (k < segmentEnd && isSafe(bytes, k)) {
                                dht.push(k);
                            }
                        }
                    }

                    current += 1 + 16 + symbolCount;
                }
            }
            // SOS (Start of Scan - Image Data)
            else if (m.type === 0xda) {
                const headerLen = (bytes[m.pos + 2] << 8) | bytes[m.pos + 3];
                const start = m.pos + 2 + headerLen;
                const end = bytes.length - 2;
                for (let k = start; k < end; k++) {
                    if (isSafe(bytes, k)) {
                        data.push(k);
                    }
                }
            }
        }

        return { data, dqt, sof, dht };
    }
}
