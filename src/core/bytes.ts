/**
 * Shared binary byte formatting — GB/MB, matching the cockpit's historical
 * display so the same pane shows the same figure everywhere it's mentioned
 * (the cockpit's memory column, the guardian's broadcast message, ...).
 */
export function formatBytes(n: number): string {
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}
