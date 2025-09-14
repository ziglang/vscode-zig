import vscode from "vscode";

import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import assert from "assert";
import { debounce } from "lodash-es";
import semver from "semver";
import which from "which";

/**
 * Replace any references to predefined variables in config string.
 * https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
 */
export function handleConfigOption(input: string, workspaceFolder: vscode.WorkspaceFolder | "none" | "guess"): string {
    if (input.includes("${userHome}")) {
        input = input.replaceAll("${userHome}", os.homedir());
    }

    if (workspaceFolder === "guess") {
        workspaceFolder = vscode.workspace.workspaceFolders?.length ? vscode.workspace.workspaceFolders[0] : "none";
    }

    if (workspaceFolder !== "none") {
        input = input.replaceAll("${workspaceFolder}", workspaceFolder.uri.fsPath);
        input = input.replaceAll("${workspaceFolderBasename}", workspaceFolder.name);
    } else {
        // This may end up reporting a confusing error message.
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
        for (let env = /\${env:([^}]+)}/.exec(input)?.[1]; env; env = /\${env:([^}]+)}/.exec(input)?.[1]) {
            input = input.replaceAll(`\${env:${env}}`, process.env[env] ?? "");
        }
    }
    return input;
}

/** Resolves the absolute executable path and version of a program like Zig or ZLS. */
export function resolveExePathAndVersion(
    /**
     * - resolves '~' to the user home directory.
     * - resolves VS Code predefined variables.
     * - resolves possible executable file extensions on windows like '.exe' or '.cmd'.
     */
    cmd: string,
    /**
     * The command-line argument that is used to query the version of the executable.
     * Zig uses `version`. ZLS uses `--version`.
     */
    versionArg: string,
): { exe: string; version: semver.SemVer } | { message: string } {
    assert(cmd.length);

    // allow passing predefined variables
    cmd = handleConfigOption(cmd, "guess");

    if (cmd.startsWith("~")) {
        cmd = path.join(os.homedir(), cmd.substring(1));
    }

    const isWindows = os.platform() === "win32";
    const isAbsolute = path.isAbsolute(cmd);
    const hasPathSeparator = !!/\//.exec(cmd) || (isWindows && !!/\\/.exec(cmd));
    if (!isAbsolute && hasPathSeparator) {
        // A value like `./zig` would be looked up relative to the cwd of the VS Code process which makes little sense.
        return {
            message: `'${cmd}' is not valid. Use '$\{workspaceFolder}' to specify a path relative to the current workspace folder and '~' for the home directory.`,
        };
    }

    const exePath = which.sync(cmd, { nothrow: true });
    if (!exePath) {
        if (!isAbsolute) {
            return { message: `Could not find '${cmd}' in PATH.` };
        }

        const stats = fs.statSync(cmd, { throwIfNoEntry: false });
        if (!stats) {
            return {
                message: `'${cmd}' does not exist.`,
            };
        }

        if (stats.isDirectory()) {
            return {
                message: `'${cmd}' is a directory and not an executable.`,
            };
        }

        return {
            message: `'${cmd}' is not an executable.`,
        };
    }

    const version = getVersion(exePath, versionArg);
    if (!version) return { message: `Failed to run '${exePath} ${versionArg}'.` };
    return { exe: exePath, version: version };
}

export function asyncDebounce<T extends (...args: unknown[]) => Promise<Awaited<ReturnType<T>>>>(
    func: T,
    wait?: number,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
    const debounced = debounce(
        (resolve: (value: Awaited<ReturnType<T>>) => void, reject: (reason?: unknown) => void, args: Parameters<T>) => {
            void func(...args)
                .then(resolve)
                .catch(reject);
        },
        wait,
    );
    return (...args) =>
        new Promise((resolve, reject) => {
            debounced(resolve, reject, args);
        });
}

/**
 * Wrapper around `vscode.WorkspaceConfiguration.update` that doesn't throw an exception.
 * A common cause of an exception is when the `settings.json` file is read-only.
 */
export async function workspaceConfigUpdateNoThrow(
    config: vscode.WorkspaceConfiguration,
    section: string,
    value: unknown,
    configurationTarget?: vscode.ConfigurationTarget | boolean | null,
    overrideInLanguage?: boolean,
): Promise<void> {
    try {
        await config.update(section, value, configurationTarget, overrideInLanguage);
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(err.message);
        } else {
            void vscode.window.showErrorMessage("failed to update settings.json");
        }
    }
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

export function getZigArchName(armName: string): string {
    switch (process.arch) {
        case "ia32":
            return "x86";
        case "x64":
            return "x86_64";
        case "arm":
            return armName;
        case "arm64":
            return "aarch64";
        case "ppc":
            return "powerpc";
        case "ppc64":
            return "powerpc64le";
        case "loong64":
            return "loongarch64";
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

export function getVersion(
    filePath: string,
    /**
     * The command-line argument that is used to query the version of the executable.
     * Zig uses `version`. ZLS uses `--version`.
     */
    arg: string,
): semver.SemVer | null {
    try {
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const buffer = childProcess.execFileSync(filePath, [arg], { cwd: wsFolder });
        const versionString = buffer.toString("utf8").trim();
        if (versionString === "0.2.0.83a2a36a") {
            // Zig 0.2.0 reports the version in a non-semver format
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
    isMach: boolean;
}

export type VersionIndex = Record<
    string,
    {
        version?: string;
        notes?: string;
    } & Record<string, undefined | { tarball: string; shasum: string; size: string }>
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
