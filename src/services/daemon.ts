/**
 * The daemon tick loop: registry diff → attach/detach sensors → observe →
 * classify → write state to the model → evict gone panes.
 *
 * No LLM here (Phase 0) — `classifyState` is a pure heuristic over the raw
 * `Observation`. Sensors and the clock are injected so the whole loop can be
 * driven headlessly in tests, without a real tmux server.
 */

import type { PaneIdentity } from "../core/gmux-types.js";
import { classifyState } from "../core/pane-state.js";
import type { TmuxGateway } from "./tmux-gateway.js";
import { PaneRegistry } from "./pane-registry.js";
import { makeSensor as defaultMakeSensor, type Sensor } from "./sensors.js";
import type { WorkspaceModel } from "./workspace.js";

export interface DaemonDeps {
  gateway: TmuxGateway;
  model: WorkspaceModel;
  now: () => number;
  makeSensor?: (id: PaneIdentity, gw: TmuxGateway) => Sensor;
}

export class Daemon {
  private registry: PaneRegistry;
  /** Long-lived per pane: created on appear, torn down on vanish. This is
   * what lets AgentSensor's lazy transcript-file resolution pay off over
   * the pane's whole lifetime instead of retrying from scratch each tick. */
  private sensors = new Map<string, Sensor>();
  private make: (id: PaneIdentity, gw: TmuxGateway) => Sensor;

  constructor(private readonly deps: DaemonDeps) {
    this.registry = new PaneRegistry(deps.gateway);
    this.make = deps.makeSensor ?? defaultMakeSensor;
  }

  async tickOnce(): Promise<void> {
    const now = this.deps.now();
    const { present, vanished } = await this.registry.diff();

    for (const id of vanished) {
      await this.sensors.get(id)?.teardown().catch(() => {});
      this.sensors.delete(id);
      this.deps.model.markGone(id);
    }

    for (const id of present) {
      this.deps.model.upsertIdentity(id);
      let sensor = this.sensors.get(id.paneId);
      if (!sensor) {
        sensor = this.make(id, this.deps.gateway);
        this.sensors.set(id.paneId, sensor);
      }
      try {
        const obs = await sensor.observe(now);
        this.deps.model.applyState(id.paneId, classifyState(obs, now), obs.lastActivityTs, now);
      } catch {
        // A single sensor failure must never abort the whole tick.
      }
    }

    this.deps.model.evictGone();
  }
}
