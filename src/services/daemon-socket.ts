// src/services/daemon-socket.ts
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceModel } from "./workspace.js";
import { gmuxSnapshotPath, gmuxSocketPath } from "../core/paths.js";

export class ModelServer {
  private server: Server | undefined;
  private clients = new Set<Socket>();
  private readonly onChange = () => { void this.broadcast(); };

  constructor(
    private readonly model: WorkspaceModel,
    private readonly socketPath: string = gmuxSocketPath(),
    private readonly snapshotPath: string = gmuxSnapshotPath(),
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });
    await rm(this.socketPath, { force: true });
    this.server = createServer((sock) => {
      this.clients.add(sock);
      sock.on("close", () => this.clients.delete(sock));
      sock.on("error", () => this.clients.delete(sock));
      sock.write(this.line()); // initial snapshot
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
    this.model.on("change", this.onChange);
    await this.writeSnapshot();
  }

  private line(): string { return JSON.stringify(this.model.snapshot()) + "\n"; }

  private async broadcast(): Promise<void> {
    const line = this.line();
    // Write the snapshot file first so it never lags behind what clients see
    // (also avoids a race where a socket read outpaces the async fs write).
    await this.writeSnapshot();
    for (const c of this.clients) c.write(line);
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.tmp`;
    await writeFile(tmp, this.line(), "utf8");
    await rename(tmp, this.snapshotPath);
  }

  async stop(): Promise<void> {
    this.model.off("change", this.onChange);
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await rm(this.socketPath, { force: true });
  }
}
