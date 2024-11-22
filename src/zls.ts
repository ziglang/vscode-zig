import vscode from "vscode";

import {
    CancellationToken,
    ConfigurationParams,
    DocumentSelector,
    LSPAny,
    LanguageClient,
    LanguageClientOptions,
    RequestHandler,
    ResponseError,
    ServerOptions,
} from "vscode-languageclient/node";
import axios from "axios";
import camelCase from "camelcase";
import semver from "semver";

import * as versionManager from "./versionManager";
import { getHostZigName, getVersion, handleConfigOption, resolveExePathAndVersion } from "./zigUtil";
import { zigProvider } from "./zigSetup";

const ZIG_MODE: DocumentSelector = [
    { language: "zig", scheme: "file" },
    { language: "zig", scheme: "untitled" },
];

let versionManagerConfig: versionManager.Config;
let statusItem: vscode.LanguageStatusItem;
let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

export async function restartClient(context: vscode.ExtensionContext): Promise<void> {
    const result = await getZLSPath(context);
    updateStatusItem(result?.version ?? null);

    if (!result) return;

    try {
        const newClient = await startClient(result.exe);
        await stopClient();
        client = newClient;
    } catch (reason) {
        if (reason instanceof Error) {
            void vscode.window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason.message}`);
        } else {
            void vscode.window.showWarningMessage("Failed to run Zig Language Server (ZLS)");
        }
    }
}

async function startClient(zlsPath: string): Promise<LanguageClient> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: debugLog ? ["--enable-debug-log"] : [],
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: ZIG_MODE,
        outputChannel,
        middleware: {
            workspace: {
                configuration: configurationMiddleware,
            },
        },
    };

    const languageClient = new LanguageClient("zig.zls", "Zig Language Server", serverOptions, clientOptions);
    await languageClient.start();
    // Formatting is handled by `zigFormat.ts`
    languageClient.getFeature("textDocument/formatting").dispose();
    return languageClient;
}

async function stopClient(): Promise<void> {
    if (!client) return;
    // The `stop` call will send the "shutdown" notification to the LSP
    await client.stop();
    // The `dipose` call will send the "exit" request to the LSP which actually tells the child process to exit
    await client.dispose();
    client = null;
}

/** returns the file system path to the zls executable */
async function getZLSPath(context: vscode.ExtensionContext): Promise<{ exe: string; version: semver.SemVer } | null> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    let zlsExePath = configuration.get<string>("path");
    let zlsVersion: semver.SemVer | null = null;

    if (!!zlsExePath) {
        // This will fail on older ZLS version that do not support `zls --version`.
        // It should be more likely that the given executable is invalid than someone using ZLS 0.9.0 or older.
        const result = resolveExePathAndVersion(zlsExePath, "zls", "zig.zls.path", "--version");
        if ("message" in result) {
            void vscode.window.showErrorMessage(result.message);
            return null;
        }
        return result;
    }

    if (configuration.get<"ask" | "off" | "on">("enabled", "ask") !== "on") return null;

    const zigVersion = zigProvider.getZigVersion();
    if (!zigVersion) return null;

    const result = await fetchVersion(context, zigVersion, true);
    if (!result) return null;

    try {
        zlsExePath = await versionManager.install(versionManagerConfig, result.version);
        zlsVersion = result.version;
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to install ZLS ${result.version.toString()}: ${err.message}`);
        } else {
            void vscode.window.showErrorMessage(`Failed to install ZLS ${result.version.toString()}!`);
        }
        return null;
    }

    /** `--version` has been added in https://github.com/zigtools/zls/pull/583 */
    const zlsVersionArgAdded = new semver.SemVer("0.10.0-dev.150+cb5eeb0b4");

    if (semver.gte(zlsVersion, zlsVersionArgAdded)) {
        // Verify the installation by quering the version
        const checkedZLSVersion = getVersion(zlsExePath, "--version");
        if (!checkedZLSVersion) {
            void vscode.window.showErrorMessage(`Unable to check ZLS version. '${zlsExePath} --version' failed!`);
            return null;
        }

        if (checkedZLSVersion.compare(zlsVersion) !== 0) {
            // The Matrix is broken!
            void vscode.window.showWarningMessage(
                `Encountered unexpected ZLS version. Expected '${zlsVersion.toString()}' from '${zlsExePath} --version' but got '${checkedZLSVersion.toString()}'!`,
            );
        }
    }

    return {
        exe: zlsExePath,
        version: zlsVersion,
    };
}

