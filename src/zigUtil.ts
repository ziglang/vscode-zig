import vscode from "vscode";

import childProcess from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import assert from "assert";
import axios from "axios";
import semver from "semver";
import which from "which";

const execFile = promisify(childProcess.execFile);
const chmod = promisify(fs.chmod);

// Replace any references to predefined variables in config string.
// https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
export function handleConfigOption(input: string): string {
    if (input.includes("${userHome}")) {
        input = input.replaceAll("${userHome}", os.homedir());
    }

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        input = input.replaceAll("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath);
        input = input.replaceAll("${workspaceFolderBasename}", vscode.workspace.workspaceFolders[0].name);
    }

    const document = vscode.window.activeTextEditor?.document;
    if (document) {
        input = input.replaceAll("${file}", document.fileName);
        input = input.replaceAll("${fileBasename}", path.basename(document.fileName));
        input = input.replaceAll(
            "${fileBasenameNoExtension}",
            path.basename(document.fileName, path.extname(document.fileName)),
        );
        input = input.replaceAll("${fileExtname}", path.extname(document.fileName));
        input = input.replaceAll("${fileDirname}", path.dirname(document.fileName));
        input = input.replaceAll("${fileDirnameBasename}", path.basename(path.dirname(document.fileName)));
    }

    input = input.replaceAll("${pathSeparator}", path.sep);
    input = input.replaceAll("${/}", path.sep);
    if (input.includes("${cwd}")) {
        input = input.replaceAll("${cwd}", process.cwd());
    }

    if (input.includes("${env:")) {
        for (let env = input.match(/\${env:([^}]+)}/)?.[1]; env; env = input.match(/\${env:([^}]+)}/)?.[1]) {
            input = input.replaceAll(`\${env:${env}}`, process.env[env] ?? "");
        }
    }
    return input;
}

export function getExePath(exePath: string | null | undefined, exeName: string, optionName: string): string {
    if (!exePath) {
        exePath = which.sync(exeName, { nothrow: true });
    } else {
        // allow passing predefined variables
        exePath = handleConfigOption(exePath);

        if (exePath.startsWith("~")) {
            exePath = path.join(os.homedir(), exePath.substring(1));
        } else if (!path.isAbsolute(exePath)) {
            exePath = which.sync(exePath, { nothrow: true });
        }
    }

    let message;
    if (!exePath) {
        message = `Could not find ${exeName} in PATH`;
    } else if (!fs.existsSync(exePath)) {
        message = `\`${optionName}\` ${exePath} does not exist`;
    } else {
        try {
            fs.accessSync(exePath, fs.constants.R_OK | fs.constants.X_OK);
            return exePath;
        } catch {
            message = `\`${optionName}\` ${exePath} is not an executable`;
        }
    }
    void vscode.window.showErrorMessage(message);
    throw Error(message);
}

export function getZigPath(): string {
    const configuration = vscode.workspace.getConfiguration("zig");
    const zigPath = configuration.get<string>("path");
    const exePath = zigPath !== "zig" ? zigPath : null; // the string "zig" means lookup in PATH
    return getExePath(exePath, "zig", "zig.path");
}

// Check timestamp `key` to avoid automatically checking for updates
// more than once in an hour.
export async function shouldCheckUpdate(context: vscode.ExtensionContext, key: string): Promise<boolean> {
    const HOUR = 60 * 60 * 1000;
    const timestamp = new Date().getTime();
    const old = context.globalState.get<number>(key);
    if (old === undefined || timestamp - old < HOUR) return false;
    await context.globalState.update(key, timestamp);
    return true;
}

export function getHostZigName(): string {
    let platform: string = process.platform;
    if (platform === "darwin") platform = "macos";
    if (platform === "win32") platform = "windows";
    let arch: string = process.arch;
    if (arch === "ia32") arch = "x86";
    if (arch === "x64") arch = "x86_64";
    if (arch === "arm") arch = "armv7a";
    if (arch === "arm64") arch = "aarch64";
    if (arch === "ppc") arch = "powerpc";
    if (arch === "ppc64") arch = "powerpc64le";
    return `${arch}-${platform}`;
}

export function getVersion(filePath: string, arg: string): semver.SemVer | null {
    try {
        const buffer = childProcess.execFileSync(filePath, [arg]);
        const versionString = buffer.toString("utf8").trim();
        if (versionString === "0.2.0.83a2a36a") {
            // Zig 0.2.0 reports the verion in a non-semver format
            return semver.parse("0.2.0");
        }
        return semver.parse(versionString);
    } catch {
        return null;
    }
}

export async function downloadAndExtractArtifact(
    /** e.g. `Zig` or `ZLS` */
    title: string,
    /** e.g. `zig` or `zls` */
    executableName: string,
    /** e.g. inside `context.globalStorageUri` */
    installDir: vscode.Uri,
    artifactUrl: string,
    /** The expected sha256 hash (in hex) of the artifact/tarball. */
    sha256: string,
    /** Extract arguments that should be passed to `tar`. e.g. `--strip-components=1` */
    extraTarArgs: string[],
): Promise<string | null> {
    assert.strictEqual(sha256.length, 64);

    return await vscode.window.withProgress<string | null>(
        {
            title: `Installing ${title}`,
            location: vscode.ProgressLocation.Notification,
        },
        async (progress) => {
            progress.report({ message: `downloading ${title} tarball...` });
            const response = await axios.get<Buffer>(artifactUrl, {
                responseType: "arraybuffer",
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
            const tarHash = crypto.createHash("sha256").update(response.data).digest("hex");
            if (tarHash !== sha256) {
                throw Error(`hash of downloaded tarball ${tarHash} does not match expected hash ${sha256}`);
            }

            const tarPath = await which("tar", { nothrow: true });
            if (!tarPath) {
                void vscode.window.showErrorMessage(
                    `Downloaded ${title} tarball can't be extracted because 'tar' could not be found`,
                );
                return null;
            }

            const tarballUri = vscode.Uri.joinPath(installDir, path.basename(artifactUrl));

            try {
                await vscode.workspace.fs.delete(installDir, { recursive: true, useTrash: false });
            } catch {}
            await vscode.workspace.fs.createDirectory(installDir);
            await vscode.workspace.fs.writeFile(tarballUri, response.data);

            progress.report({ message: "Extracting..." });
            try {
                await execFile(tarPath, ["-xf", tarballUri.fsPath, "-C", installDir.fsPath].concat(extraTarArgs), {
                    timeout: 60000, // 60 seconds
                });
            } catch (err) {
                if (err instanceof Error) {
                    void vscode.window.showErrorMessage(`Failed to extract ${title} tarball: ${err.message}`);
                } else {
                    throw err;
                }
                return null;
            } finally {
                try {
                    await vscode.workspace.fs.delete(tarballUri, { useTrash: false });
                } catch {}
            }

            progress.report({ message: "Installing..." });

            const isWindows = process.platform === "win32";
            const exeName = `${executableName}${isWindows ? ".exe" : ""}`;
            const exePath = vscode.Uri.joinPath(installDir, exeName).fsPath;
            await chmod(exePath, 0o755);

            return exePath;
        },
    );
}

export function getWorkspaceFolder(filePath: string): vscode.WorkspaceFolder | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!workspaceFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0];
    }
    return workspaceFolder;
}

export function isWorkspaceFile(filePath: string): boolean {
    const wsFolder = getWorkspaceFolder(filePath);
    if (!wsFolder) return false;
    return filePath.startsWith(wsFolder.uri.fsPath);
}
