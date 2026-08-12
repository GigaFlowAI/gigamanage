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
import type { Guardian } from "./guardian.js";
import type { ResourceMonitor } from "./resources.js";
import { makeSensor as defaultMakeSensor, type Sensor } from "./sensors.js";
import type { SemanticWorker } from "./semantic.js";
import type { WorkspaceModel } from "./workspace.js";

export interface DaemonDeps {
  gateway: TmuxGateway;
  model: WorkspaceModel;
  now: () => number;
  makeSensor?: (id: PaneIdentity, gw: TmuxGateway) => Sensor;
  semantic?: SemanticWorker;
  resources?: ResourceMonitor;
  guardian?: Guardian;
  /**
   * Overrides which present panes count as "agent panes" for guardian
   * broadcast targeting. Defaults to panes the registry has resolved to a
   * harness + session (`harness && sessionId`). This override exists only
   * so tests can mark panes as agents without a full link fixture — real
   * callers should leave it unset.
   */
  resolveAgents?: (present: PaneIdentity[]) => string[];
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
        if (this.deps.semantic) {
          const entry = this.deps.model.snapshot().panes.find((p) => p.identity.paneId === id.paneId);
          if (entry) this.deps.semantic.enqueue(entry, obs, now); // fire-and-forget, never awaited
        }
      } catch {
        // A single sensor failure must never abort the whole tick.
      }
    }

    if (this.deps.resources) {
      try {
        const panePids = new Map(present.map((p) => [p.paneId, p.pid]));
        const { perPane, host } = await this.deps.resources.sample(panePids);
        for (const [paneId, res] of perPane) this.deps.model.applyResources(paneId, res);
        this.deps.model.setHostPressure(host);

        if (this.deps.guardian) {
          const agentIds = this.deps.resolveAgents?.(present)
            ?? present.filter((p) => p.harness && p.sessionId).map((p) => p.paneId);
          const agentIdSet = new Set(agentIds);
          // Guardian.decide treats a pane as an agent via identity.harness &&
          // identity.sessionId. `resolveAgents` is a test-only override, so
          // when it's set, patch those fields (decision purposes only, never
          // persisted to the model) so the guardian agrees with the override.
          const panes = this.deps.model.snapshot().panes.map((p) => {
            if (!this.deps.resolveAgents || !agentIdSet.has(p.identity.paneId) || p.identity.harness) return p;
            return { ...p, identity: { ...p.identity, harness: "test-agent", sessionId: p.identity.paneId } };
          });
          const decision = this.deps.guardian.decide(host, panes, now);
          if (decision.action !== "none") {
            if (decision.action === "broadcast") {
              for (const id of agentIds) {
                await this.deps.gateway.send(id, decision.message + "\n").catch(() => {});
              }
            }
            this.deps.model.logGuardian({
              ts: now,
              pressure: host.usedRatio,
              culpritPaneId: decision.culpritPaneId,
              culpritLabel: decision.culpritLabel,
              action: decision.action,
              message: decision.message,
            });
          }
        }
      } catch {
        // Resource sampling / guardian failures must never abort the tick.
      }
    }

    this.deps.model.evictGone();
  }
}