async function configurationMiddleware(
    params: ConfigurationParams,
    token: CancellationToken,
    next: RequestHandler<ConfigurationParams, LSPAny[], void>,
): Promise<LSPAny[] | ResponseError> {
    const optionIndices: Record<string, number | undefined> = {};

    params.items.forEach((param, index) => {
        if (param.section) {
            if (param.section === "zls.zig_exe_path") {
                param.section = "zig.path";
            } else {
                param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
            }
            optionIndices[param.section] = index;
        }
    });

    const result = await next(params, token);
    if (result instanceof ResponseError) {
        return result;
    }

    const configuration = vscode.workspace.getConfiguration("zig.zls");

    for (const name in optionIndices) {
        const index = optionIndices[name] as unknown as number;
        const section = name.slice("zig.zls.".length);
        const configValue = configuration.get(section);
        if (typeof configValue === "string" && configValue) {
            result[index] = handleConfigOption(configValue);
        }
    }

    const indexOfZigPath = optionIndices["zig.path"];
    if (indexOfZigPath !== undefined) {
        result[indexOfZigPath] = zigProvider.getZigPath();
    }

    const additionalOptions = configuration.get<Record<string, unknown>>("additionalOptions", {});

    for (const optionName in additionalOptions) {
        const section = optionName.slice("zig.zls.".length);

        const doesOptionExist = configuration.inspect(section)?.defaultValue !== undefined;
        if (doesOptionExist) {
            // The extension has defined a config option with the given name but the user still used `additionalOptions`.
            const response = await vscode.window.showWarningMessage(
                `The config option 'zig.zls.additionalOptions' contains the already existing option '${optionName}'`,
                `Use ${optionName} instead`,
                "Show zig.zls.additionalOptions",
            );
            switch (response) {
                case `Use ${optionName} instead`:
                    const { [optionName]: newValue, ...updatedAdditionalOptions } = additionalOptions;
                    await configuration.update("additionalOptions", updatedAdditionalOptions, true);
                    await configuration.update(section, newValue, true);
                    break;
                case "Show zig.zls.additionalOptions":
                    await vscode.commands.executeCommand("workbench.action.openSettingsJson", {
                        revealSetting: { key: "zig.zls.additionalOptions" },
                    });
                    continue;
                case undefined:
                    continue;
            }
        }

        const optionIndex = optionIndices[optionName];
        if (!optionIndex) {
            // ZLS has not requested a config option with the given name.
            continue;
        }

        result[optionIndex] = additionalOptions[optionName];
    }

    return result as unknown[];
}

/**
 * Similar to https://ziglang.org/download/index.json
 */
interface SelectVersionResponse {
    /** The ZLS version */
    version: string;
    /** `YYYY-MM-DD` */
    date: string;
    [artifact: string]: ArtifactEntry | string | undefined;
}

interface SelectVersionFailureResponse {
    /**
     * The `code` **may** be one of `SelectVersionFailureCode`. Be aware that new
     * codes can be added over time.
     */
    code: number;
    /** A simplified explanation of why no ZLS build could be selected */
    message: string;
}

interface ArtifactEntry {
    /** A download URL */
    tarball: string;
    /** A SHA256 hash of the tarball */
    shasum: string;
    /** Size of the tarball in bytes */
    size: string;
}

async function fetchVersion(
    context: vscode.ExtensionContext,
    zigVersion: semver.SemVer,
    useCache: boolean,
): Promise<{ version: semver.SemVer; artifact: ArtifactEntry } | null> {
    // Should the cache be periodically cleared?
    const cacheKey = `zls-select-version-${zigVersion.raw}`;

    let response: SelectVersionResponse | SelectVersionFailureResponse | null = null;
    try {
        response = (
            await axios.get<SelectVersionResponse | SelectVersionFailureResponse>(
                "https://releases.zigtools.org/v1/zls/select-version",
                {
                    params: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        zig_version: zigVersion.raw,
                        compatibility: "only-runtime",
                    },
                },
            )
        ).data;

        // Cache the response
        if (useCache) {
            await context.globalState.update(cacheKey, response);
        }
    } catch (err) {
        // Try to read the result from cache
        if (useCache) {
            response = context.globalState.get<SelectVersionResponse | SelectVersionFailureResponse>(cacheKey) ?? null;
        }

        if (!response) {
            if (err instanceof Error) {
                void vscode.window.showErrorMessage(`Failed to query ZLS version: ${err.message}`);
            } else {
                throw err;
            }
            return null;
        }
    }

    if ("message" in response) {
        void vscode.window.showErrorMessage(`Unable to fetch ZLS: ${response.message as string}`);
        return null;
    }

    const hostName = getHostZigName();

    if (!(hostName in response)) {
        void vscode.window.showErrorMessage(
            `A prebuilt ZLS ${response.version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`,
        );
        return null;
    }

    return {
        version: new semver.SemVer(response.version),
        artifact: response[hostName] as ArtifactEntry,
    };
}

