const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const { localProviderProxy } = require("../../tools/local-provider-proxy.cjs");
const { webResearchProxy } = require("../../tools/web-research-proxy.cjs");
const { braveSearchProxy } = require("../../tools/brave-search-proxy.cjs");

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const previousResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = previousResolveRequest ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    const origin = path.relative(workspaceRoot, context.originModulePath).replaceAll("\\", "/");
    // Workspace sources use Node ESM .js specifiers for uncompiled TypeScript.
    if (
      /^(packages|modules)\//.test(origin) &&
      moduleName.startsWith(".") &&
      moduleName.endsWith(".js")
    ) {
      return resolve(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};
if (!config.resolver.assetExts.includes("wasm")) {
  config.resolver.assetExts.push("wasm");
}
const previousEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const next = previousEnhanceMiddleware
    ? previousEnhanceMiddleware(middleware, server)
    : middleware;
  return (request, response, nextHandler) => {
    response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    return braveSearchProxy(request, response, () =>
      webResearchProxy(request, response, () =>
        localProviderProxy(request, response, () =>
          next(request, response, nextHandler),
        ),
      ),
    );
  };
};

module.exports = config;
