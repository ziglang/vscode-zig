/**
 * Ported from: https://github.com/mlugg/setup-zig/blob/main/main.js (MIT)
 */

import sodium from "libsodium-wrappers";

export interface Key {
    id: Buffer;
    key: Buffer;
}

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
}

// Parse a buffer containing the contents of a minisign signature file.
// Throws exceptions on invalid signature files.
export function parseSignature(sigBuf: Buffer): Signature {
    const untrustedHeader = Buffer.from("untrusted comment: ");

    // Validate untrusted comment header, and skip
    if (!sigBuf.subarray(0, untrustedHeader.byteLength).equals(untrustedHeader)) {
        throw new Error("file format not recognised");
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

    // We don't look at the trusted comment or global signature, so we're done.

    return {
        algorithm: algorithm,
        keyID: keyID,
        signature: signature,
    };
}

// Given a parsed key, parsed signature file, and raw file content, verifies the
// signature. Does not throw. Returns 'true' if the signature is valid for this
// file, 'false' otherwise.
export function verifySignature(pubkey: Key, signature: Signature, fileContent: Buffer) {
    let signedContent;
    if (signature.algorithm.equals(Buffer.from("ED"))) {
        signedContent = sodium.crypto_generichash(sodium.crypto_generichash_BYTES_MAX, fileContent);
    } else {
        signedContent = fileContent;
    }

    if (!signature.keyID.equals(pubkey.id)) {
        return false;
    }

    if (!sodium.crypto_sign_verify_detached(signature.signature, signedContent, pubkey.key)) {
        return false;
    }

    // Since we don't use the trusted comment, we don't bother verifying the global signature.
    // If we were to start using the trusted comment for any purpose, we must add this.

    return true;
}
