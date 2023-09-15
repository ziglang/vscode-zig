import { ExtensionContext, window, workspace } from "vscode";

import axios from "axios";
import { createHash } from "crypto";
import * as fs from "fs";
import mkdirp from "mkdirp";
import semver from "semver";
import * as vscode from "vscode";
import { shouldCheckUpdate } from "./extension";
import { execCmd, isWindows } from "./zigUtil";

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
    return `${arch}-${os}`;
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
    for (const entry of Object.entries(indexJson)) {
        let [key] = entry;
        const [, value] = entry;
        if (key == "master") key = "nightly";
        if (value[hostName]) {
            result.push({
                name: key,
                url: value[hostName]["tarball"],
                sha: value[hostName]["shasum"],
            });
        }
    }
    if (result.length == 0) {
        throw `no pre-built Zig is available for your system '${hostName}', you can build it yourself using https://github.com/ziglang/zig-bootstrap`;
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
        const tarHash = createHash("sha256").update(tarball).digest("hex");
        if (tarHash != version.sha) {
            throw `hash of downloaded tarball ${tarHash} does not match expected hash ${version.sha}`;
        }

        const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zig_install");
        if (fs.existsSync(installDir.fsPath)) fs.rmSync(installDir.fsPath, { recursive: true, force: true });
        mkdirp.sync(installDir.fsPath);

        progress.report({ message: "Decompressing..." });
        const tar = execCmd("tar", {
            cmdArguments: ["-xJf", "-", "-C", `${installDir.fsPath}`, "--strip-components=1"],
            notFoundText: "Could not find tar",
        });
        tar.stdin.write(tarball);
        tar.stdin.end();
        await tar;

        progress.report({ message: "Installing..." });
        const exeName = `zig${isWindows ? ".exe" : ""}`;
        const zigPath = vscode.Uri.joinPath(installDir, exeName).fsPath;
        fs.chmodSync(zigPath, 0o755);

        const configuration = workspace.getConfiguration("zig");
        await configuration.update("zigPath", zigPath, true);
        await configuration.update("zigVersion", version.name, true);
    });
}

async function selectVersionAndInstall(context: ExtensionContext): Promise<void> {
    try {
        const available = await getVersions();

        const items: vscode.QuickPickItem[] = [];
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
        for (const option of available) {
            if (option.name === selection.label) {
                if (option.name == "nightly") {
                    option.name = `nightly-${getNightlySemVer(option.url)}`;
                }
                await installZig(context, option);
                return;
            }
        }
    } catch (err) {
        window.showErrorMessage(`Unable to install Zig: ${err}`);
    }
}

async function checkUpdate(context: ExtensionContext): Promise<void> {
    try {
        const update = await getUpdatedVersion(context);
        if (!update) return;

        const response = await window.showInformationMessage(`New version of Zig available: ${update.name}`, "Install", "Cancel");
        if (response === "Install") {
            await installZig(context, update);
        }
    } catch (err) {
        window.showErrorMessage(`Unable to update Zig: ${err}`);
    }
}

async function getUpdatedVersion(context: ExtensionContext): Promise<ZigVersion | null> {
    const configuration = workspace.getConfiguration("zig");
    const zigPath = configuration.get<string | null>("zigPath", null);
    if (zigPath) {
        const zigBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zig_install", "zig").fsPath;
        if (!zigPath.startsWith(zigBinPath)) return null;
    }

    const version = configuration.get<string | null>("zigVersion", null);
    if (!version) return null;

    const available = await getVersions();
    if (version.startsWith("nightly")) {
        if (available[0].name == "nightly") {
            const curVersion = version.slice("nightly-".length);
            const newVersion = getNightlySemVer(available[0].url);
            if (semver.gt(newVersion, curVersion)) {
                available[0].name = `nightly-${newVersion}`;
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
        await checkUpdate(context);
    });

    const configuration = workspace.getConfiguration("zig", null);
    if (configuration.get<string | null>("zigPath", null) === null) {
        const response = await window.showInformationMessage(
            "Zig path hasn't been set, do you want to specify the path or install Zig?",
            "Install", "Specify path", "Use Zig in PATH"
        );

        if (response === "Install") {
            await selectVersionAndInstall(context);
            const configuration = workspace.getConfiguration("zig", null);
            const zigPath = configuration.get<string | null>("zigPath", null);
            if (!zigPath) return;
            window.showInformationMessage(`Zig was installed at '${zigPath}', add it to PATH to use it from the terminal`);
            return;
        } else if (response === "Specify path") {
            const uris = await window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select Zig executable",
            });

            if (uris) {
                await configuration.update("zigPath", uris[0].fsPath, true);
            }
        } else if (response == "Use Zig in PATH") {
            await configuration.update("zigPath", "", true);
        } else throw "zigPath not specified";
    }

    if (!shouldCheckUpdate(context, "zigUpdate")) return;
    if (!configuration.get<boolean>("checkForUpdate", true)) return;
    await checkUpdate(context);
}
