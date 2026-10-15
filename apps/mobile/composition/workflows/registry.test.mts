import { describe, expect, it } from "vitest";
import { createWorkflowRegistry } from "./registry.ts";

describe("workflow recipe registry (T117)", () => {
  const registry = createWorkflowRegistry();

  it("exposes all 22 catalog recipes with unique dev routes", () => {
    const recipes = registry.recipes();
    expect(recipes).toHaveLength(22);
    const routes = new Set(recipes.map((r) => r.devRoute));
    expect(routes.size).toBe(22);
  });

  it("launching every recipe id opens its golden route (smoke)", () => {
    const opened: string[] = [];
    const navigator = { openRoute: (route: string) => opened.push(route) };
    for (const recipe of registry.recipes()) {
      expect(registry.launch(recipe.id, navigator)).toBe(true);
      expect(opened.at(-1)).toBe(recipe.devRoute);
    }
    expect(opened).toHaveLength(22);
    expect(opened).toContain("/workflows/clipboard-translation");
    expect(opened).toContain("/workflows/morning-news");
  });

  it("unknown recipe ids never open a route", () => {
    const opened: string[] = [];
    const navigator = { openRoute: (route: string) => opened.push(route) };
    expect(registry.launch("no-such-recipe", navigator)).toBe(false);
    expect(registry.devRoute("no-such-recipe")).toBeUndefined();
    expect(opened).toEqual([]);
  });
});
