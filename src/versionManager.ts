import vscode from "vscode";

import childProcess from "child_process";
import fs from "fs";
import util from "util";
import which from "which";

import axios from "axios";
import semver from "semver";

import { getZigArchName, getZigOSName } from "./zigUtil";

const execFile = util.promisify(childProcess.execFile);
const chmod = util.promisify(fs.chmod);

/**
 * A version manager for Zig and ZLS.
 *
 * Expects a provider that follows the following scheme:
 * `${PROVIDER_URL}/${NAME}-${OS}-${ARCH}-${VERSION}.${FILE_EXTENSION}`
 *
 * Example:
 *   - `https://ziglang.org/download/0.13.0/zig-windows-x86_64-0.13.0.zip`
 *   - `https://builds.zigtools.org/zls-linux-x86_64-0.13.0.tar.xz`
 *
 * TODO automatically remove unnecessary versions
 * Maybe limit the number of versions and track how long the version was not used.
 *
 * TODO verify installation with minisig
 */
export class VersionManager {
    context: vscode.ExtensionContext;
    kind: "zig" | "zls";

    /** The maxmimum number of installation that can be store until they will be removed */
    static maxInstallCount = 5;

    constructor(context: vscode.ExtensionContext, kind: "zig" | "zls") {
        this.context = context;
        this.kind = kind;
    }

    /** Returns the path to the executable */
    public async install(version: semver.SemVer): Promise<string> {
        let title: string;
        let artifactBaseUrl: vscode.Uri;
        let extraTarArgs: string[];
        switch (this.kind) {
            case "zig":
                title = "Zig";
                if (version.prerelease.length === 0) {
                    artifactBaseUrl = vscode.Uri.joinPath(
                        vscode.Uri.parse("https://ziglang.org/download"),
                        version.raw,
                    );
                } else {
                    artifactBaseUrl = vscode.Uri.parse("https://ziglang.org/builds");
                }
                extraTarArgs = ["--strip-components=1"];
                break;
            case "zls":
                title = "ZLS";
                artifactBaseUrl = vscode.Uri.parse("https://builds.zigtools.org");
                break;
        }

        const isWindows = process.platform === "win32";
        const fileExtension = process.platform === "win32" ? "zip" : "tar.xz";
        const exeName = this.kind + (isWindows ? ".exe" : "");
        const subDirName = `${getZigOSName()}-${getZigArchName()}-${version.raw}`;
        const fileName = `${this.kind}-${subDirName}.${fileExtension}`;

        const artifactUrl = vscode.Uri.joinPath(artifactBaseUrl, fileName);

        const installDir = vscode.Uri.joinPath(this.context.globalStorageUri, this.kind, subDirName);
        const exeUri = vscode.Uri.joinPath(installDir, exeName);
        const exePath = exeUri.fsPath;
        const tarballUri = vscode.Uri.joinPath(installDir, fileName);

        try {
            await vscode.workspace.fs.stat(exeUri);
            return exePath;
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

        const tarPath = await which("tar", { nothrow: true });
        if (!tarPath) {
            throw new Error(`Downloaded ${title} tarball can't be extracted because 'tar' could not be found`);
        }

        return await vscode.window.withProgress<string>(
            {
                title: `Installing ${title}`,
                location: vscode.ProgressLocation.Notification,
            },
            async (progress, cancelToken) => {
                const abortController = new AbortController();
                cancelToken.onCancellationRequested(() => {
                    abortController.abort();
                });

                const response = await axios.get<Buffer>(artifactUrl.toString(), {
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

                try {
                    await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
                } catch {}
                await vscode.workspace.fs.createDirectory(installDir);
                await vscode.workspace.fs.writeFile(tarballUri, response.data);

                progress.report({ message: "Extracting..." });
                try {
                    await execFile(tarPath, ["-xf", tarballUri.fsPath, "-C", installDir.fsPath].concat(extraTarArgs), {
                        signal: abortController.signal,
                        timeout: 60000, // 60 seconds
                    });
                } catch (err) {
                    try {
                        await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
                    } catch {}
                    if (err instanceof Error) {
                        throw new Error(`Failed to extract ${title} tarball: ${err.message}`);
                    } else {
                        throw err;
                    }
                } finally {
                    try {
                        await vscode.workspace.fs.delete(tarballUri, { useTrash: false });
                    } catch {}
                }

                await chmod(exePath, 0o755);

                return exePath;
            },
        );
    }
}
