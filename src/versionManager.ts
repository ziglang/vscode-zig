/**
 * A version manager for Zig and ZLS.
 *
 * Expects a provider that follows the following scheme:
 * `${PROVIDER_URL}/${NAME}-${OS}-${ARCH}-${VERSION}.${FILE_EXTENSION}`
 *
 * Example:
 *   - `https://ziglang.org/download/0.13.0/zig-windows-x86_64-0.13.0.zip`
 *   - `https://builds.zigtools.org/zls-linux-x86_64-0.13.0.tar.xz`
 */

import vscode from "vscode";

import childProcess from "child_process";
import fs from "fs";
import util from "util";
import which from "which";

import semver from "semver";

import * as minisign from "./minisign";
import { getVersion, getZigArchName, getZigOSName } from "./zigUtil";

const execFile = util.promisify(childProcess.execFile);
const chmod = util.promisify(fs.chmod);

/** The maxmimum number of installation that can be store until they will be removed */
const maxInstallCount = 5;
/** Maps concurrent requests to install a version of an exe to a single promise */
const inProgressInstalls = new Map<string, Promise<string>>();

export interface Config {
    context: vscode.ExtensionContext;
    /** The name of the application. */
    title: string;
    /** The name of the executable file. */
    exeName: string;
    minisignKey: minisign.Key;
    /** The command-line argument that should passed to `tar` to exact the tarball. */
    extraTarArgs: string[];
    /**
     * The command-line argument that should passed to the executable to query the version.
     * `"version"` for Zig, `"--version"` for ZLS
     */
    versionArg: string;
    mirrorUrls: vscode.Uri[];
    canonicalUrl: {
        release: vscode.Uri;
        nightly: vscode.Uri;
    };
}

/** Returns the path to the executable */
export async function install(config: Config, version: semver.SemVer): Promise<string> {
    const key = config.exeName + version.raw;
    const entry = inProgressInstalls.get(key);
    if (entry) {
        return await entry;
    }

    const promise = installGuarded(config, version);
    inProgressInstalls.set(key, promise);

    return await promise.finally(() => {
        inProgressInstalls.delete(key);
    });
}

async function installGuarded(config: Config, version: semver.SemVer): Promise<string> {
    const exeName = config.exeName + (process.platform === "win32" ? ".exe" : "");
    const subDirName = `${getZigOSName()}-${getZigArchName()}-${version.raw}`;
    const exeUri = vscode.Uri.joinPath(config.context.globalStorageUri, config.exeName, subDirName, exeName);

    await setLastAccessTime(config, version);

    try {
        await vscode.workspace.fs.stat(exeUri);
        return exeUri.fsPath;
    } catch (e) {
        if (e instanceof vscode.FileSystemError) {
            if (e.code !== "FileNotFound") {
                throw e;
            }
            // go ahead an install
        } else {
            throw e;
        }
    }

    const mirrors = [...config.mirrorUrls]
        .map((mirror) => ({ mirror, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ mirror }) => mirror);

    for (const mirrorUrl of mirrors) {
        const mirrorName = new URL(mirrorUrl.toString()).host;
        try {
            return await installFromMirror(config, version, mirrorUrl, mirrorName);
        } catch (err) {
            if (err instanceof Error) {
                void vscode.window.showWarningMessage(
                    `Failed to download ${config.exeName} from ${mirrorName}: ${err.message}, trying different mirror`,
                );
            } else {
                void vscode.window.showWarningMessage(
                    `Failed to download ${config.exeName} from ${mirrorName}, trying different mirror`,
                );
            }
        }
    }

    const canonicalUrl = version.prerelease.length === 0 ? config.canonicalUrl.release : config.canonicalUrl.nightly;
    const mirrorName = new URL(canonicalUrl.toString()).host;
    return await installFromMirror(config, version, canonicalUrl, mirrorName);
}

