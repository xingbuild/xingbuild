import { projectObservationBrief } from "./briefProjection.js";
import { selectObservationBriefs } from "./observationQueries.js";
import { resolveRuntimeContentData } from "./contentDataArtifact.js";

// The old site is being frozen with the single media asset that has already
// passed content review and is present in the active public SiteSnapshot.
// Runtime ContentDataArtifact records intentionally do not duplicate the media
// manifest, so the product needs this final compatibility projection.
const approvedRuntimeMedia = Object.freeze({
  "robotaxi-evidence-fleet-operations-console-v1": Object.freeze({
    id: "robotaxi-evidence-fleet-operations-console-v1",
    type: "video",
    src: "/media/robotaxi/robotaxi-evidence-fleet-operations-console-v1.mp4",
    altZh: "Robotaxi 运营中控台从城市地图进入网格仿真，再选中一辆 Robotaxi 查看运营详情；城市地图用于空间规划，网格为模拟运行，不代表真实城市运营。",
    ratio: "8:5",
    state: "public",
  }),
});

function runtimeValues(data) {
  if (!(data?.records instanceof Map)) return [];
  return [...data.records.entries()]
    .filter(([key]) => key.startsWith("observation:"))
    .map(([, record]) => record && Object.hasOwn(record, "value") ? record.value : record)
    .filter(Boolean);
}

export function resolveRuntimeObservation(slug, data) {
  if (!slug) return null;
  return resolveRuntimeContentData({ logicalContentId: `observation:${slug}`, data });
}

export function resolveRuntimeObservationBriefs({ data, scope } = {}) {
  const briefs = runtimeValues(data).map(projectObservationBrief).filter(Boolean);
  return selectObservationBriefs(briefs, { scope: scope === "all" ? undefined : scope });
}

export function projectRuntimePractice(practice) {
  if (!practice) return null;
  return {
    ...practice,
    modules: (practice.modules || []).map((module) => ({
      ...module,
      media: module.mediaId ? approvedRuntimeMedia[module.mediaId] : undefined,
    })),
  };
}

export { approvedRuntimeMedia };
