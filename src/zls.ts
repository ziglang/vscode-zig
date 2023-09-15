import { ExtensionContext, window, workspace } from "vscode";

import axios from "axios";
import camelCase from "camelcase";
import * as child_process from "child_process";
import * as fs from "fs";
import mkdirp from "mkdirp";
import * as os from "os";
import * as path from "path";
import semver from "semver";
import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions
} from "vscode-languageclient/node";
import which from "which";
import { shouldCheckUpdate } from "./extension";
import { getZigPath } from "./zigUtil";

export let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

export const downloadsRoot = "https://zig.pm/zls/downloads";

/* eslint-disable @typescript-eslint/naming-convention */
export enum InstallationName {
    x86_linux = "x86-linux",
    x86_windows = "x86-windows",
    x86_64_linux = "x86_64-linux",
    x86_64_macos = "x86_64-macos",
    x86_64_windows = "x86_64-windows",
    arm_64_macos = "aarch64-macos",
    arm_64_linux = "aarch64-linux",
}
/* eslint-enable @typescript-eslint/naming-convention */

export function getDefaultInstallationName(): InstallationName | null {
    // NOTE: Not using a JS switch because they're very clunky :(

    const plat = process.platform;
    const arch = process.arch;
    if (arch === "ia32") {
        if (plat === "linux") return InstallationName.x86_linux;
        else if (plat === "win32") return InstallationName.x86_windows;
    } else if (arch === "x64") {
        if (plat === "linux") return InstallationName.x86_64_linux;
        else if (plat === "darwin") return InstallationName.x86_64_macos;
        else if (plat === "win32") return InstallationName.x86_64_windows;
    } else if (arch === "arm64") {
        if (plat === "darwin") return InstallationName.arm_64_macos;
        if (plat === "linux") return InstallationName.arm_64_linux;
    }

    return null;
}

export async function installExecutable(context: ExtensionContext): Promise<string | null> {
    const def = getDefaultInstallationName();
    if (!def) {
        window.showInformationMessage("Your system isn\"t built by our CI!\nPlease follow the instructions [here](https://github.com/zigtools/zls#from-source) to get started!");
        return null;
    }

    return window.withProgress({
        title: "Installing zls...",
        location: vscode.ProgressLocation.Notification,
    }, async progress => {
        progress.report({ message: "Downloading zls executable..." });
        const exe = (await axios.get(`${downloadsRoot}/${def}/bin/zls${def.endsWith("windows") ? ".exe" : ""}`, {
            responseType: "arraybuffer"
        })).data;

        progress.report({ message: "Installing..." });
        const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zls_install");
        if (!fs.existsSync(installDir.fsPath)) mkdirp.sync(installDir.fsPath);

        const zlsBinPath = vscode.Uri.joinPath(installDir, `zls${def.endsWith("windows") ? ".exe" : ""}`).fsPath;
        const zlsBinTempPath = zlsBinPath + ".tmp";

        // Create a new executable file.
        // Do not update the existing file in place, to avoid code-signing crashes on macOS.
        // https://developer.apple.com/documentation/security/updating_mac_software
        fs.writeFileSync(zlsBinTempPath, exe, "binary");
        fs.chmodSync(zlsBinTempPath, 0o755);
        if (fs.existsSync(zlsBinPath)) fs.rmSync(zlsBinPath);
        fs.renameSync(zlsBinTempPath, zlsBinPath);

        const config = workspace.getConfiguration("zig.zls");
        await config.update("path", zlsBinPath, true);

        return zlsBinPath;
    });
}

export async function checkUpdateMaybe(context: ExtensionContext) {
    const configuration = workspace.getConfiguration("zig.zls");
    const checkForUpdate = configuration.get<boolean>("checkForUpdate", true);
    if (checkForUpdate) {
        try {
            await checkUpdate(context, true);
        } catch (err) {
            outputChannel.appendLine(`Failed to check for update. Reason: ${err.message}`);
        }
    }
}

