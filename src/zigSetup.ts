import { ExtensionContext, window, workspace } from "vscode";

import axios from "axios";
import { createHash } from "crypto";
import * as fs from "fs";
import mkdirp from "mkdirp";
import semver from "semver";
import * as vscode from "vscode";
import { execCmd, getHostZigName, getVersion, isWindows, shouldCheckUpdate } from "./zigUtil";
import { install as installZLS } from "./zls";

const DOWNLOAD_INDEX = "https://ziglang.org/download/index.json";

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
    // eslint-disable-next-line prefer-const
    for (let [key, value] of Object.entries(indexJson)) {
        if (key === "master") { key = "nightly"; }
        if (value[hostName]) {
            result.push({
                name: key,
                url: value[hostName]["tarball"],
                sha: value[hostName]["shasum"],
            });
        }
    }
    if (result.length === 0) {
        throw Error(`no pre-built Zig is available for your system '${hostName}', you can build it yourself using https://github.com/ziglang/zig-bootstrap`);
    }
    return result;
}

async function install(context: ExtensionContext, version: ZigVersion) {
    await window.withProgress({
        title: "Installing Zig...",
        location: vscode.ProgressLocation.Notification,
    }, async progress => {
        progress.report({ message: "Downloading Zig tarball..." });
        const tarball: Buffer = (await axios.get(version.url, {
            responseType: "arraybuffer"
        })).data;
        const tarHash = createHash("sha256").update(tarball).digest("hex");
        if (tarHash !== version.sha) {
            throw Error(`hash of downloaded tarball ${tarHash} does not match expected hash ${version.sha}`);
        }

        const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zig_install");
        if (fs.existsSync(installDir.fsPath)) { fs.rmSync(installDir.fsPath, { recursive: true, force: true }); }
        mkdirp.sync(installDir.fsPath);

        progress.report({ message: "Extracting..." });
        const tar = execCmd("tar", {
            cmdArguments: ["-xJf", "-", "-C", installDir.fsPath, "--strip-components=1"],
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
        await configuration.update("path", zigPath, true);
    });
}

async function selectVersionAndInstall(context: ExtensionContext) {
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
        if (selection === undefined) { return; }
        for (const option of available) {
            if (option.name === selection.label) {
                await install(context, option);
                return;
            }
        }
    } catch (err) {
        window.showErrorMessage(`Unable to install Zig: ${err}`);
    }
}

async function checkUpdate(context: ExtensionContext) {
    try {
        const update = await getUpdatedVersion(context);
        if (!update) return;

        const response = await window.showInformationMessage(`New version of Zig available: ${update.name}`, "Install", "Ignore");
        if (response === "Install") {
            await install(context, update);
        }
    } catch (err) {
        window.showErrorMessage(`Unable to update Zig: ${err}`);
    }
}

async function getUpdatedVersion(context: ExtensionContext): Promise<ZigVersion | null> {
    const configuration = workspace.getConfiguration("zig");
    const zigPath = configuration.get<string>("path");
    if (zigPath) {
        const zigBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zig_install", "zig").fsPath;
        if (!zigPath.startsWith(zigBinPath)) return null;
    }

    const curVersion = getVersion(zigPath, "version");

    const available = await getVersions();
    if (curVersion.prerelease.length != 0) {
        if (available[0].name == "nightly") {
            const newVersion = getNightlySemVer(available[0].url);
            if (semver.gt(newVersion, curVersion)) {
                available[0].name = `nightly-${newVersion}`;
                return available[0];
            }
        }
    } else if (available.length > 2 && semver.gt(available[1].name, curVersion)) {
        return available[1];
    }
    return null;
}

export async function setupZig(context: ExtensionContext) {
    vscode.commands.registerCommand("zig.install", async () => {
        await selectVersionAndInstall(context);
        await installZLS(context, true);
    });

    vscode.commands.registerCommand("zig.update", async () => {
        await checkUpdate(context);
    });

    const configuration = workspace.getConfiguration("zig");
    if (!configuration.get<boolean>("initialSetupDone")) {
        await configuration.update("initialSetupDone",
            await initialSetup(context), true);
    }

    if (!configuration.get<string>("path")) return;
    if (!configuration.get<boolean>("checkForUpdate")) return;
    if (!shouldCheckUpdate(context, "zigUpdate")) return;
    await checkUpdate(context);
}

async function initialSetup(context: ExtensionContext): Promise<boolean> {
    const zigConfig = workspace.getConfiguration("zig");
    const zigResponse = await window.showInformationMessage(
        "Zig path hasn't been set, do you want to specify the path or install Zig?",
        { modal: true },
        "Install", "Specify path", "Use Zig in PATH"
    );

    if (zigResponse === "Install") {
        await selectVersionAndInstall(context);
        const configuration = workspace.getConfiguration("zig");
        const path = configuration.get<string>("path");
        if (!path) return false;
        window.showInformationMessage(`Zig was installed at '${path}', add it to PATH to use it from the terminal`);
    } else if (zigResponse === "Specify path") {
        const uris = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: "Select Zig executable",
        });
        if (!uris) return false;

        const version = getVersion(uris[0].path, "version");
        if (!version) return false;

        await zigConfig.update("path", uris[0].path, true);
    } else if (zigResponse === "Use Zig in PATH") {
        await zigConfig.update("path", "", true);
    } else return false;

    const zlsConfig = workspace.getConfiguration("zig.zls");
    const zlsResponse = await window.showInformationMessage(
        "We recommend enabling ZLS (the Zig Language Server) for a better editing experience. Would you like to install it?",
        { modal: true },
        "Install", "Specify path", "Use ZLS in PATH"
    );

    if (zlsResponse === "Install") {
        await installZLS(context, false);
    } else if (zlsResponse === "Specify path") {
        const uris = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: "Select Zig Language Server (ZLS) executable",
        });
        if (!uris) return true;

        await zlsConfig.update("path", uris[0].path, true);
    } else if (zlsResponse === "Use ZLS in PATH") {
        await zlsConfig.update("path", "", true);
    }

    return true;
}