/** Returns the path to the executable */
async function installFromMirror(
    config: Config,
    version: semver.SemVer,
    mirrorUrl: vscode.Uri,
    mirrorName: string,
): Promise<string> {
    const isWindows = process.platform === "win32";
    const fileExtension = isWindows ? "zip" : "tar.xz";
    const exeName = config.exeName + (isWindows ? ".exe" : "");
    const subDirName = `${getZigOSName()}-${getZigArchName()}-${version.raw}`;
    const fileName = `${config.exeName}-${subDirName}.${fileExtension}`;

    const installDir = vscode.Uri.joinPath(config.context.globalStorageUri, config.exeName, subDirName);
    const exeUri = vscode.Uri.joinPath(installDir, exeName);
    const tarballUri = vscode.Uri.joinPath(installDir, fileName);

    let tarPath = null;
    if (isWindows && process.env["SYSTEMROOT"]) {
        // We may be running from within Git Bash which adds GNU tar to
        // the $PATH but we need bsdtar to extract zip files so we look
        // in the system directory before falling back to the $PATH.
        // See https://github.com/ziglang/vscode-zig/issues/382
        tarPath = `${process.env["SYSTEMROOT"]}\\system32\\tar.exe`;
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(tarPath));
        } catch {
            tarPath = null;
        }
    }
    tarPath ??= await which("tar", { nothrow: true });
    if (!tarPath) {
        throw new Error(`Downloaded ${config.title} tarball can't be extracted because 'tar' could not be found`);
    }

    return await vscode.window.withProgress<string>(
        {
            title: `Installing ${config.title} from ${mirrorName}`,
            location: vscode.ProgressLocation.Notification,
        },
        async (progress, cancelToken) => {
            const abortController = new AbortController();
            cancelToken.onCancellationRequested(() => {
                abortController.abort();
            });

            const artifactUrl = vscode.Uri.joinPath(mirrorUrl, fileName);
            /** https://github.com/mlugg/setup-zig adds a `?source=github-actions` query parameter so we add our own.  */
            const artifactUrlWithQuery = artifactUrl.with({ query: "source=vscode-zig" });

            const artifactMinisignUrl = vscode.Uri.joinPath(mirrorUrl, `${fileName}.minisig`);
            const artifactMinisignUrlWithQuery = artifactMinisignUrl.with({ query: "source=vscode-zig" });

            const signatureResponse = await fetch(artifactMinisignUrlWithQuery.toString(), {
                signal: abortController.signal,
            });
            const signatureData = Buffer.from(await signatureResponse.arrayBuffer());

            let artifactResponse = await fetch(artifactUrlWithQuery.toString(), {
                signal: abortController.signal,
            });

            let contentLength = artifactResponse.headers.has("content-length")
                ? Number(artifactResponse.headers.get("content-length"))
                : null;
            if (!Number.isFinite(contentLength)) contentLength = null;

            if (contentLength) {
                let receivedLength = 0;
                const progressStream = new TransformStream<{ length: number }>({
                    transform(chunk, controller) {
                        receivedLength += chunk.length;
                        const increment = (chunk.length / contentLength) * 100;
                        const currentProgress = (receivedLength / contentLength) * 100;
                        progress.report({
                            message: `downloading tarball ${currentProgress.toFixed()}%`,
                            increment: increment,
                        });
                        controller.enqueue(chunk);
                    },
                });
                artifactResponse = new Response(artifactResponse.body?.pipeThrough(progressStream));
            }
            const artifactData = Buffer.from(await artifactResponse.arrayBuffer());

            progress.report({ message: "Verifying Signature..." });

            const signature = minisign.parseSignature(signatureData);
            if (!minisign.verifySignature(config.minisignKey, signature, artifactData)) {
                try {
                    await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
                } catch {}
                throw new Error(`signature verification failed for '${artifactUrl.toString()}'`);
            }

            try {
                await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
            } catch {}
            await vscode.workspace.fs.createDirectory(installDir);
            await vscode.workspace.fs.writeFile(tarballUri, artifactData);

            progress.report({ message: "Extracting..." });
            try {
                await execFile(
                    tarPath,
                    ["-xf", tarballUri.fsPath, "-C", installDir.fsPath].concat(config.extraTarArgs),
                    {
                        signal: abortController.signal,
                        timeout: 60000, // 60 seconds
                    },
                );
            } catch (err) {
                try {
                    await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
                } catch {}
                if (err instanceof Error) {
                    throw new Error(`Failed to extract ${config.title} tarball: ${err.message}`);
                } else {
                    throw err;
                }
            } finally {
                try {
                    await vscode.workspace.fs.delete(tarballUri, { useTrash: false });
                } catch {}
            }

            const exeVersion = getVersion(exeUri.fsPath, config.versionArg);
            if (!exeVersion || exeVersion.compare(version) !== 0) {
                try {
                    await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
                } catch {}
                // a mirror may provide the wrong version
                throw new Error(`Failed to validate version of ${config.title} installation!`);
            }

            await chmod(exeUri.fsPath, 0o755);

            try {
                await removeUnusedInstallations(config);
            } catch (err) {
                if (err instanceof Error) {
                    void vscode.window.showWarningMessage(
                        `Failed to uninstall unused ${config.title} versions: ${err.message}`,
                    );
                } else {
                    void vscode.window.showWarningMessage(`Failed to uninstall unused ${config.title} versions`);
                }
            }

            return exeUri.fsPath;
        },
    );
}

