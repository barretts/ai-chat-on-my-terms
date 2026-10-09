import { afterEach, expect, it, vi } from "vitest";

vi.mock("expo/fetch", () => ({
  fetch: vi.fn(async () => new Response("Public response")),
}));
import { fetch as expoFetch } from "expo/fetch";
import { webAccessFetch as nativeFetch } from "./web-access";
import { webAccessFetch as webFetch } from "./web-access.web";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const unsafeInit: RequestInit = {
  method: "POST",
  credentials: "include",
  redirect: "follow",
  headers: {
    authorization: "Bearer must-not-leak",
    cookie: "must-not-leak",
    "x-api-key": "must-not-leak",
  },
};

it("native research uses Expo's fetch and forwards only its safe Accept header and cancellation signal", async () => {
  const signal = new AbortController().signal;
  await nativeFetch("https://r.jina.ai/https://docs.expo.dev/", {
    ...unsafeInit,
    signal,
  });
  expect(expoFetch).toHaveBeenCalledWith(
    "https://r.jina.ai/https://docs.expo.dev/",
    {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal,
    },
  );
});

it("local browser research uses the same-origin preview relay without forwarding any credentials", async () => {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", origin: "http://localhost:8085" },
  });
  const fetcher = vi.fn(async () => new Response("Public response"));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await webFetch("https://lite.duckduckgo.com/lite/?q=Expo", {
    ...unsafeInit,
    signal,
  });
  const [input, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(input.origin).toBe("http://localhost:8085");
  expect(input.pathname).toBe("/_locallab/web");
  expect(input.searchParams.get("url")).toBe(
    "https://lite.duckduckgo.com/lite/?q=Expo",
  );
  expect(init).toEqual({
    method: "GET",
    headers: { "x-locallab-preview": "1" },
    credentials: "omit",
    redirect: "error",
    signal,
  });
});

it("a hosted browser uses direct research HTTPS with safe headers and omitted credentials", async () => {
  vi.stubGlobal("window", {
    location: {
      hostname: "preview.example.com",
      origin: "https://preview.example.com",
    },
  });
  const fetcher = vi.fn(async () => new Response("Public response"));
  vi.stubGlobal("fetch", fetcher);
  await webFetch("https://r.jina.ai/https://docs.expo.dev/", unsafeInit);
  expect(fetcher).toHaveBeenCalledWith(
    "https://r.jina.ai/https://docs.expo.dev/",
    {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
    },
  );
});
