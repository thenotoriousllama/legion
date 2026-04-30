import * as vscode from "vscode";
import { LegionSidebarProvider } from "./sidebar/sidebarProvider";
import { initialize } from "./commands/initialize";
import { documentRepository } from "./commands/document";
import { updateDocumentation } from "./commands/update";
import { scanDirectory } from "./commands/scanDirectory";
import { lintWiki } from "./commands/lint";

export function activate(context: vscode.ExtensionContext): void {
  // Sidebar
  const sidebarProvider = new LegionSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("legion.sidebar", sidebarProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("legion.initialize", () => initialize(context)),
    vscode.commands.registerCommand("legion.document", () => documentRepository(context)),
    vscode.commands.registerCommand("legion.update", () => updateDocumentation(context)),
    vscode.commands.registerCommand("legion.scanDirectory", () => scanDirectory(context)),
    vscode.commands.registerCommand("legion.lint", () => lintWiki(context))
  );
}

export function deactivate(): void {
  // No-op; nothing to clean up explicitly.
}
