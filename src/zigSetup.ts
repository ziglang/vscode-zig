import childProcess from "child_process";
import crypto from "crypto";
import fs from "fs";

import axios from "axios";
import mkdirp from "mkdirp";
import semver from "semver";
import vscode from "vscode";
import which from "which";

import { getHostZigName, getVersion, isWindows, shouldCheckUpdate } from "./zigUtil";
import { install as installZLS } from "./zls";

const DOWNLOAD_INDEX = "https://ziglang.org/download/index.json";

function getNightlySemVer(url: string): string {
    const matches = url.match(/-(\d+\.\d+\.\d+-dev\.\d+\+\w+)\./);
    if (!matches) throw new Error(`url '${url}' does not contain a semantic version!`);
    return matches[1];
}

type VersionIndex = Record<string, Record<string, undefined | { tarball: string; shasum: string; size: string }>>;

interface ZigVersion {
    name: string;
    url: string;
    sha: string;
}

async function getVersions(): Promise<ZigVersion[]> {
    const hostName = getHostZigName();
    const indexJson = (await axios.get<VersionIndex>(DOWNLOAD_INDEX, {})).data;
    const result: ZigVersion[] = [];
    for (let key in indexJson) {
        const value = indexJson[key];
        if (key === "master") {
            key = "nightly";
        }
        const release = value[hostName];
        if (release) {
            result.push({
                name: key,
                url: release.tarball,
                sha: release.shasum,
            });
        }
    }
    if (result.length === 0) {
        throw Error(
            `no pre-built Zig is available for your system '${hostName}', you can build it yourself using https://github.com/ziglang/zig-bootstrap`,
        );
    }
    return result;
}

async function install(context: vscode.ExtensionContext, version: ZigVersion) {
    await vscode.window.withProgress(
        {
            title: "Installing Zig",
            location: vscode.ProgressLocation.Notification,
        },
        async (progress) => {
            progress.report({ message: "downloading Zig tarball..." });
            const response = await axios.get<Buffer>(version.url, {
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
            if (tarHash !== version.sha) {
                throw Error(`hash of downloaded tarball ${tarHash} does not match expected hash ${version.sha}`);
            }

            const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zig_install");
            if (fs.existsSync(installDir.fsPath)) {
                fs.rmSync(installDir.fsPath, { recursive: true, force: true });
            }
            mkdirp.sync(installDir.fsPath);

            const tarPath = which.sync("tar", { nothrow: true });
            if (!tarPath) {
                void vscode.window.showErrorMessage(
                    "Downloaded Zig tarball can't be extracted because 'tar' could not be found",
                );
                return;
            }

            progress.report({ message: "Extracting..." });
            try {
                childProcess.execFileSync(tarPath, ["-xJf", "-", "-C", installDir.fsPath, "--strip-components=1"], {
                    encoding: "buffer",
                    input: response.data,
                    maxBuffer: 100 * 1024 * 1024, // 100MB
                    timeout: 60000, // 60 seconds
                });
            } catch (err) {
                if (err instanceof Error) {
                    void vscode.window.showErrorMessage(`Failed to extract Zig tarball: ${err.message}`);
                } else {
                    throw err;
                }
                return;
            }

            progress.report({ message: "Installing..." });
            const exeName = `zig${isWindows ? ".exe" : ""}`;
            const zigPath = vscode.Uri.joinPath(installDir, exeName).fsPath;
            fs.chmodSync(zigPath, 0o755);

            const configuration = vscode.workspace.getConfiguration("zig");
            await configuration.update("path", zigPath, true);
        },
    );
}

async function selectVersionAndInstall(context: vscode.ExtensionContext) {
    try {
        const available = await getVersions();

        const items: vscode.QuickPickItem[] = [];
        for (const option of available) {
            items.push({ label: option.name });
        }
        // Recommend latest stable release.
        const placeHolder = available.length > 2 ? available[1].name : undefined;
        const selection = await vscode.window.showQuickPick(items, {
            title: "Select Zig version to install",
            canPickMany: false,
            placeHolder: placeHolder,
        });
        if (selection === undefined) return;
        for (const option of available) {
            if (option.name === selection.label) {
                await install(context, option);
                return;
            }
        }
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Unable to install Zig: ${err.message}`);
        } else {
            throw err;
        }
    }
}

async function checkUpdate(context: vscode.ExtensionContext) {
    try {
        const update = await getUpdatedVersion(context);
        if (!update) return;

        const response = await vscode.window.showInformationMessage(
            `New version of Zig available: ${update.name}`,
            "Install",
            "Ignore",
        );
        switch (response) {
            case "Install":
                await install(context, update);
                break;
            case "Ignore":
            case undefined:
                break;
        }
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Unable to update Zig: ${err.message}`);
        } else {
            throw err;
        }
    }
}

