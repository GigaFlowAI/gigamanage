import type { TmuxPane } from "../../src/core/types.js";
import type { TmuxGateway } from "../../src/services/tmux-gateway.js";

export class FakeTmuxGateway implements TmuxGateway {
  private panes: TmuxPane[] = [];
  private captures = new Map<string, string>();
  readonly sent: Array<{ paneId: string; keys: string }> = [];
  readonly piped = new Set<string>();

  setPanes(panes: TmuxPane[]): void { this.panes = panes; }
  setCapture(paneId: string, text: string): void { this.captures.set(paneId, text); }

  async listPanes(): Promise<TmuxPane[]> { return [...this.panes]; }
  async capture(paneId: string, lines?: number): Promise<string> { return this.captures.get(paneId) ?? ""; }
  async startPipe(paneId: string, logPath: string): Promise<void> { this.piped.add(paneId); }
  async stopPipe(paneId: string): Promise<void> { this.piped.delete(paneId); }
  async send(paneId: string, keys: string): Promise<void> { this.sent.push({ paneId, keys }); }
}
