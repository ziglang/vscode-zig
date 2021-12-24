import * as cp from "child_process";
import { Uri, window, workspace } from "vscode";

export const isWindows = process.platform === "win32";

/** Options for execCmd */
export interface ExecCmdOptions {
  /** The project root folder for this file is used as the cwd of the process */
  fileName?: Uri;
  /** Any arguments */
  cmdArguments?: string[];
  /** Shows a message if an error occurs (in particular the command not being */
  /* found), instead of rejecting. If this happens, the promise never resolves */
  showMessageOnError?: boolean;
  /** Called after the process successfully starts */
  onStart?: () => void;
  /** Called when data is sent to stdout */
  onStdout?: (data: string) => void;
  /** Called when data is sent to stderr */
  onStderr?: (data: string) => void;
  /** Called after the command (successfully or unsuccessfully) exits */
  onExit?: () => void;
  /** Text to add when command is not found (maybe helping how to install) */
  notFoundText?: string;
}

/** Type returned from execCmd. Is a promise for when the command completes
 *  and also a wrapper to access ChildProcess-like methods.
 */
export interface ExecutingCmd
  extends Promise<{ stdout: string; stderr: string }> {
  /** The process's stdin */
  stdin: NodeJS.WritableStream;
  /** End the process */
  kill();
  /** Is the process running */
  isRunning: boolean; // tslint:disable-line
}
let projectRootCache = new Map();

/** Executes a command. Shows an error message if the command isn't found */
export function execCmd(
  cmd: string,
  options: ExecCmdOptions = {}
): ExecutingCmd {
  const { fileName, onStart, onStdout, onStderr, onExit, cmdArguments } =
    options;
  let childProcess,
    firstResponse = true,
    wasKilledbyUs = false;

  const executingCmd: any = new Promise((resolve, reject) => {
    let cmdArguments = options ? options.cmdArguments : [];

    childProcess = cp.exec(
      cmd + " " + (cmdArguments || []).join(" "),
      {
        cwd: workspace.getWorkspaceFolder(fileName).uri.fsPath,
      },
      handleExit
    );

    childProcess.stdout.on("data", (data: Buffer) => {
      if (firstResponse && onStart) {
        onStart();
      }
      firstResponse = false;
      if (onStdout) {
        onStdout(data.toString());
      }
    });

    childProcess.stderr.on("data", (data: Buffer) => {
      if (firstResponse && onStart) {
        onStart();
      }
      firstResponse = false;
      if (onStderr) {
        onStderr(data.toString());
      }
    });

    function handleExit(err: Error, stdout: string, stderr: string) {
      executingCmd.isRunning = false;
      if (onExit) {
        onExit();
      }
      if (!wasKilledbyUs) {
        if (err) {
          if (options.showMessageOnError) {
            const cmdName = cmd.split(" ", 1)[0];
            const cmdWasNotFound =
              // Windows method apparently still works on non-English systems
              (isWindows &&
                err.message.includes(`'${cmdName}' is not recognized`)) ||
              (!isWindows && (<any>err).code === 127);

            if (cmdWasNotFound) {
              let notFoundText = options ? options.notFoundText : "";
              window.showErrorMessage(
                `${cmdName} is not available in your path. ` + notFoundText
              );
            } else {
              window.showErrorMessage(err.message);
            }
          } else {
            reject(err);
          }
        } else {
          resolve({ stdout: stdout, stderr: stderr });
        }
      }
    }
  });
  executingCmd.stdin = childProcess.stdin;
  executingCmd.kill = killProcess;
  executingCmd.isRunning = true;

  return executingCmd as ExecutingCmd;

  function killProcess() {
    wasKilledbyUs = true;
    if (isWindows) {
      cp.spawn("taskkill", ["/pid", childProcess.pid.toString(), "/f", "/t"]);
    } else {
      childProcess.kill("SIGINT");
    }
  }
}

const buildFile = "build.zig";