async function isEnabled(): Promise<boolean> {
    const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
    if (!!zlsConfig.get<string>("path")) return true;

    switch (zlsConfig.get<"ask" | "off" | "on">("enabled", "ask")) {
        case "on":
            return true;
        case "off":
            return false;
        case "ask": {
            const response = await vscode.window.showInformationMessage(
                "We recommend enabling the ZLS Language Server for a better editing experience. Would you like to install it?",
                { modal: true },
                "Yes",
                "No",
            );
            switch (response) {
                case "Yes":
                    await zlsConfig.update("enabled", "on", true);
                    return true;
                case "No":
                    await zlsConfig.update("enabled", "off", true);
                    return false;
                case undefined:
                    return false;
            }
        }
    }
}

function updateStatusItem(version: semver.SemVer | null) {
    if (version) {
        statusItem.text = `ZLS ${version.toString()}`;
        statusItem.detail = "ZLS Version";
        statusItem.severity = vscode.LanguageStatusSeverity.Information;
        statusItem.command = {
            title: "View Output",
            command: "zig.zls.openOutput",
        };
    } else {
        statusItem.text = "ZLS not enabled";
        statusItem.detail = undefined;
        statusItem.severity = vscode.LanguageStatusSeverity.Error;
        const zigPath = zigProvider.getZigPath();
        const zigVersion = zigProvider.getZigVersion();
        if (zigPath !== null && zigVersion !== null) {
            statusItem.command = {
                title: "Enable",
                command: "zig.zls.enable",
            };
        } else {
            statusItem.command = undefined;
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    {
        // This check can be removed once enough time has passed so that most users switched to the new value

        // convert a `zig.zls.path` that points to the global storage to `zig.zls.enabled == "on"`
        const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
        const zlsPath = zlsConfig.get<string>("path", "");
        if (zlsPath.startsWith(context.globalStorageUri.fsPath)) {
            await zlsConfig.update("enabled", "on", true);
            await zlsConfig.update("path", undefined, true);
        }
    }

    versionManagerConfig = {
        context: context,
        title: "ZLS",
        exeName: "zls",
        extraTarArgs: [],
        versionArg: "--version",
        canonicalUrl: {
            release: vscode.Uri.parse("https://builds.zigtools.org"),
            nightly: vscode.Uri.parse("https://builds.zigtools.org"),
        },
    };

    outputChannel = vscode.window.createOutputChannel("Zig Language Server");
    statusItem = vscode.languages.createLanguageStatusItem("zig.zls.status", ZIG_MODE);
    statusItem.name = "ZLS";
    updateStatusItem(null);

    context.subscriptions.push(
        outputChannel,
        statusItem,
        vscode.commands.registerCommand("zig.zls.enable", async () => {
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            await zlsConfig.update("enabled", "on");
        }),
        vscode.commands.registerCommand("zig.zls.stop", async () => {
            await stopClient();
        }),
        vscode.commands.registerCommand("zig.zls.startRestart", async () => {
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            await zlsConfig.update("enabled", "on");
            await restartClient(context);
        }),
        vscode.commands.registerCommand("zig.zls.openOutput", () => {
            outputChannel.show();
        }),
    );

    if (await isEnabled()) {
        await restartClient(context);
    }

    // These checks are added later to avoid ZLS be started twice because `isEnabled` sets `zig.zls.enabled`.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (change) => {
            // The `zig.path` config option is handled by `zigProvider.onChange`.
            if (
                change.affectsConfiguration("zig.zls.enabled", undefined) ||
                change.affectsConfiguration("zig.zls.path", undefined) ||
                change.affectsConfiguration("zig.zls.debugLog", undefined)
            ) {
                await restartClient(context);
            }
        }),
        zigProvider.onChange.event(async () => {
            await restartClient(context);
        }),
    );
}

export async function deactivate(): Promise<void> {
    await stopClient();
    await versionManager.removeUnusedInstallations(versionManagerConfig);
}
