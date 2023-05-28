import { workspace, ExtensionContext, window } from "vscode";

import * as vscode from "vscode";
import axios from "axios";
import * as fs from "fs";
import decompress from "decompress"
import semver from 'semver';
import path from "path";
import os from "os";

const DOWNLOAD_INDEX = "https://ziglang.org/download/index.json";

function getHostZigName(): string {
    let os: string = process.platform;
    if (os == "darwin") os = "macos";
    if (os == "win32") os = "windows";
    let arch: string = process.arch;
    if (arch == "ia32") arch = "x86";
    if (arch == "x64") arch = "x86_64";
    if (arch == "arm64") arch = "aarch64";
    if (arch == "ppc") arch = "powerpc";
    if (arch == "ppc64") arch = "powerpc64le";
    return `${arch}-${os}`
}

function getNightlySemVer(url: string): string {
    return url.match(/-(\d+\.\d+\.\d+-dev\.\d+\+\w+)\./)[1];
}

type ZigVersion = { name: string, url: string; sha: string };
async function getVersions(): Promise<ZigVersion[]> {
    const hostName = getHostZigName();
    const tarball = (await axios.get(DOWNLOAD_INDEX, {
        responseType: "arraybuffer"
    })).data;
    const indexJson = JSON.parse(tarball);
    const result: ZigVersion[] = [];
    for (let [key, value] of Object.entries(indexJson)) {
        if (key == "master") key = "nightly";
        if (value[hostName]) {
            result.push({
                name: key,
                url: value[hostName]["tarball"],
                sha: value[hostName]["shasum"],
            });
        }
    }
    return result;
}

async function installZig(context: ExtensionContext, version: ZigVersion): Promise<void> {
    await window.withProgress({
        title: "Installing Zig...",
        location: vscode.ProgressLocation.Notification,
    }, async progress => {
        progress.report({ message: "Downloading Zig tarball..." });
        const tarball: Buffer = (await axios.get(version.url, {
            responseType: "arraybuffer"
        })).data;

        const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zig_install");
        if (fs.existsSync(installDir.fsPath)) fs.rmSync(installDir.fsPath, { recursive: true, force: true });

        progress.report({ message: "Decompressing..." });
        // TODO can't decompress tar.xz, throws no errors about it
        await decompress(tarball, installDir.fsPath);

        progress.report({ message: "Installing..." });
        const exeName = `zig${version.url.includes("windows") ? ".exe" : ""}`;
        const zigPath = vscode.Uri.joinPath(installDir, exeName).fsPath;
        fs.chmodSync(zigPath, 0o755);

        const configuration = workspace.getConfiguration("zig");
        await configuration.update("zigPath", zigPath, true);
        await configuration.update("zigVersion", version.name, true);
        // TODO install to PATH
    });
}

async function selectVersionAndInstall(context: ExtensionContext): Promise<void> {
    try {
        const configuration = workspace.getConfiguration("zig");
        let version = configuration.get<string | null>("zigVersion", null);
        const available = await getVersions();

        if (!version) {
            let items: vscode.QuickPickItem[] = [];
            for (const option of available) {
                items.push({ label: option.name });
            }
            // Recommend latest stable release.
            const placeHolder = available.length > 2 ? available[1].name : null;
            const selection = await window.showQuickPick(items, {
                title: "Select Zig version to install",
                canPickMany: false,
                placeHolder,
            });
            if (selection === undefined) return;
            version = selection.label;
            if (version == "nightly") {
                version = `nightly-${getNightlySemVer(available[0].url)}`;
            }
        }
        if (version.startsWith("nightly") && available[0].name == "nightly") {
            await installZig(context, available[0]);
        } else {
            for (const option of available) {
                if (option.name === version) {
                    await installZig(context, option);
                    return;
                }
            }
        }
    } catch (err) {
        window.showErrorMessage(`Unable to install Zig: ${err}`);
    }
}

// Check whether Zig was installed by the extension.
async function isZigPrebuildBinary(context: ExtensionContext): Promise<boolean> {
    const configuration = workspace.getConfiguration("zig");
    var zigPath = configuration.get<string | null>("zigPath", null);
    if (!zigPath) return false;

    const zigBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zig_install", "zig").fsPath;
    return zigPath.startsWith(zigBinPath);
}

async function checkUpdate(context: ExtensionContext, autoInstallPrebuild: boolean): Promise<void> {
    try {
        const update = await getUpdatedVersion();
        if (!update) return;

        const isPrebuild = await isZigPrebuildBinary(context);
        if (autoInstallPrebuild && isPrebuild) {
            await installZig(context, update);
        } else {
            const response = await window.showInformationMessage("There is a new version of Zig available, do you want to install it?", "Install", "Cancel");
            if (response === "Install") {
                await installZig(context, update);
            }
        }
    } catch (err) {
        window.showErrorMessage(`Unable to update Zig: ${err}`);
    }
}

async function getUpdatedVersion(): Promise<ZigVersion | null> {
    const configuration = workspace.getConfiguration("zig");
    const version = configuration.get<string | null>("zigVersion", null);
    if (!version) return null;

    const available = await getVersions();
    if (version.startsWith("nightly")) {
        if (available.length > 1 && available[0].name == "nightly") {
            const curVersion = version.match(/nightly-(\d+)/)[1];
            const newVersion = getNightlySemVer(available[0].url);
            if (semver.gt(newVersion, curVersion)) {
                return available[0];
            }
        }
    } else if (available.length > 2 && semver.gt(available[1].name, version)) {
        return available[1];
    }
    return null;
}

export async function setupZig(context: ExtensionContext) {
    vscode.commands.registerCommand("zig.install", async () => {
        await selectVersionAndInstall(context);
    });

    vscode.commands.registerCommand("zig.update", async () => {
        await checkUpdate(context, false);
    });

    const configuration = workspace.getConfiguration("zig", null);
    if (!configuration.get<string | null>("zigPath", null)) {
        const response = await window.showInformationMessage(
            "Zig path hasn't been set, do you want to specify the path or install Zig?",
            "Install", "Specify path"
        );

        if (response === "Install") {
            await selectVersionAndInstall(context);
        } else if (response === "Specify path") {
            const uris = await window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select Zig executable",
            });

            if (uris) {
                await configuration.update("zigPath", uris[0].path, true);
            }
        }
    }

    if (!configuration.get<boolean>("checkForUpdate", true)) return;
    await checkUpdate(context, true);
}
