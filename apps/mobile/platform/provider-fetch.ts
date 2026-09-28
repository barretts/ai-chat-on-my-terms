/** Native Fetch keeps the selected server URL and its transport policy intact. */
export const providerFetch: typeof fetch = (input, init) => fetch(input, init);
