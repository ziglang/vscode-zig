import vscode from "vscode";

import childProcess from "child_process";
import path from "path";
import util from "util";

import { DebouncedFunc, throttle } from "lodash-es";

import { getWorkspaceFolder, getZigPath, isWorkspaceFile } from "./zigUtil";

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
        void this.findAndRegisterTests();
    }

    public activate(subscriptions: vscode.Disposable[]) {
        subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                this.updateTestItems(document);
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                !isWorkspaceFile(document.uri.fsPath) && this.deleteTestForAFile(document.uri);
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

    private async findAndRegisterTests() {
        const files = await vscode.workspace.findFiles("**/*.zig");
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                this._updateTestItems(doc);
            } catch {}
        }
    }

    private _updateTestItems(textDocument: vscode.TextDocument) {
        if (textDocument.languageId !== "zig") return;

        const regex = /\btest\s+"([^"]+)"\s*\{/g;
        const matches = Array.from(textDocument.getText().matchAll(regex));
        this.deleteTestForAFile(textDocument.uri);

        for (const match of matches) {
            const testDesc = match[1];
            const position = textDocument.positionAt(match.index);
            const range = new vscode.Range(position, position.translate(0, match[0].length));
            const fileName = path.basename(textDocument.uri.fsPath);

            const testItem = this.testController.createTestItem(
                `${fileName}.test.${testDesc}`, // Test id needs to be unique, so adding file name prefix
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
        const zigPath = getZigPath();
        if (test.uri === undefined) {
            return { output: "Unable to determine file location", success: false };
        }
        const parts = test.id.split(".");
        const lastPart = parts[parts.length - 1];
        const args = ["test", "--test-filter", lastPart, test.uri.fsPath];
        try {
            const { stderr: output } = await execFile(zigPath, args);
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
        const testBinaryPath = await this.buildTestBinary(run, testItem.uri.fsPath, getTestDesc(testItem));
        const debugConfig: vscode.DebugConfiguration = {
            type: "lldb",
            name: `Debug ${testItem.label}`,
            request: "launch",
            program: testBinaryPath,
            cwd: path.dirname(testItem.uri.fsPath),
            stopAtEntry: false,
        };
        await vscode.debug.startDebugging(undefined, debugConfig);
    }

    private async buildTestBinary(run: vscode.TestRun, testFilePath: string, testDesc: string): Promise<string> {
        const wsFolder = getWorkspaceFolder(testFilePath)?.uri.fsPath ?? path.dirname(testFilePath);
        const outputDir = path.join(wsFolder, "zig-out", "tmp-debug-build", "bin");
        const binaryName = `test-${path.basename(testFilePath, ".zig")}`;
        const binaryPath = path.join(outputDir, binaryName);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

        const zigPath = getZigPath();
        const { stdout, stderr } = await execFile(zigPath, [
            "test",
            testFilePath,
            "--test-filter",
            testDesc,
            "--test-no-exec",
            `-femit-bin=${binaryPath}`,
        ]);
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
