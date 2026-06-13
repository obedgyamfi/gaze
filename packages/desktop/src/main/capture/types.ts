// The wire types live in the app package (single source of truth shared with the
// renderer's platform capability). Re-export them here so the main capture code
// keeps importing from "./types".

export type {
  BodyData,
  BodyMeta,
  CaptureFilter,
  CaptureRecord,
  CaptureSource,
  CaptureStreamEvent,
  FormRecord,
  HeaderPair,
  HttpSide,
  NavRecord,
  RepeaterRequest,
} from "@opencode-ai/app/web/capture-types"