/** Returns all locally installed versions */
export async function query(config: Config): Promise<semver.SemVer[]> {
    const available: semver.SemVer[] = [];
    const prefix = `${getZigOSName()}-${getZigArchName()}`;

    const storageDir = vscode.Uri.joinPath(config.context.globalStorageUri, config.exeName);
    try {
        for (const [name] of await vscode.workspace.fs.readDirectory(storageDir)) {
            if (name.startsWith(prefix)) {
                available.push(new semver.SemVer(name.substring(prefix.length + 1)));
            }
        }
    } catch (e) {
        if (e instanceof vscode.FileSystemError && e.code === "FileNotFound") {
            return [];
        }
        throw e;
    }

    return available;
}

/** Set the last access time of the (installed) version. */
async function setLastAccessTime(config: Config, version: semver.SemVer): Promise<void> {
    await config.context.globalState.update(
        `${config.exeName}-last-access-time-${getZigOSName()}-${getZigArchName()}-${version.raw}`,
        Date.now(),
    );
}

/** Remove installations with the oldest last access time until at most `VersionManager.maxInstallCount` versions remain. */
async function removeUnusedInstallations(config: Config) {
    const storageDir = vscode.Uri.joinPath(config.context.globalStorageUri, config.exeName);

    const keys: { key: string; installDir: vscode.Uri; lastAccessTime: number }[] = [];

    try {
        for (const [name, fileType] of await vscode.workspace.fs.readDirectory(storageDir)) {
            const key = `${config.exeName}-last-access-time-${name}`;
            const uri = vscode.Uri.joinPath(storageDir, name);
            const lastAccessTime = config.context.globalState.get<number>(key);

            if (!lastAccessTime || fileType !== vscode.FileType.Directory) {
                await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
            } else {
                keys.push({
                    key: key,
                    installDir: uri,
                    lastAccessTime: lastAccessTime,
                });
            }
        }
    } catch (e) {
        if (e instanceof vscode.FileSystemError && e.code === "FileNotFound") return;
        throw e;
    }

    keys.sort((lhs, rhs) => rhs.lastAccessTime - lhs.lastAccessTime);

    for (const item of keys.slice(maxInstallCount)) {
        await vscode.workspace.fs.delete(item.installDir, { recursive: true, useTrash: false });
        await config.context.globalState.update(item.key, undefined);
    }
}
