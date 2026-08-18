import type { TmuxPane } from "../core/types.js";
import {
  breakPane,
  capturePane,
  joinPane,
  listAllPanes,
  newWindow,
  renameWindow,
  selectLayout,
  sendKeys,
  setPaneOption,
  startPipePane,
  stopPipePane,
  swapPane,
} from "./tmux.js";

export interface TmuxGateway {
  listPanes(): Promise<TmuxPane[]>;
  capture(paneId: string, lines?: number): Promise<string>;
  startPipe(paneId: string, logPath: string): Promise<void>;
  stopPipe(paneId: string): Promise<void>;
  send(paneId: string, keys: string): Promise<void>;
  setOption(paneId: string, name: string, value: string): Promise<void>;
  newWindow(name: string): Promise<string>;
  renameWindow(windowId: string, name: string): Promise<void>;
  joinPane(srcPane: string, dst: string): Promise<void>;
  breakPane(pane: string, name?: string): Promise<string>;
  swapPane(a: string, b: string): Promise<void>;
  selectLayout(windowId: string, layout: string): Promise<void>;
}

export class RealTmuxGateway implements TmuxGateway {
  listPanes(): Promise<TmuxPane[]> { return listAllPanes(); }
  capture(paneId: string, lines?: number): Promise<string> { return capturePane(paneId, lines); }
  startPipe(paneId: string, logPath: string): Promise<void> { return startPipePane(paneId, logPath); }
  stopPipe(paneId: string): Promise<void> { return stopPipePane(paneId); }
  send(paneId: string, keys: string): Promise<void> { return sendKeys(paneId, keys); }
  setOption(paneId: string, name: string, value: string): Promise<void> { return setPaneOption(paneId, name, value); }
  newWindow(name: string): Promise<string> { return newWindow(name); }
  renameWindow(windowId: string, name: string): Promise<void> { return renameWindow(windowId, name); }
  joinPane(srcPane: string, dst: string): Promise<void> { return joinPane(srcPane, dst); }
  breakPane(pane: string, name?: string): Promise<string> { return breakPane(pane, name); }
  swapPane(a: string, b: string): Promise<void> { return swapPane(a, b); }
  selectLayout(windowId: string, layout: string): Promise<void> { return selectLayout(windowId, layout); }
}
