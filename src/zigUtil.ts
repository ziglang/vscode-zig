import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import semver, { SemVer } from "semver";
import { ExtensionContext, window, workspace } from "vscode";
import which from "which";

export const isWindows = process.platform === "win32";

export function getExePath(exePath: string | null, exeName: string, optionName: string): string {
    // Allow passing the ${workspaceFolder} predefined variable
    // See https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
    if (exePath && exePath.includes("${workspaceFolder}")) {
        // We choose the first workspaceFolder since it is ambiguous which one to use in this context
        if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
            // older versions of Node (which VSCode uses) may not have String.prototype.replaceAll
            exePath = exePath.replace(/\$\{workspaceFolder\}/gm, workspace.workspaceFolders[0].uri.fsPath);
        }
    }

    if (!exePath) {
        exePath = which.sync(exeName, { nothrow: true });
    } else if (exePath.startsWith("~")) {
        exePath = path.join(os.homedir(), exePath.substring(1));
    } else if (!path.isAbsolute(exePath)) {
        exePath = which.sync(exePath, { nothrow: true });
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
    window.showErrorMessage(message);
    throw Error(message);
}

export function getZigPath(): string {
    const configuration = workspace.getConfiguration("zig");
    const zigPath = configuration.get<string>("path");
    return getExePath(zigPath, "zig", "zig.path");
}

// Check timestamp `key` to avoid automatically checking for updates
// more than once in an hour.
export function shouldCheckUpdate(context: ExtensionContext, key: string): boolean {
    const HOUR = 60 * 60 * 1000;
    const timestamp = new Date().getTime();
    const old = context.globalState.get<number>(key);
    if (old === undefined || timestamp - old < HOUR) return false;
    context.globalState.update(key, timestamp);
    return true;
}

export function getHostZigName(): string {
    let os: string = process.platform;
    if (os == "darwin") os = "macos";
    if (os == "win32") os = "windows";
    let arch: string = process.arch;
    if (arch == "ia32") arch = "x86";
    if (arch == "x64") arch = "x86_64";
    if (arch == "arm64") arch = "aarch64";
    if (arch == "ppc") arch = "powerpc";
    if (arch == "ppc64") arch = "powerpc64le";
    return `${arch}-${os}`;
}

export function getVersion(path: string, arg: string): SemVer | null {
    try {
        const buffer = cp.execFileSync(path, [arg]);
        const version_str = buffer.toString("utf8").trim();
        if (version_str === "0.2.0.83a2a36a") {
            // Zig 0.2.0 reports the verion in a non-semver format
            return semver.parse("0.2.0");
        }
        return semver.parse(version_str);
    } catch {
        return null;
    }
}
