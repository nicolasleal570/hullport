import type { MigrationPlan, MigrationSelection } from "../../lib/api";

/**
 * What a migration copies unless the user changes it: every image and volume that isn't skipped
 * or in use, and loose containers with nothing in their writable layer. Replacing a volume already
 * in Hullport is never a default.
 */
export function defaultSelection(plan: MigrationPlan): MigrationSelection {
  return {
    images: plan.images.filter((i) => !i.skip).map((i) => i.id),
    volumes: plan.volumes.filter((v) => !v.skip && v.inUseBy.length === 0).map((v) => v.name),
    replaceVolumes: [],
    containers: plan.containers.filter((c) => !c.composeProject && !c.inTarget && !c.changes).map((c) => c.name),
  };
}
