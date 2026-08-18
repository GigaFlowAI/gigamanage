import type { TmuxPane } from "../../src/core/types.js";
import type { TmuxGateway } from "../../src/services/tmux-gateway.js";

export class FakeTmuxGateway implements TmuxGateway {
  private panes: TmuxPane[] = [];
  private captures = new Map<string, string>();
  readonly sent: Array<{ paneId: string; keys: string }> = [];
  readonly piped = new Set<string>();
  readonly labels: Array<{ paneId: string; name: string; value: string }> = [];

  private nextWin = 100;
  readonly created: Array<{ windowId: string; name: string }> = [];
  readonly renamed: Array<{ windowId: string; name: string }> = [];
  readonly joins: Array<{ srcPane: string; dst: string }> = [];
  readonly breaks: Array<{ pane: string; windowId: string; name?: string }> = [];
  readonly swaps: Array<{ a: string; b: string }> = [];
  readonly layouts: Array<{ windowId: string; layout: string }> = [];

  setPanes(panes: TmuxPane[]): void { this.panes = panes; }
  setCapture(paneId: string, text: string): void { this.captures.set(paneId, text); }

  async listPanes(): Promise<TmuxPane[]> { return [...this.panes]; }
  async capture(paneId: string, lines?: number): Promise<string> { return this.captures.get(paneId) ?? ""; }
  async startPipe(paneId: string, logPath: string): Promise<void> { this.piped.add(paneId); }
  async stopPipe(paneId: string): Promise<void> { this.piped.delete(paneId); }
  async send(paneId: string, keys: string): Promise<void> { this.sent.push({ paneId, keys }); }
  async setOption(paneId: string, name: string, value: string): Promise<void> {
    this.labels.push({ paneId, name, value });
  }

  async newWindow(name: string): Promise<string> {
    const windowId = `@${this.nextWin++}`;
    this.created.push({ windowId, name });
    return windowId;
  }
  async renameWindow(windowId: string, name: string): Promise<void> { this.renamed.push({ windowId, name }); }
  async joinPane(srcPane: string, dst: string): Promise<void> { this.joins.push({ srcPane, dst }); }
  async breakPane(pane: string, name?: string): Promise<string> {
    const windowId = `@${this.nextWin++}`;
    this.breaks.push({ pane, windowId, name });
    return windowId;
  }
  async swapPane(a: string, b: string): Promise<void> { this.swaps.push({ a, b }); }
  async selectLayout(windowId: string, layout: string): Promise<void> { this.layouts.push({ windowId, layout }); }
}