export async function startClient(context: ExtensionContext) {
    const configuration = workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const zlsPath = await getZLSPath(context);

    if (!zlsPath) {
        promptAfterFailure(context);
        return null;
    }

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: debugLog ? ["--enable-debug-log"] : [],
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "zig" }],
        outputChannel,
        middleware: {
            workspace: {
                async configuration(params, token, next) {
                    let indexOfAstCheck = null;
                    let indexOfZigPath = null;

                    for (const [index, param] of Object.entries(params.items)) {
                        if (param.section === "zls.zig_exe_path") {
                            param.section = "zig.zigPath";
                            indexOfZigPath = index;
                        } else if (param.section === "zls.enable_ast_check_diagnostics") {
                            indexOfAstCheck = index;
                        } else {
                            param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
                        }
                    }

                    const result = await next(params, token);

                    if (indexOfAstCheck !== null) {
                        result[indexOfAstCheck] = workspace.getConfiguration("zig").get<string>("astCheckProvider", "zls") === "zls";
                    }
                    if (indexOfZigPath !== null) {
                        try {
                            result[indexOfZigPath] = getZigPath();
                        } catch {
                            result[indexOfZigPath] = "zig";
                        }
                    }

                    return result;
                }
            }
        }
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        "zls",
        "Zig Language Server",
        serverOptions,
        clientOptions
    );

    return client.start().catch(reason => {
        window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason}`);
        client = null;
    }).then(() => {
        if (workspace.getConfiguration("zig").get<string>("formattingProvider", "zls") !== "zls")
            client.getFeature("textDocument/formatting").dispose();
    });
}

export async function stopClient(): Promise<void> {
    if (client) client.stop();
    client = null;
}

export async function promptAfterFailure(context: ExtensionContext): Promise<string | null> {
    const configuration = workspace.getConfiguration("zig.zls");
    const response = await window.showWarningMessage("Couldn't find Zig Language Server (ZLS) executable",
        "Install", "Specify path", "Use ZLS in PATH", "Disable"
    );

    if (response === "Install") {
        return await installExecutable(context);
    } else if (response === "Specify path") {
        const uris = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: "Select Zig Language Server (ZLS) executable",
        });

        if (uris) {
            await configuration.update("path", uris[0].fsPath, true);
            return uris[0].fsPath;
        }
    } else if (response === "Use ZLS in PATH") {
        await configuration.update("path", "", true);
    } else {
        await configuration.update("enabled", false, true);
    }

    return null;
}

// returns the file system path to the zls executable
export async function getZLSPath(context: ExtensionContext): Promise<string | null> {
    const configuration = workspace.getConfiguration("zig.zls");
    let zlsPath = configuration.get<string | null>("path", null);

    // Allow passing the ${workspaceFolder} predefined variable
    // See https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
    if (zlsPath && zlsPath.includes("${workspaceFolder}")) {
        // We choose the first workspaceFolder since it is ambiguous which one to use in this context
        if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
            // older versions of Node (which VSCode uses) may not have String.prototype.replaceAll
            zlsPath = zlsPath.replace(/\$\{workspaceFolder\}/gm, workspace.workspaceFolders[0].uri.fsPath);
        }
    }

    if (!zlsPath) {
        zlsPath = which.sync("zls", { nothrow: true });
    } else if (zlsPath.startsWith("~")) {
        zlsPath = path.join(os.homedir(), zlsPath.substring(1));
    } else if (!path.isAbsolute(zlsPath)) {
        zlsPath = which.sync(zlsPath, { nothrow: true });
    }

    let message: string | null = null;

    const zlsPathExists = zlsPath !== null && fs.existsSync(zlsPath);
    if (zlsPath && zlsPathExists) {
        try {
            fs.accessSync(zlsPath, fs.constants.R_OK | fs.constants.X_OK);
        } catch {
            message = `\`zls.path\` ${zlsPath} is not an executable`;
        }
        const stat = fs.statSync(zlsPath);
        if (!stat.isFile()) {
            message = `\`zls.path\` ${zlsPath} is not a file`;
        }
    }

    if (message === null) {
        if (!zlsPath) {
            return null;
        } else if (!zlsPathExists) {
            if (await isZLSPrebuildBinary(context)) {
                return null;
            }
            message = `Couldn't find Zig Language Server (ZLS) executable at "${zlsPath.replace(/"/gm, "\\\"")}"`;
        }
    }

    if (message) {
        await window.showErrorMessage(message);
        return null;
    }

    return zlsPath;
}

export async function checkUpdate(context: ExtensionContext, autoInstallPrebuild: boolean): Promise<void> {
    const configuration = workspace.getConfiguration("zig.zls");

    const zlsPath = await getZLSPath(context);
    if (!zlsPath) return;

    if (!await isUpdateAvailable(zlsPath)) return;

    const isPrebuild = await isZLSPrebuildBinary(context);

    if (autoInstallPrebuild && isPrebuild) {
        await installExecutable(context);
    } else {
        const message = `There is a new update available for ZLS. ${!isPrebuild ? "It would replace your installation with a prebuilt binary." : ""}`;
        const response = await window.showInformationMessage(message, "Install update", "Never ask again");

        if (response === "Install update") {
            await installExecutable(context);
        } else if (response === "Never ask again") {
            await configuration.update("checkForUpdate", false, true);
        }
    }

}

