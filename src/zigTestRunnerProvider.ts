import vscode from "vscode";

import childProcess from "child_process";
import path from "path";
import util from "util";

import { DebouncedFunc, throttle } from "lodash-es";

import { getWorkspaceFolder, isWorkspaceFile } from "./zigUtil";
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

        const regex = /\btest\s+(?:"([^"]+)"|([a-zA-Z0-9_][\w]*)|@"([^"]+)")\s*\{/g;
        const matches = Array.from(textDocument.getText().matchAll(regex));
        this.deleteTestForAFile(textDocument.uri);

        for (const match of matches) {
            const testDesc = match[1] || match[2] || match[3];
            const isDocTest = !match[1];
            const position = textDocument.positionAt(match.index);
            const range = new vscode.Range(position, position.translate(0, match[0].length));
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
        const zigPath = zigProvider.getZigPath();
        if (!zigPath) {
            return { output: "Unable to run test without Zig", success: false };
        }
        if (test.uri === undefined) {
            return { output: "Unable to determine file location", success: false };
        }
        const testPath = test.uri.fsPath;
        const wsFolder = getWorkspaceFolder(testPath)?.uri.fsPath ?? path.dirname(testPath);

        const parts = test.id.split(".");
        const lastPart = parts[parts.length - 1];

        const args = getTestArgs(testPath, lastPart, false);

        try {
            const { stderr: output } = await execFile(zigPath, args, {
                cwd: wsFolder
            });
            return { output: output.replaceAll("\n", "\r\n"), success: true };
        } catch (e) {
            return { output: (e as Error).message.replaceAll("\n", "\r\n"), success: false };
        }
    }

    private async debugTests(req: vscode.TestRunRequest, token: vscode.CancellationToken) {
        const run = this.testController.createTestRun(req);
        for (const item of req.include ?? this.testController.items) {
            if (token.isCancellationRequested) break;
            const test = Array.isArray(item) ? item[1] : item;
            run.started(test);
            try {
                await this.debugTest(run, test);
                run.passed(test);
            } catch (e) {
                run.failed(test, new vscode.TestMessage((e as Error).message));
            }
        }
        run.end();
    }

    private async debugTest(run: vscode.TestRun, testItem: vscode.TestItem) {
        if (testItem.uri === undefined) {
            throw new Error("Unable to determine file location");
        }
        const testPath = testItem.uri.fsPath;
        const wsFolder = getWorkspaceFolder(testPath)?.uri.fsPath ?? path.dirname(testPath);
        const testBinaryPath = await this.buildTestBinary(run, testPath, getTestDesc(testItem), true);

        const debugConfig: vscode.DebugConfiguration = {
            type: "lldb",
            name: `Debug ${testItem.label}`,
            request: "launch",
            program: testBinaryPath,
            cwd: wsFolder,
            stopAtEntry: false,
        };
        await vscode.debug.startDebugging(undefined, debugConfig);
    }

    private async buildTestBinary(run: vscode.TestRun, testFilePath: string, testDesc: string, isDebug: boolean): Promise<string> {
        const zigPath = zigProvider.getZigPath();
        if (!zigPath) {
            throw new Error("Unable to build test binary without Zig");
        }

        const wsFolder = getWorkspaceFolder(testFilePath)?.uri.fsPath ?? path.dirname(testFilePath);
        const outputDir = path.join(wsFolder, "zig-out", "tmp-debug-build", "bin");
        const binaryName = `test-${path.basename(testFilePath, ".zig")}`;
        const binaryPath = path.join(outputDir, binaryName);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

        const args = getTestArgs(testFilePath, testDesc, isDebug);
        args.push("--test-no-exec", `-femit-bin=${binaryPath}`);

        const { stdout, stderr } = await execFile(zigPath, args);
        if (stderr) {
            run.appendOutput(stderr.replaceAll("\n", "\r\n"));
            throw new Error(`Failed to build test binary: ${stderr}`);
        }
        run.appendOutput(stdout.replaceAll("\n", "\r\n"));
        return binaryPath;
    }
}

function getTestArgs(testFilePath: string, testFilter: string, isDebug: boolean): string[] {
    const args = ["test"];

    if (!isDebug) {
        // Note when running in an lldb debugger. the experimental x86 backend does not produce debug symbols
        // for local variables. Therefore until this is resolved, debug sessions have to use the llvm backend.
        //
        const config = vscode.workspace.getConfiguration("zig");
        if (config.get<boolean>("testrunner.no-llvm")) {
            args.push("-fno-llvm");
        }
    }

    args.push(testFilePath, "--test-filter", testFilter);

    console.log("Test args", args);
    return args;
}

function getTestDesc(testItem: vscode.TestItem): string {
    const parts = testItem.id.split(".");
    return parts[parts.length - 1];
}
