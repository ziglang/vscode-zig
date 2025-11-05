import vscode from "vscode";

import childProcess from "child_process";
import path from "path";
import util from "util";

import { DebouncedFunc, throttle } from "lodash-es";

import { getWorkspaceFolder, isWorkspaceFile, workspaceConfigUpdateNoThrow } from "./zigUtil";
import { zigProvider } from "./zigSetup";

const execFile = util.promisify(childProcess.execFile);

export default class ZigTestRunnerProvider {
    private testController: vscode.TestController;
    private updateTestItems: DebouncedFunc<(document: vscode.TextDocument) => void>;

    constructor() {
        this.updateTestItems = throttle(
            (document: vscode.TextDocument) => {
                this._updateTestItems(document);
            },
            500,
            { trailing: true },
        );

        this.testController = vscode.tests.createTestController("zigTestController", "Zig Tests");
        this.testController.createRunProfile("Run", vscode.TestRunProfileKind.Run, this.runTests.bind(this), true);
        this.testController.createRunProfile(
            "Debug",
            vscode.TestRunProfileKind.Debug,
            this.debugTests.bind(this),
            false,
        );
    }

    public activate(subscriptions: vscode.Disposable[]) {
        subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                this.updateTestItems(document);
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (!isWorkspaceFile(document.uri.fsPath)) this.deleteTestForAFile(document.uri);
            }),
            vscode.workspace.onDidChangeTextDocument((change) => {
                this.updateTestItems(change.document);
            }),
            vscode.workspace.onDidDeleteFiles((event) => {
                event.files.forEach((file) => {
                    this.deleteTestForAFile(file);
                });
            }),
            vscode.workspace.onDidRenameFiles((event) => {
                event.files.forEach((file) => {
                    this.deleteTestForAFile(file.oldUri);
                });
            }),
        );
    }

    private deleteTestForAFile(uri: vscode.Uri) {
        this.testController.items.forEach((item) => {
            if (!item.uri) return;
            if (item.uri.fsPath === uri.fsPath) {
                this.testController.items.delete(item.id);
            }
        });
    }

    private _updateTestItems(textDocument: vscode.TextDocument) {
        if (textDocument.languageId !== "zig") return;

        const regex = /^(?![ \t]*\/\/\/?\s*)[ \t]*\btest\s+(?:"([^"]+)"|([A-Za-z0-9_]\w*)|@"([^"]+)")\s*\{/gm;

        const matches = Array.from(textDocument.getText().matchAll(regex));
        this.deleteTestForAFile(textDocument.uri);

        for (const match of matches) {
            const testDesc = match[1] || match[2] || match[3];
            const isDocTest = !match[1];
            const position = textDocument.positionAt(match.index);
            const line = textDocument.lineAt(position.line);
            const range = textDocument.lineAt(line.lineNumber).range;

            const fileName = path.basename(textDocument.uri.fsPath);

            // Add doctest prefix to handle scenario where test name matches one with non doctest. E.g `test foo` and `test "foo"`
            const testItem = this.testController.createTestItem(
                `${fileName}.test.${isDocTest ? "doctest." : ""}${testDesc}`, // Test id needs to be unique, so adding file name prefix
                `${fileName} - ${testDesc}`,
                textDocument.uri,
            );
            testItem.range = range;
            this.testController.items.add(testItem);
        }
    }

    private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
        const run = this.testController.createTestRun(request);
        // request.include will have individual test when we run test from gutter icon
        // if test is run from test explorer, request.include will be undefined and we run all tests that are active
        for (const item of request.include ?? this.testController.items) {
            if (token.isCancellationRequested) break;
            const testItem = Array.isArray(item) ? item[1] : item;

            run.started(testItem);
            const start = new Date();
            run.appendOutput(`[${start.toISOString()}] Running test: ${testItem.label}\r\n`);
            const { output, success } = await this.runTest(testItem);
            run.appendOutput(output.replaceAll("\n", "\r\n"));
            run.appendOutput("\r\n");
            const elapsed = new Date().getMilliseconds() - start.getMilliseconds();

            if (!success) {
                run.failed(testItem, new vscode.TestMessage(output), elapsed);
            } else {
                run.passed(testItem, elapsed);
            }
        }
        run.end();
    }

    private async runTest(test: vscode.TestItem): Promise<{ output: string; success: boolean }> {
        const config = vscode.workspace.getConfiguration("zig");
        const zigPath = zigProvider.getZigPath();
        if (!zigPath) {
            return { output: "Unable to run test without Zig", success: false };
        }
        if (test.uri === undefined) {
            return { output: "Unable to determine file location", success: false };
        }

        const testUri = test.uri;
        const wsFolder = getWorkspaceFolder(testUri.fsPath)?.uri.fsPath ?? path.dirname(testUri.fsPath);

        const parts = test.id.split(".");
        const lastPart = parts[parts.length - 1];

        const testArgsConf = config.get<string[]>("testArgs") ?? [];
        const args: string[] =
            testArgsConf.length > 0
                ? testArgsConf.map((v) => v.replace("${filter}", lastPart).replace("${path}", testUri.fsPath))
                : [];

        try {
            const { stderr: output } = await execFile(zigPath, args, { cwd: wsFolder });

            return { output: output.replaceAll("\n", "\r\n"), success: true };
        } catch (e) {
            if (e instanceof Error) {
                if (
                    config.get<string[]>("testArgs")?.toString() ===
                        config.inspect<string[]>("testArgs")?.defaultValue?.toString() &&
                    (e.message.includes("no module named") || e.message.includes("import of file outside module path"))
                ) {
                    void vscode.window
                        .showInformationMessage("Use build script to run tests?", "Yes", "No")
                        .then(async (response) => {
                            if (response === "Yes") {
                                await workspaceConfigUpdateNoThrow(
                                    config,
                                    "testArgs",
                                    ["build", "test", "-Dtest-filter=${filter}"],
                                    false,
                                );
                                void vscode.commands.executeCommand(
                                    "workbench.action.openWorkspaceSettings",
                                    "@id:zig.testArgs",
                                );
                            }
                        });
                }

                return { output: e.message.replaceAll("\n", "\r\n"), success: false };
            } else {
                return { output: "Failed to run test\r\n", success: false };
            }
        }
    }

    private async debugTests(req: vscode.TestRunRequest, token: vscode.CancellationToken) {
        const run = this.testController.createTestRun(req);
        for (const item of req.include ?? this.testController.items) {
            if (token.isCancellationRequested) break;
            const test = Array.isArray(item) ? item[1] : item;
            run.started(test);
            const start = new Date();
            run.appendOutput(`[${start.toISOString()}] Running test: ${test.label}\r\n`);
            try {
                const [exitCode, output] = await this.debugTest(run, test);
                run.appendOutput(output.replaceAll("\n", "\r\n"));
                run.appendOutput("\r\n");
                const elapsed = new Date().getMilliseconds() - start.getMilliseconds();
                if (exitCode === 0) {
                    run.passed(test, elapsed);
                } else {
                    run.failed(test, new vscode.TestMessage(output));
                }
            } catch (e) {
                const elapsed = new Date().getMilliseconds() - start.getMilliseconds();
                run.failed(test, new vscode.TestMessage((e as Error).message), elapsed);
            }
        }
        run.end();
    }

    private async debugTest(run: vscode.TestRun, testItem: vscode.TestItem): Promise<[number, string]> {
        if (testItem.uri === undefined) {
            throw new Error("Unable to determine file location");
        }

        const config = vscode.workspace.getConfiguration("zig");
        const debugAdapter = config.get<string>("debugAdapter", "lldb");

        const testBinaryPath = await this.buildTestBinary(run, testItem.uri.fsPath, getTestDesc(testItem));
        const debugConfig: vscode.DebugConfiguration = {
            type: debugAdapter,
            name: `Debug ${testItem.label}`,
            request: "launch",
            program: testBinaryPath,
            cwd: path.dirname(testItem.uri.fsPath),
            stopAtEntry: false,
        };
        return new Promise((resolve, reject) => {
            const disposables: vscode.Disposable[] = [];
            let exitCode = 0;
            let output = "";

            vscode.debug.onDidTerminateDebugSession((session) => {
                if (session.name === debugConfig.name) {
                    for (const disposable of disposables) {
                        disposable.dispose();
                    }
                    resolve([exitCode, output]);
                }
            }, disposables);

            type Message =
                | { type: "event"; event: "output"; body: { output: string } }
                | { type: "event"; event: "exited"; body: { exitCode: number } }
                | { type: "response" };
            disposables.push(
                vscode.debug.registerDebugAdapterTrackerFactory(debugAdapter, {
                    createDebugAdapterTracker() {
                        return {
                            onDidSendMessage: (m: Message) => {
                                if (m.type === "event" && m.event === "output") {
                                    output += m.body.output;
                                }
                                if (m.type === "event" && m.event === "exited") {
                                    exitCode = m.body.exitCode;
                                }
                            },
                        };
                    },
                }),
            );

            vscode.debug.startDebugging(undefined, debugConfig).then(
                (success) => {
                    if (!success) {
                        for (const disposable of disposables) {
                            disposable.dispose();
                        }
                        reject(new Error("Failed to start debug session"));
                    }
                },
                (err: unknown) => {
                    for (const disposable of disposables) {
                        disposable.dispose();
                    }
                    reject(err as Error);
                },
            );
        });
    }

    private async buildTestBinary(run: vscode.TestRun, testFilePath: string, testDesc: string): Promise<string> {
        const config = vscode.workspace.getConfiguration("zig");
        const zigPath = zigProvider.getZigPath();
        if (!zigPath) {
            throw new Error("Unable to build test binary without Zig");
        }

        const wsFolder = getWorkspaceFolder(testFilePath)?.uri.fsPath ?? path.dirname(testFilePath);
        const outputDir = path.join(wsFolder, "zig-out", "bin");
        const binaryPath = path.join(outputDir, "debug-unit-tests");
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

        const debugTestArgsConf = config.get<string[]>("debugTestArgs") ?? [];
        const args = debugTestArgsConf.map((arg) =>
            arg.replace("${filter}", testDesc).replace("${path}", testFilePath).replace("${binaryPath}", binaryPath),
        );

        const { stdout, stderr } = await execFile(zigPath, args, { cwd: wsFolder });
        if (stderr) {
            run.appendOutput(stderr.replaceAll("\n", "\r\n"));
            throw new Error(`Failed to build test binary: ${stderr}`);
        }
        run.appendOutput(stdout.replaceAll("\n", "\r\n"));
        return binaryPath;
    }
}

function getTestDesc(testItem: vscode.TestItem): string {
    const parts = testItem.id.split(".");
    return parts[parts.length - 1];
}