// checks whether zls has been installed with `installExecutable`
export async function isZLSPrebuildBinary(context: ExtensionContext): Promise<boolean> {
    const configuration = workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string | null>("path", null);
    if (!zlsPath) return false;

    const zlsBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zls_install", "zls").fsPath;
    return zlsPath.startsWith(zlsBinPath);
}

// checks whether there is newer version on master
export async function isUpdateAvailable(zlsPath: string): Promise<boolean | null> {
    // get current version
    const buffer = child_process.execFileSync(zlsPath, ["--version"]);
    const version = semver.parse(buffer.toString("utf8"));
    if (!version) return null;

    // compare version triple if commit id is available
    if (version.prerelease.length === 0 || version.build.length === 0) {
        // get latest tagged version
        const tagsResponse = await axios.get("https://api.github.com/repos/zigtools/zls/tags");
        const latestVersion = tagsResponse.data[0].name;
        return semver.gt(latestVersion, version);
    }

    const response = await axios.get("https://api.github.com/repos/zigtools/zls/commits/master");
    const masterHash: string = response.data.sha;

    const isMaster = masterHash.startsWith(version.build[0]);

    return !isMaster;
}

export async function openConfig(context: ExtensionContext): Promise<void> {
    const zlsPath = await getZLSPath(context);
    if (!zlsPath) return;

    const buffer = child_process.execFileSync(zlsPath, ["--show-config-path"]);
    const path: string = buffer.toString("utf8").trimEnd();
    await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
}

function isEnabled(): boolean {
    return workspace.getConfiguration("zig.zls", null).get<boolean>("enabled", true);
}

const zlsDisabledMessage = "zls is not enabled; if you'd like to enable it, please set 'zig.zls.enabled' to true.";
export async function activate(context: ExtensionContext) {
    outputChannel = window.createOutputChannel("Zig Language Server");

    vscode.commands.registerCommand("zig.zls.install", async () => {
        if (!isEnabled()) {
            window.showErrorMessage(zlsDisabledMessage);
            return;
        }

        await stopClient();
        await installExecutable(context);
    });

    vscode.commands.registerCommand("zig.zls.stop", async () => {
        if (!isEnabled()) {
            window.showErrorMessage(zlsDisabledMessage);
            return;
        }

        await stopClient();
    });

    vscode.commands.registerCommand("zig.zls.startRestart", async () => {
        if (!isEnabled()) {
            window.showErrorMessage(zlsDisabledMessage);
            return;
        }

        await stopClient();
        await checkUpdateMaybe(context);
        await startClient(context);
    });

    vscode.commands.registerCommand("zig.zls.openconfig", async () => {
        if (!isEnabled()) {
            window.showErrorMessage(zlsDisabledMessage);
            return;
        }

        await openConfig(context);
    });

    vscode.commands.registerCommand("zig.zls.update", async () => {
        if (!isEnabled()) {
            window.showErrorMessage(zlsDisabledMessage);
            return;
        }

        await stopClient();
        await checkUpdate(context, false);
        await startClient(context);
    });

    if (!isEnabled())
        return;

    const configuration = workspace.getConfiguration("zig.zls", null);
    if (!configuration.get<string | null>("path", null)) {
        const response = await window.showInformationMessage(
            "We recommend enabling ZLS (the Zig Language Server) for a better editing experience. Would you like to install it? You can always change this later by modifying `zig.zls.enabled` in your settings.",
            "Install", "Specify path", "Use ZLS in PATH", "Disable"
        );

        if (response === "Install") {
            await configuration.update("enabled", true, true);
            await installExecutable(context);
        } else if (response === "Specify path") {
            await configuration.update("enabled", true, true);
            const uris = await window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select Zig Language Server (ZLS) executable",
            });

            if (uris) {
                await configuration.update("path", uris[0].fsPath, true);
            }
        } else {
            await configuration.update("enabled", response === "Use ZLS in PATH", true);
        }
    }

    if (shouldCheckUpdate(context, "zlsUpdate")) {
        await checkUpdateMaybe(context);
    }
    await startClient(context);
}

export function deactivate(): Thenable<void> {
    return stopClient();
}
