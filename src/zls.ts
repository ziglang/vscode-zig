import { ExtensionContext, window, workspace } from "vscode";

import axios from "axios";
import camelCase from "camelcase";
import * as child_process from "child_process";
import * as fs from "fs";
import mkdirp from "mkdirp";
import semver, { SemVer } from "semver";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ResponseError, ServerOptions } from "vscode-languageclient/node";
import { getExePath, getHostZigName, getVersion, getZigPath, isWindows, shouldCheckUpdate } from "./zigUtil";

let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

async function startClient() {
    const configuration = workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const zlsPath = getZLSPath();

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
                    let indexOfZigPath: number | undefined;

                    params.items.forEach((param, index) => {
                        if (param.section) {
                            if (param.section === "zls.zig_exe_path") {
                                param.section = "zig.path";
                                indexOfZigPath = index;
                            } else {
                                param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
                            }
                        }
                    });

                    const result = await next(params, token);
                    if (result instanceof ResponseError) {
                        return result;
                    }

                    if (indexOfZigPath !== undefined) {
                        try {
                            result[indexOfZigPath] = getZigPath();
                        } catch {
                            // This might lead to ZLS not finding some library paths
                            // but at least other settings will be correct.
                            result[indexOfZigPath] = "zig";
                        }
                    }

                    return result as unknown[];
                },
            },
        },
    };

    // Create the language client and start the client.
    client = new LanguageClient("zig.zls", "Zig Language Server", serverOptions, clientOptions);

    return client
        .start()
        .catch((reason) => {
            void window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason}`);
            client = null;
        })
        .then(() => {
            if (client && workspace.getConfiguration("zig").get<string>("formattingProvider") !== "zls") {
                client.getFeature("textDocument/formatting").dispose();
            }
        });
}

export async function stopClient() {
    if (client) await client.stop();
    client = null;
}

// returns the file system path to the zls executable
export function getZLSPath(): string {
    const configuration = workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path") ?? null;
    return getExePath(zlsPath, "zls", "zig.zls.path");
}

const downloadsRoot = "https://zigtools-releases.nyc3.digitaloceanspaces.com/zls";

interface Version {
    date: string;
    builtWithZigVersion: string;
    zlsVersion: string;
    zlsMinimumBuildVersion: string;
    commit: string;
    targets: string[];
}

interface VersionIndex {
    latest: string;
    latestTagged: string;
    releases: Record<string, string | undefined>;
    versions: Record<string, Version | undefined>;
}

async function getVersionIndex(): Promise<VersionIndex> {
    const index = (await axios.get<VersionIndex>(`${downloadsRoot}/index.json`)).data;
    if (!index.versions[index.latest]) {
        void window.showErrorMessage("Invalid ZLS version index; please contact a ZLS maintainer.");
        throw new Error("Invalid ZLS version");
    }
    return index;
}

// checks whether there is newer version on master
async function checkUpdate(context: ExtensionContext) {
    const configuration = workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path");
    const zlsBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zls_install", "zls").fsPath;
    if (!zlsPath) return;
    if (!zlsPath.startsWith(zlsBinPath)) return;

    // get current version
    const version = getVersion(zlsPath, "--version");
    if (!version) return;

    const index = await getVersionIndex();
    const latestVersionString = version.build.length === 0 ? index.latestTagged : index.latest;
    // having a build number implies nightly version
    const latestVersion = new SemVer(latestVersionString);

    if (semver.gte(version, latestVersion)) return;

    const response = await window.showInformationMessage("New version of ZLS available", "Install", "Ignore");
    if (response === "Install") {
        await installVersion(context, latestVersion);
    }
}

export async function install(context: ExtensionContext, ask: boolean) {
    const path = getZigPath();

    const zlsConfiguration = workspace.getConfiguration("zig.zls", null);
    const zigVersion = getVersion(path, "version");
    if (!zigVersion) {
        await zlsConfiguration.update("path", undefined, true);
        return;
    }
    // Zig 0.9.0 was the first version to have a tagged zls release
    if (semver.lt(zigVersion, "0.9.0")) {
        if (zlsConfiguration.get("path")) {
            void window.showErrorMessage(`ZLS is not available for Zig version ${zigVersion.version}`);
        }
        await zlsConfiguration.update("path", undefined, true);
        return;
    }

    if (ask) {
        const result = await window.showInformationMessage(
            `Do you want to install ZLS (the Zig Language Server) for Zig version ${zigVersion.version}`,
            "Install",
            "Ignore",
        );

        if (result === undefined) return;
        if (result === "Ignore") {
            await zlsConfiguration.update("path", undefined, true);
            return;
        }
    }
    let zlsVersion: semver.SemVer;
    if (zigVersion.build.length !== 0) {
        // Nightly, install latest ZLS
        zlsVersion = new SemVer((await getVersionIndex()).latest);
    } else {
        // ZLS does not make releases for patches
        zlsVersion = zigVersion;
        zlsVersion.patch = 0;
    }

    try {
        await installVersion(context, zlsVersion);
    } catch (err) {
        if (err instanceof Error) {
            void window.showErrorMessage(
                `Unable to install ZLS ${zlsVersion.version} for Zig version ${zigVersion.version}: ${err.message}`,
            );
        } else {
            throw err;
        }
    }
}

async function installVersion(context: ExtensionContext, version: SemVer) {
    const hostName = getHostZigName();

    await window.withProgress(
        {
            title: "Installing zls...",
            location: vscode.ProgressLocation.Notification,
        },
        async (progress) => {
            const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zls_install");
            if (fs.existsSync(installDir.fsPath)) {
                fs.rmSync(installDir.fsPath, { recursive: true, force: true });
            }
            mkdirp.sync(installDir.fsPath);

            const binName = `zls${isWindows ? ".exe" : ""}`;
            const zlsBinPath = vscode.Uri.joinPath(installDir, binName).fsPath;

            progress.report({ message: "Downloading ZLS executable..." });
            let exe: Buffer;
            try {
                const response = await axios.get<Buffer>(
                    `${downloadsRoot}/${version.raw}/${hostName}/zls${isWindows ? ".exe" : ""}`,
                    {
                        responseType: "arraybuffer",
                    },
                );
                exe = response.data;
            } catch (err) {
                // Missing prebuilt binary is reported as AccessDenied
                if (axios.isAxiosError(err) && err.response?.status === 403) {
                    void window.showErrorMessage(
                        `A prebuilt ZLS ${version.version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`,
                    );
                    return;
                }
                throw err;
            }
            fs.writeFileSync(zlsBinPath, exe, "binary");
            fs.chmodSync(zlsBinPath, 0o755);

            const config = workspace.getConfiguration("zig.zls");
            await config.update("path", zlsBinPath, true);
        },
    );
}

async function openConfig() {
    const zlsPath = getZLSPath();
    const buffer = child_process.execFileSync(zlsPath, ["--show-config-path"]);
    const path: string = buffer.toString("utf8").trimEnd();
    await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
}

function checkInstalled(): boolean {
    const zlsPath = workspace.getConfiguration("zig.zls").get<string>("path");
    if (!zlsPath) {
        void window.showErrorMessage("This command cannot be run without setting 'zig.zls.path'.", { modal: true });
    }
    return !!zlsPath;
}

export async function activate(context: ExtensionContext) {
    outputChannel = window.createOutputChannel("Zig Language Server");

    vscode.commands.registerCommand("zig.zls.install", async () => {
        try {
            getZigPath();
        } catch {
            void window.showErrorMessage("This command cannot be run without a valid zig path.", { modal: true });
            return;
        }

        await stopClient();
        await install(context, true);
    });

    vscode.commands.registerCommand("zig.zls.stop", async () => {
        if (!checkInstalled()) return;

        await stopClient();
    });

    vscode.commands.registerCommand("zig.zls.startRestart", async () => {
        if (!checkInstalled()) return;

        await stopClient();
        await startClient();
    });

    vscode.commands.registerCommand("zig.zls.openconfig", async () => {
        if (!checkInstalled()) return;

        await openConfig();
    });

    vscode.commands.registerCommand("zig.zls.update", async () => {
        if (!checkInstalled()) return;

        await stopClient();
        await checkUpdate(context);
        await startClient();
    });

    const zigConfig = vscode.workspace.getConfiguration("zig");
    if (zigConfig.get<string>("path") === undefined) return;
    const zlsConfig = workspace.getConfiguration("zig.zls");
    if (zlsConfig.get<string>("path") === undefined) return;
    if (zlsConfig.get<boolean>("checkForUpdate") && (await shouldCheckUpdate(context, "zlsUpdate"))) {
        await checkUpdate(context);
    }
    await startClient();
}

export function deactivate(): Thenable<void> {
    return stopClient();
}