async function getUpdatedVersion(context: vscode.ExtensionContext): Promise<ZigVersion | null> {
    const configuration = vscode.workspace.getConfiguration("zig");
    const zigPath = configuration.get<string>("path");
    if (zigPath) {
        const zigBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zig_install", "zig").fsPath;
        if (!zigPath.startsWith(zigBinPath)) return null;
    } else {
        return null;
    }

    const curVersion = getVersion(zigPath, "version");
    if (!curVersion) return null;

    const available = await getVersions();
    if (curVersion.prerelease.length !== 0) {
        if (available[0].name === "nightly") {
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

export async function setupZig(context: vscode.ExtensionContext) {
    vscode.commands.registerCommand("zig.install", async () => {
        await selectVersionAndInstall(context);
        await installZLS(context, true);
    });

    vscode.commands.registerCommand("zig.update", async () => {
        await checkUpdate(context);
    });

    const configuration = vscode.workspace.getConfiguration("zig");
    if (!configuration.get<boolean>("initialSetupDone")) {
        await configuration.update("initialSetupDone", await initialSetup(context), true);
    }

    if (!configuration.get<string>("path")) return;
    if (!configuration.get<boolean>("checkForUpdate")) return;
    if (!(await shouldCheckUpdate(context, "zigUpdate"))) return;
    await checkUpdate(context);
}

async function initialSetup(context: vscode.ExtensionContext): Promise<boolean> {
    const zigConfig = vscode.workspace.getConfiguration("zig");

    if (!zigConfig.has("path")) {
        const zigResponse = await vscode.window.showInformationMessage(
            "Zig path hasn't been set, do you want to specify the path or install Zig?",
            { modal: true },
            "Install",
            "Specify path",
            "Use Zig in PATH",
        );
        switch (zigResponse) {
            case "Install":
                await selectVersionAndInstall(context);
                const path = zigConfig.get<string>("path");
                if (!path) return false;
                void vscode.window.showInformationMessage(
                    `Zig was installed at '${path}', add it to PATH to use it from the terminal`,
                );
                break;
            case "Specify path":
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    title: "Select Zig executable",
                });
                if (!uris) return false;

                const version = getVersion(uris[0].path, "version");
                if (!version) return false;

                await zigConfig.update("path", uris[0].path, true);
                break;
            case "Use Zig in PATH":
                await zigConfig.update("path", "", true);
                break;
            case undefined:
                return false;
        }
    }

    const zlsConfig = vscode.workspace.getConfiguration("zig.zls");

    if (!zlsConfig.has("path")) {
        const zlsResponse = await vscode.window.showInformationMessage(
            "We recommend enabling ZLS (the Zig Language Server) for a better editing experience. Would you like to install it?",
            { modal: true },
            "Install",
            "Specify path",
            "Use ZLS in PATH",
        );

        switch (zlsResponse) {
            case "Install":
                await installZLS(context, false);
                break;
            case "Specify path":
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    title: "Select Zig Language Server (ZLS) executable",
                });
                if (!uris) return true;

                await zlsConfig.update("path", uris[0].path, true);
            case "Use ZLS in PATH":
                await zlsConfig.update("path", "", true);
                break;
            case undefined:
                break;
        }
    }

    return true;
}
