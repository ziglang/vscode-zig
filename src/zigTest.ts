'use strict';
import * as vscode from 'vscode';
import { execCmd } from './zigUtil';

export class ZigTestProvider {
    controller: vscode.TestController;

    constructor() {
        this.controller = vscode.tests.createTestController('zigTestController', 'Zig Test');

        this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => runTestHandler(this.controller, request, token),
        );

        this.controller.resolveHandler = async test => {
            if (test) {
                await parseTestsInFileContents(this.controller, test);
            } else {
                await discoverAllTestFilesInWorkspace(this.controller);
            }
        };

        for (const document of vscode.workspace.textDocuments) {
            parseTestsInDocument(this.controller, document);
        }

        this.controller.refreshHandler = async () => {
            this.controller.items.forEach((item, collection) => {
                collection.delete(item.id);
            });
            await discoverAllTestFilesInWorkspace(this.controller);
        };
    }

    public dispose() {
        this.controller.dispose()
        vscode.workspace.onDidOpenTextDocument(document => parseTestsInDocument(this, document))
        vscode.workspace.onDidChangeTextDocument(event => {
            this.controller.items.delete(event.document.uri.path)
            parseTestsInDocument(this, event.document)
        })
    }
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
    const existing = controller.items.get(uri.path);
    if (existing) {
        return existing;
    }

    const file = controller.createTestItem(uri.path, uri.path.split('/').pop()!, uri);
    file.canResolveChildren = true;
    return file;
}

function parseTestsInDocument(controller: vscode.TestController, document: vscode.TextDocument) {
    if (document.uri.scheme === 'file' && document.uri.path.endsWith('.zig')) {
        parseTestsInFileContents(controller, getOrCreateFile(controller, document.uri), document.getText());
    }
}

async function parseTestsInFileContents(controller: vscode.TestController, file: vscode.TestItem, contents?: string) {
    if (contents === undefined) {
        const rawContent = await vscode.workspace.fs.readFile(file.uri);
        contents = new TextDecoder().decode(rawContent);
    }

    const regex = /test\s*"(.+)"\s*{/gm;

    let lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let match = regex.exec(lines[i]);
        if (match !== null) {
            let testCaseName = match[1];
            let id = file.uri.path + ':- test -:' + testCaseName;

            let testSuite = getOrCreateFile(controller, file.uri);
            let testCase = controller.createTestItem(id, testCaseName, file.uri);
            testCase.range = new vscode.Range(i, 0, i, Infinity);
            if (!controller.items.get(file.uri.path)) {
                controller.items.add(testSuite);
            }
            testSuite.children.add(testCase);
        }
    }
}

async function discoverAllTestFilesInWorkspace(controller: vscode.TestController) {
    if (!vscode.workspace.workspaceFolders) {
        return [];
    }

    return Promise.all(
        vscode.workspace.workspaceFolders.map(async workspaceFolder => {
            const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.zig');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            watcher.onDidCreate(uri => getOrCreateFile(controller, uri));
            watcher.onDidChange(uri => {
                controller.items.delete(uri.path)
                parseTestsInFileContents(controller, getOrCreateFile(controller, uri))
            });
            watcher.onDidDelete(uri => controller.items.delete(uri.path));

            for (const file of await vscode.workspace.findFiles(pattern)) {
                let test = getOrCreateFile(controller, file);
                await parseTestsInFileContents(controller, test);
            }

            return watcher;
        })
    );
}

async function runTestHandler(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    const run = controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    if (request.include) {
        request.include.forEach(test => queue.push(test));
    } else {
        controller.items.forEach(test => queue.push(test));
    }

    while (queue.length > 0 && !token.isCancellationRequested) {
        const test = queue.pop()!;
        if (request.exclude?.includes(test)) {
            continue;
        }
        if (test.id.indexOf(':- test -:') != -1) {
            const start = Date.now();
            run.started(test);
            try {
                let [document, testCase] = test.id.split(':- test -:');
                await zigTest(document, testCase);
                run.passed(test, Date.now() - start);
            } catch (e) {
                let [document, testCase] = test.id.split(':- test -:');
                let message = new vscode.TestMessage(e.toString());

                let path = document.replace(/\//g, "\\/");

                let regex = new RegExp(path + ":(\\d+):(\\d+)", "gm");
                let location = new vscode.Position(0, 0);
                let match = regex.exec(e.toString());
                if (match !== null) {
                    let line = parseInt(match[1]) - 1;
                    let col = parseInt(match[2]) - 1;
                    location = new vscode.Position(line, col);
                }

                message.location = new vscode.Location(vscode.Uri.file(document), location);
                run.failed(test, message, Date.now() - start);
            }
        }
        test.children.forEach(test => queue.push(test));
    }

    run.end();
}

function zigTest(document: string, testCase: string) {
    const config = vscode.workspace.getConfiguration('zig');
    const zigPath = config.get<string>('zigPath') || 'zig';

    const options = {
        cmdArguments: ['test', document, '--test-filter', '"' + testCase + '"'],
        notFoundText: 'Could not find zig. Please add zig to your PATH or specify a custom path to the zig binary in your settings.',
    };
    return execCmd(zigPath, options);
}
