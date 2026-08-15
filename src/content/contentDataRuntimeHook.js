import { useEffect, useState } from "react";
import {
  contentDataRuntimeEnabled,
  fetchRuntimeContentData,
  getRuntimeContentData,
  getRuntimeContentDataError,
} from "./contentDataArtifact.js";

export function useContentDataRuntime() {
  const enabled = contentDataRuntimeEnabled();
  const [state, setState] = useState(() => enabled
    ? { status: getRuntimeContentData() ? "ready" : "loading", data: getRuntimeContentData(), error: getRuntimeContentDataError() }
    : { status: "disabled", data: null, error: null });

  useEffect(() => {
    if (!enabled) return undefined;
    let mounted = true;
    fetchRuntimeContentData()
      .then((data) => { if (mounted) setState({ status: "ready", data, error: null }); })
      .catch((error) => { if (mounted) setState({ status: "fallback", data: null, error }); });
    return () => { mounted = false; };
  }, [enabled]);

  return state;
}
