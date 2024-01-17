
import * as Path from 'path';
import { Range, Uri, workspace, window } from 'vscode';

/*---------------------------------------------------------------------------------------------
 *  Derived from https://github.com/microsoft/vscode-python/blob/2f3102fe0bb007df0d80276f488c2d0257f4f3b1/src/client/common/variables/systemVariables.ts
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 * 
 *  MIT License
 *  
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *  
 *  The above copyright notice and this permission notice shall be included in all
 *  copies or substantial portions of the Software.
 *  
 *  THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 *--------------------------------------------------------------------------------------------*/

export class SystemVariables {

    private _workspaceFolder: string;
    private _workspaceFolderName: string;
    private _workspaceFolders: Map<string, string>;
    private _env: Map<string, string>;
    private _filePath: string | undefined;
    private _lineNumber: number | undefined;
    private _selectedText: string | undefined;
    private _execPath: string;

    constructor(file: Uri | undefined, rootFolder: string) {
        const workspaceFolder = workspace && file ? workspace.getWorkspaceFolder(file) : undefined;
        this._workspaceFolder = workspaceFolder ? workspaceFolder.uri.fsPath : rootFolder;
        this._workspaceFolderName = Path.basename(this._workspaceFolder);
        this._filePath = file ? file.fsPath : undefined;
        const editor = window.activeTextEditor;
        
        this._lineNumber = editor ? editor.selection.anchor.line + 1 : undefined;
        this._selectedText = editor ? editor.document.getText(editor.selection) : undefined;
        this._execPath = process.execPath;
        this._env = new Map(Object.entries(process.env));
        this._workspaceFolders = new Map();
        for (const folder of workspace.workspaceFolders) {
            this._workspaceFolders.set(Path.basename(folder.uri.fsPath), folder.uri.fsPath);
            this._workspaceFolders.set(folder.name, folder.uri.fsPath);
        }
    }
    // https://code.visualstudio.com/docs/editor/variables-reference#_configuration-variables
    public resolveString(value: string): string {
        const regexp = /\$\{(.*?)\}/g;
        return value.replace(regexp, (match: string, name: string) => this.resolveVariable(name) ?? match);
    }

    resolveVariable(variable: string): string | undefined {
        const group = variable.split(":", 2);
        switch (group[0]) {
            case "cwd": return this._workspaceFolder;
            case "workspaceRoot": return group.length == 2 ? this._workspaceFolders.get(group[1]) : this._workspaceFolder;
            case "workspaceFolder": return this._workspaceFolder;
            case "workspaceRootFolderName": return this._workspaceFolderName;
            case "workspaceFolderBasename": return this._workspaceFolderName;
            case "file": return this._filePath;
            case "relativeFile": return this._filePath ? Path.relative(this._workspaceFolder, this._filePath) : undefined;
            case "relativeFileDirname": return this._filePath ? Path.relative(this._workspaceFolder, Path.dirname(this._filePath)) : undefined;
            case "fileBasename": return this._filePath ? Path.basename(this._filePath) : undefined;
            case "fileBasenameNoExtension": return this._filePath ? Path.parse(this._filePath).name : undefined;
            case "fileDirname": return this._filePath ? Path.dirname(this._filePath) : undefined;
            case "fileExtname": return this._filePath ? Path.extname(this._filePath) : undefined;
            case "lineNumber": return this._lineNumber ? this._lineNumber.toString() : undefined;
            case "selectedText": return this._selectedText;
            case "execPath": return this._execPath;
            case "env": return this._env.get(group[1] || null) ?? "";
            default: return undefined;
        }
    }
}