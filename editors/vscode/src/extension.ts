import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join("out", "server.js"));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "ember" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.ember"),
    },
  };

  client = new LanguageClient(
    "ember",
    "EmberORM Language Server",
    serverOptions,
    clientOptions,
  );
  client.start();

  // CLI-backed commands (the language server handles editing features).
  context.subscriptions.push(
    vscode.commands.registerCommand("ember.format", () =>
      vscode.commands.executeCommand("editor.action.formatDocument"),
    ),
    vscode.commands.registerCommand("ember.generate", () => runCli("generate")),
    vscode.commands.registerCommand("ember.dbPull", () => runCli("db pull")),
    vscode.commands.registerCommand("ember.validate", () =>
      vscode.window.showInformationMessage(
        "Ember: diagnostics run automatically via the language server.",
      ),
    ),
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

function runCli(command: string): void {
  const cliPath = vscode.workspace
    .getConfiguration("ember")
    .get<string>("cliPath", "npx ember");
  const terminal =
    vscode.window.terminals.find((t) => t.name === "Ember") ??
    vscode.window.createTerminal("Ember");
  terminal.show();
  terminal.sendText(`${cliPath} ${command}`);
}
