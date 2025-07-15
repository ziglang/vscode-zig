/**
 * Ported from: https://github.com/mlugg/setup-zig/blob/main/minisign.js
 *
 * Copyright Matthew Lugg
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import sodium from "libsodium-wrappers";

export interface Key {
    id: Buffer;
    key: Buffer;
}

export const ready = sodium.ready;

// Parse a minisign key represented as a base64 string.
// Throws exceptions on invalid keys.
export function parseKey(keyString: string): Key {
    const keyInfo = Buffer.from(keyString, "base64");

    const id = keyInfo.subarray(2, 10);
    const key = keyInfo.subarray(10);

    if (key.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) {
        throw new Error("invalid public key given");
    }

    return {
        id: id,
        key: key,
    };
}

export interface Signature {
    algorithm: Buffer;
    keyID: Buffer;
    signature: Buffer;
    trustedComment: Buffer;
    globalSignature: Buffer;
}

// Parse a buffer containing the contents of a minisign signature file.
// Throws exceptions on invalid signature files.
export function parseSignature(sigBuf: Buffer): Signature {
    const untrustedHeader = Buffer.from("untrusted comment: ");
    const trustedHeader = Buffer.from("trusted comment: ");

    // Validate untrusted comment header, and skip
    if (!sigBuf.subarray(0, untrustedHeader.byteLength).equals(untrustedHeader)) {
        throw new Error("invalid minisign signature: bad untrusted comment header");
    }
    sigBuf = sigBuf.subarray(untrustedHeader.byteLength);

    // Skip untrusted comment
    sigBuf = sigBuf.subarray(sigBuf.indexOf("\n") + 1);

    // Read and skip signature info
    const sigInfoEnd = sigBuf.indexOf("\n");
    const sigInfo = Buffer.from(sigBuf.subarray(0, sigInfoEnd).toString(), "base64");
    sigBuf = sigBuf.subarray(sigInfoEnd + 1);

    // Extract components of signature info
    const algorithm = sigInfo.subarray(0, 2);
    const keyID = sigInfo.subarray(2, 10);
    const signature = sigInfo.subarray(10);

    // Validate trusted comment header, and skip
    if (!sigBuf.subarray(0, trustedHeader.byteLength).equals(trustedHeader)) {
        throw new Error("invalid minisign signature: bad trusted comment header");
    }
    sigBuf = sigBuf.subarray(trustedHeader.byteLength);

    // Read and skip trusted comment
    const trustedCommentEnd = sigBuf.indexOf("\n");
    const trustedComment = sigBuf.subarray(0, trustedCommentEnd);
    sigBuf = sigBuf.subarray(trustedCommentEnd + 1);

    // Read and skip global signature; handle missing trailing newline, just in case
    let globalSigEnd = sigBuf.indexOf("\n");
    if (globalSigEnd === -1) globalSigEnd = sigBuf.length;
    const globalSig = Buffer.from(sigBuf.subarray(0, globalSigEnd).toString(), "base64");
    sigBuf = sigBuf.subarray(sigInfoEnd + 1); // this might be length+1, but that's allowed

    // Validate that all data has been consumed
    if (sigBuf.length !== 0) {
        throw new Error("invalid minisign signature: trailing bytes");
    }

    return {
        algorithm: algorithm,
        keyID: keyID,
        signature: signature,
        trustedComment: trustedComment,
        globalSignature: globalSig,
    };
}

// Given a parsed key, parsed signature file, and raw file content, verifies the signature,
// including the global signature (hence validating the trusted comment). Does not throw.
// Returns 'true' if the signature is valid for this file, 'false' otherwise.
export function verifySignature(pubkey: Key, signature: Signature, fileContent: Buffer) {
    if (!signature.keyID.equals(pubkey.id)) {
        return false;
    }

    let signedContent;
    if (signature.algorithm.equals(Buffer.from("ED"))) {
        signedContent = sodium.crypto_generichash(sodium.crypto_generichash_BYTES_MAX, fileContent);
    } else {
        signedContent = fileContent;
    }
    if (!sodium.crypto_sign_verify_detached(signature.signature, signedContent, pubkey.key)) {
        return false;
    }

    const globalSignedContent = Buffer.concat([signature.signature, signature.trustedComment]);
    if (!sodium.crypto_sign_verify_detached(signature.globalSignature, globalSignedContent, pubkey.key)) {
        return false;
    }

    return true;
}
