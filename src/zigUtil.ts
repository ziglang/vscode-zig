import vscode from "vscode";

import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import semver from "semver";
import which from "which";

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

/** Resolves the absolute executable path and version of a program like Zig or ZLS. */
export function resolveExePathAndVersion(
    /** `null` means lookup in PATH */
    exePath: string | null,
    /** e.g. `zig` or `zig` */
    exeName: string,
    /** e.g. `zig.path` or `zig.zls.path` */
    optionName: string,
    /**
     * The command-line argument that is used to query the version of the executable.
     * Zig uses `version`. ZLS uses `--version`.
     */
    versionArg: string,
): { exe: string; version: semver.SemVer } | { message: string } {
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

    if (!exePath) {
        return { message: `Could not find ${exeName} in PATH` };
    }

    if (!fs.existsSync(exePath)) {
        return { message: `\`${optionName}\` ${exePath} does not exist` };
    }

    try {
        fs.accessSync(exePath, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
        return { message: `\`${optionName}\` ${exePath} is not an executable` };
    }

    const version = getVersion(exePath, versionArg);
    if (!version) return { message: `Failed to run '${exePath} ${versionArg}'!` };
    return { exe: exePath, version: version };
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

export function getZigArchName(): string {
    switch (process.arch) {
        case "ia32":
            return "x86";
        case "x64":
            return "x86_64";
        case "arm":
            return "armv7a";
        case "arm64":
            return "aarch64";
        case "ppc":
            return "powerpc";
        case "ppc64":
            return "powerpc64le";
        default:
            return process.arch;
    }
}
export function getZigOSName(): string {
    switch (process.platform) {
        case "darwin":
            return "macos";
        case "win32":
            return "windows";
        default:
            return process.platform;
    }
}

export function getHostZigName(): string {
    return `${getZigArchName()}-${getZigOSName()}`;
}

export function getVersion(
    filePath: string,
    /**
     * The command-line argument that is used to query the version of the executable.
     * Zig uses `version`. ZLS uses `--version`.
     */
    arg: string,
): semver.SemVer | null {
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

export interface ZigVersion {
    name: string;
    version: semver.SemVer;
    url: string;
    sha: string;
    notes?: string;
}

export type VersionIndex = Record<
    string,
    Record<string, undefined | { tarball: string; shasum: string; size: string }>
>;

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
