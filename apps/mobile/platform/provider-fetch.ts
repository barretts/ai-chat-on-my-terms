/** Native Fetch keeps the selected server URL and its transport policy intact. */
import { tracedFetch } from "../features/diagnostics/trace-fetch";
export const providerFetch: typeof fetch = tracedFetch(
  (input, init) => fetch(input, init),
  "Model HTTP request",
);
