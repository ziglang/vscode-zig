import * as vscode from "vscode";

/**
 * CodelensProvider
 */
export class CodelensProvider implements vscode.CodeLensProvider {
  private codeLenses: vscode.CodeLens[] = [];
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidChangeConfiguration((_) => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    this.codeLenses = [];
    const text = document.getText();

    var was_newline = false;
    var test_keyword_start = -1;
    for (let i = 0; i < text.length; i++) {
      // test "foo"
      // ^
      if (
        was_newline &&
        text.length > i + 4 &&
        text[i] === "t" &&
        text[i + 1] === "e" &&
        text[i + 2] === "s" &&
        text[i + 3] === "t" &&
        (text[i + 4] === " " || text[i + 4] === "\n")
      ) {
        test_keyword_start = i;
        i += 4;
      }

      // test "foo"
      //      ^
      if (test_keyword_start > -1 && text[i] === '"') {
        i += 1;
        const quote_start = i;

        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\" && text[i + 1] === '"') {
            i += 1;
          }
          i += 1;
        }
        const quote_end = i;

        const line = document.lineAt(
          document.positionAt(test_keyword_start).line
        );
        const indexOf = line.text.indexOf(
          text.substring(test_keyword_start, i)
        );
        const position = new vscode.Position(line.lineNumber, indexOf);
        const range = document.getWordRangeAtPosition(position, null);
        this.codeLenses.push(
          new vscode.CodeLens(range, {
            title: "Run test",
            command: "zig.test.run",
            arguments: [
              document.uri,
              `"${text.substring(quote_start, quote_end)}"`,
            ],
            tooltip: "Run this test via zig test",
          })
        );

        test_keyword_start = -1;
        // test without a label
      } else if (test_keyword_start > -1 && text[i] !== " ") {
        const line = document.lineAt(
          document.positionAt(test_keyword_start).line
        );
        const indexOf = line.text.indexOf(
          text.substring(test_keyword_start, i)
        );
        const position = new vscode.Position(line.lineNumber, indexOf);
        const range = document.getWordRangeAtPosition(position, null);
        this.codeLenses.push(
          new vscode.CodeLens(range, {
            title: "Run test",
            command: "zig.test.run",
            arguments: [document.uri, ""],
            tooltip: "Run this test via zig test",
          })
        );
        test_keyword_start = -1;
      }

      switch (text[i]) {
        case "\n": {
          was_newline = true;
          break;
        }

        case " ": {
          break;
        }
        default: {
          was_newline = false;
          break;
        }
      }
    }

    return this.codeLenses;
  }
}
