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

import {
    downloadAndExtractArtifact,
    getExePath,
    getHostZigName,
    getVersion,
    getZigPath,
    handleConfigOption,
    shouldCheckUpdate,
} from "./zigUtil";

let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

const ZIG_MODE: DocumentSelector = [
    { language: "zig", scheme: "file" },
    { language: "zig", scheme: "untitled" },
];

async function startClient() {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const zlsPath = getZLSPath();

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: debugLog ? ["--enable-debug-log"] : [],
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: ZIG_MODE,
        outputChannel,
        middleware: {
            workspace: {
                configuration: configurationMiddleware,
            },
        },
    };

    // Create the language client and start the client.
    client = new LanguageClient("zig.zls", "Zig Language Server", serverOptions, clientOptions);

    return client
        .start()
        .catch((reason: unknown) => {
            if (reason instanceof Error) {
                void vscode.window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason.message}`);
            } else {
                void vscode.window.showWarningMessage("Failed to run Zig Language Server (ZLS)");
            }
            client = null;
        })
        .then(() => {
            if (client && vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") !== "zls") {
                client.getFeature("textDocument/formatting").dispose();
            }
        });
}

export async function stopClient() {
    if (client) {
        // The `stop` call will send the "shutdown" notification to the LSP
        await client.stop();
        // The `dipose` call will send the "exit" request to the LSP which actually tells the child process to exit
        await client.dispose();
    }
    client = null;
}

/** returns the file system path to the zls executable */
export function getZLSPath(): string {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path");
    const exePath = zlsPath !== "zls" ? zlsPath : null; // the string "zls" means lookup in PATH
    return getExePath(exePath, "zls", "zig.zls.path");
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
        try {
            result[indexOfZigPath] = getZigPath();
        } catch {
            // ZLS will try to find Zig by itself and likely fail as well.
            // This will cause two "Zig can't be found in $PATH" error messages to be reported.
            result[indexOfZigPath] = null;
        }
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

export interface SelectVersionFailureResponse {
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
    zigVersion: semver.SemVer,
): Promise<{ version: semver.SemVer; artifact: ArtifactEntry } | null> {
    let response: SelectVersionResponse | SelectVersionFailureResponse;
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
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to query ZLS version: ${err.message}`);
        } else {
            throw err;
        }
        return null;
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

// checks whether there is newer version on master
async function checkUpdate(context: vscode.ExtensionContext) {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path");
    const zlsBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zls_install", "zls").fsPath;
    if (!zlsPath?.startsWith(zlsBinPath)) return;

    const zigVersion = getVersion(getZigPath(), "version");
    if (!zigVersion) return;

    const currentVersion = getVersion(zlsPath, "--version");
    if (!currentVersion) return;

    const result = await fetchVersion(zigVersion);
    if (!result) return;

    if (semver.gte(currentVersion, result.version)) return;

    const response = await vscode.window.showInformationMessage("New version of ZLS available", "Install", "Ignore");
    switch (response) {
        case "Install":
            await installZLSVersion(context, result.artifact);
            break;
        case "Ignore":
        case undefined:
            break;
    }
}

export async function installZLS(context: vscode.ExtensionContext, ask: boolean) {
    const zigVersion = getVersion(getZigPath(), "version");
    if (!zigVersion) {
        const zlsConfiguration = vscode.workspace.getConfiguration("zig.zls", null);
        await zlsConfiguration.update("path", undefined, true);
        return undefined;
    }

    const result = await fetchVersion(zigVersion);
    if (!result) return;

    if (ask) {
        const selected = await vscode.window.showInformationMessage(
            `Do you want to install ZLS (the Zig Language Server) for Zig version ${result.version.toString()}`,
            "Install",
            "Ignore",
        );
        switch (selected) {
            case "Install":
                break;
            case "Ignore":
                const zlsConfiguration = vscode.workspace.getConfiguration("zig.zls", null);
                await zlsConfiguration.update("path", undefined, true);
                return;
            case undefined:
                return;
        }
    }

    await installZLSVersion(context, result.artifact);
}

async function installZLSVersion(context: vscode.ExtensionContext, artifact: ArtifactEntry) {
    const zlsPath = await downloadAndExtractArtifact(
        "ZLS",
        "zls",
        vscode.Uri.joinPath(context.globalStorageUri, "zls_install"),
        artifact.tarball,
        artifact.shasum,
        [],
    );

    const zlsConfiguration = vscode.workspace.getConfiguration("zig.zls", null);
    await zlsConfiguration.update("path", zlsPath ?? undefined, true);
}

function checkInstalled(): boolean {
    const zlsPath = vscode.workspace.getConfiguration("zig.zls").get<string>("path");
    if (!zlsPath) {
        void vscode.window.showErrorMessage("This command cannot be run without setting 'zig.zls.path'.", {
            modal: true,
        });
        return false;
    }
    return true;
}

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel("Zig Language Server");

    context.subscriptions.push(
        outputChannel,
        vscode.commands.registerCommand("zig.zls.install", async () => {
            try {
                getZigPath();
            } catch {
                void vscode.window.showErrorMessage("This command cannot be run without a valid zig path.", {
                    modal: true,
                });
                return;
            }

            await stopClient();
            await installZLS(context, false);
        }),
        vscode.commands.registerCommand("zig.zls.stop", async () => {
            if (!checkInstalled()) return;

            await stopClient();
        }),
        vscode.commands.registerCommand("zig.zls.startRestart", async () => {
            if (!checkInstalled()) return;

            await stopClient();
            await startClient();
        }),
        vscode.commands.registerCommand("zig.zls.update", async () => {
            if (!checkInstalled()) return;

            await stopClient();
            await checkUpdate(context);
        }),
        vscode.workspace.onDidChangeConfiguration(async (change) => {
            if (
                change.affectsConfiguration("zig.zls.path", undefined) ||
                change.affectsConfiguration("zig.zls.debugLog", undefined)
            ) {
                await stopClient();
                const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
                if (zlsConfig.get<string>("path")) {
                    await startClient();
                }
            }
            if (client && change.affectsConfiguration("zig.formattingProvider", undefined)) {
                client.getFeature("textDocument/formatting").dispose();
                if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "zls") {
                    client
                        .getFeature("textDocument/formatting")
                        .initialize(client.initializeResult?.capabilities ?? {}, ZIG_MODE);
                }
            }
        }),
    );

    const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
    if (!zlsConfig.get<string>("path")) return;
    if (zlsConfig.get<boolean>("checkForUpdate") && (await shouldCheckUpdate(context, "zlsUpdate"))) {
        await checkUpdate(context);
    }
    await startClient();
}

export function deactivate(): Thenable<void> {
    return stopClient();
}
