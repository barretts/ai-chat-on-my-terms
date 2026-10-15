/**
 * T117E — food and travel recipes: Recipe Maker, Grocery Genius and
 * Tourist Guide. Preferences and local sources are optional inputs;
 * servings, budget and location stay user-reviewable fields on the
 * result; live place recommendations only fire through an enabled
 * search port — otherwise the result says live results are absent.
 */
import { z } from "zod";

export const PLANNING_WORKFLOWS = [
  "recipe-maker",
  "grocery-genius",
  "tourist-guide",
] as const;
export type PlanningWorkflow = (typeof PLANNING_WORKFLOWS)[number];

const ingredient = z.string().min(1).max(60);
const preference = z.string().min(1).max(40);

export const PlanningInputSchema = z.discriminatedUnion("workflow", [
  z
    .object({
      workflow: z.literal("recipe-maker"),
      ingredients: z.array(ingredient).min(1).max(40),
      diet: preference.optional(),
      servings: z.number().int().min(1).max(12),
    })
    .strict(),
  z
    .object({
      workflow: z.literal("grocery-genius"),
      pantry: z.array(ingredient).min(1).max(40),
      budgetUsd: z.number().min(0).max(1000),
      meals: z.number().int().min(1).max(21),
      diet: preference.optional(),
    })
    .strict(),
  z
    .object({
      workflow: z.literal("tourist-guide"),
      location: z
        .object({
          label: z.string().min(1).max(100),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
        })
        .strict(),
      days: z.number().int().min(1).max(14),
      interests: z.array(preference).max(8).optional(),
    })
    .strict(),
]);
export type PlanningInput = z.infer<typeof PlanningInputSchema>;
type TouristGuideInput = Extract<PlanningInput, { workflow: "tourist-guide" }>;

/** Step 2: the reviewable scalars ride the result unchanged. */
export interface ReviewablePlanFields {
  servings?: number;
  budgetUsd?: number;
  meals?: number;
  location?: { label: string };
  days?: number;
}

export function buildPrompt(input: PlanningInput): string {
  switch (input.workflow) {
    case "recipe-maker": {
      const diet = input.diet === undefined ? "" : `Diet: ${input.diet}.\n`;
      return `${diet}Plan ${input.servings} servings using mainly these ingredients (extras must be pantry staples).\nGive: recipe name, ingredient list with quantities for ${input.servings} servings, short steps.\n\nIngredients:\n- ${input.ingredients.join("\n- ")}`;
    }
    case "grocery-genius": {
      const diet = input.diet === undefined ? "" : `Diet: ${input.diet}.\n`;
      return `${diet}From the pantry below, plan ${input.meals} simple meals and output one consolidated shopping list whose estimated total stays under $${input.budgetUsd}.\nMark each item optional if a pantry item can cover it.\n\nPantry:\n- ${input.pantry.join("\n- ")}`;
    }
    case "tourist-guide": {
      const interests =
        input.interests === undefined || input.interests.length === 0
          ? ""
          : `Interests: ${input.interests.join(", ")}.\n`;
      return `${interests}Plan ${input.days} day(s) in ${input.location.label}. Give a per-day outline. Do not invent opening hours or prices; mark anything that needs live confirmation as "check locally".\n\nLocation: ${input.location.label}`;
    }
  }
}

export function planFields(input: PlanningInput): ReviewablePlanFields {
  switch (input.workflow) {
    case "recipe-maker":
      return { servings: input.servings };
    case "grocery-genius":
      return { budgetUsd: input.budgetUsd, meals: input.meals };
    case "tourist-guide":
      return { location: { label: input.location.label }, days: input.days };
  }
}

/* ---------------- live places gated on search (step 3) ---------------- */

export interface SearchPort {
  search(query: string): Promise<string[]>;
}

export type PlaceRecommendations =
  | { available: true; places: string[] }
  | { available: false; notice: "search-not-enabled" };

export async function requestPlaceRecommendations(
  locationLabel: string,
  options: { searchEnabled: boolean; search?: SearchPort },
): Promise<PlaceRecommendations> {
  const port = options.search;
  if (!options.searchEnabled || port === undefined)
    return { available: false, notice: "search-not-enabled" };
  const places = await port.search(`places to visit in ${locationLabel}`);
  return { available: true, places };
}

/* ---------------- run seam ---------------- */

export type PlanningResult =
  | {
      ok: true;
      text: string;
      fields: ReviewablePlanFields;
      places?: PlaceRecommendations;
    }
  | { ok: false; reason: "model-unavailable" | "invalid-input" };

export async function runPlanningWorkflow(
  input: unknown,
  options: {
    modelClass: string;
    generate(
      prompt: string,
      modelClass: string,
    ): Promise<{ ok: true; text: string } | { ok: false; reason: "model-unavailable" }>;
    searchEnabled: boolean;
    search?: SearchPort;
  },
): Promise<PlanningResult> {
  const parsed = PlanningInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };
  const prompt = buildPrompt(parsed.data);
  const outcome = await options.generate(prompt, options.modelClass);
  if (!outcome.ok) return { ok: false, reason: "model-unavailable" };
  return {
    ok: true,
    text: outcome.text,
    fields: planFields(parsed.data),
    ...(parsed.data.workflow === "tourist-guide"
      ? {
          places: await placeFor(parsed.data satisfies TouristGuideInput, options),
        }
      : {}),
  };
}

async function placeFor(
  input: TouristGuideInput,
  options: { searchEnabled: boolean; search?: SearchPort },
): Promise<PlaceRecommendations> {
  return await requestPlaceRecommendations(input.location.label, options);
}
