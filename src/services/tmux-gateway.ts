import type { TmuxPane } from "../core/types.js";
import { capturePane, listAllPanes, sendKeys, startPipePane, stopPipePane } from "./tmux.js";

export interface TmuxGateway {
  listPanes(): Promise<TmuxPane[]>;
  capture(paneId: string, lines?: number): Promise<string>;
  startPipe(paneId: string, logPath: string): Promise<void>;
  stopPipe(paneId: string): Promise<void>;
  send(paneId: string, keys: string): Promise<void>;
}

export class RealTmuxGateway implements TmuxGateway {
  listPanes(): Promise<TmuxPane[]> { return listAllPanes(); }
  capture(paneId: string, lines?: number): Promise<string> { return capturePane(paneId, lines); }
  startPipe(paneId: string, logPath: string): Promise<void> { return startPipePane(paneId, logPath); }
  stopPipe(paneId: string): Promise<void> { return stopPipePane(paneId); }
  send(paneId: string, keys: string): Promise<void> { return sendKeys(paneId, keys); }
}
