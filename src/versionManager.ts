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

import axios from "axios";
import semver from "semver";

import { getVersion, getZigArchName, getZigOSName } from "./zigUtil";

const execFile = util.promisify(childProcess.execFile);
const chmod = util.promisify(fs.chmod);

export interface Config {
    context: vscode.ExtensionContext;
    /** The name of the application. */
    title: string;
    /** The name of the executable file. */
    exeName: string;
    /** The command-line argument that should passed to `tar` to exact the tarball. */
    extraTarArgs: string[];
    /**
     * The command-line argument that should passed to the executable to query the version.
     * `"version"` for Zig, `"--version"` for ZLS
     */
    versionArg: string;
    canonicalUrl: {
        release: vscode.Uri;
        nightly: vscode.Uri;
    };
}

/** Returns the path to the executable */
export async function install(config: Config, version: semver.SemVer): Promise<string> {
    const exeName = config.exeName + (process.platform === "win32" ? ".exe" : "");
    const subDirName = `${getZigOSName()}-${getZigArchName()}-${version.raw}`;
    const exeUri = vscode.Uri.joinPath(config.context.globalStorageUri, config.exeName, subDirName, exeName);

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

    const tarPath = await which("tar", { nothrow: true });
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

            const artifactResponse = await axios.get<Buffer>(artifactUrlWithQuery.toString(), {
                responseType: "arraybuffer",
                signal: abortController.signal,
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const increment = (progressEvent.bytes / progressEvent.total) * 100;
                        progress.report({
                            message: progressEvent.progress
                                ? `downloading tarball ${(progressEvent.progress * 100).toFixed()}%`
                                : "downloading tarball...",
                            increment: increment,
                        });
                    }
                },
            });
            const artifactData = Buffer.from(artifactResponse.data);

            try {
                await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
            } catch {}
            await vscode.workspace.fs.createDirectory(installDir);
            await vscode.workspace.fs.writeFile(tarballUri, new Uint8Array(artifactData));

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
