import vscode from "vscode";

import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import semver from "semver";
import which from "which";

export const isWindows = process.platform === "win32";

export function getExePath(exePath: string | null, exeName: string, optionName: string): string {
    // Allow passing the ${workspaceFolder} predefined variable
    // See https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
    if (exePath?.includes("${workspaceFolder}")) {
        // We choose the first workspaceFolder since it is ambiguous which one to use in this context
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            // older versions of Node (which VSCode uses) may not have String.prototype.replaceAll
            exePath = exePath.replace(/\$\{workspaceFolder\}/gm, vscode.workspace.workspaceFolders[0].uri.fsPath);
        }
    }

    if (exePath === null) {
        exePath = which.sync(exeName, { nothrow: true });
    } else if (exePath.startsWith("~")) {
        exePath = path.join(os.homedir(), exePath.substring(1));
    } else if (!path.isAbsolute(exePath)) {
        exePath = which.sync(exePath, { nothrow: true });
    }

    let message;
    if (exePath === null) {
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
    const zigPath = configuration.get<string | null>("path", null);
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
