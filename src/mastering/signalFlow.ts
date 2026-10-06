/** Shared order for the serial master signal path and its MASTER workspace view. */
export const MASTER_SIGNAL_FLOW = [
  { id: "inputTrim", label: "Input trim" },
  { id: "tape", label: "Tape" },
  { id: "midSide", label: "M/S" },
  { id: "bassMono", label: "Bass mono" },
  { id: "dcFilter", label: "DC filter" },
  { id: "matchEq", label: "MATCH EQ" },
  { id: "tilt", label: "Tilt" },
  { id: "glue", label: "Bus glue" },
  { id: "masterInserts", label: "Master inserts" },
  { id: "clipper", label: "Clipper" },
  { id: "monitorBypass", label: "Monitor bypass junction" },
  { id: "limiter", label: "Look-ahead limiter" },
  { id: "outputMeter", label: "Output meter" },
] as const;

export type MasterSignalFlowStageId = (typeof MASTER_SIGNAL_FLOW)[number]["id"];
export type MasterSignalNodeId = Exclude<MasterSignalFlowStageId, "outputMeter">;

/** Node stages the engine connects in series. The meter is a post-limiter tap. */
export const MASTER_SIGNAL_NODE_ORDER = MASTER_SIGNAL_FLOW.filter(
  (stage): stage is (typeof MASTER_SIGNAL_FLOW)[number] & { id: MasterSignalNodeId } => stage.id !== "outputMeter",
).map((stage) => stage.id);
