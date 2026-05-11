export function base64ToBytes(base64: string): Uint8Array {
    const binaryString = window.atob(base64.split(',')[1]);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

export function bytesToUrl(bytes: Uint8Array): string {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
    return URL.createObjectURL(blob);
}

export function isSafe(bytes: Uint8Array, i: number): boolean {
    if (bytes[i] === 0xff) return false;
    if (i > 0 && bytes[i - 1] === 0xff) return false;
    return true;
}

export function safeVal(val: number): number {
    return val === 0xff ? 0xfe : val;
}
