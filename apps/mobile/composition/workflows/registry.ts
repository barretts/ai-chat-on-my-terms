import {
  RECIPE_LEDGER,
  workflowDevRoute,
  type RecipeLedgerEntry,
} from "@locallab/workflows-integration";

/**
 * T117 — mobile composition mount for the 22 Shortcut recipes: the
 * app's development entry route table is driven by the shared ledger,
 * so the recipe set, automation intent bindings, and routes stay a
 * single source of truth.
 */
export interface WorkflowNavigator {
  openRoute(route: string): void;
}

export interface WorkflowRegistry {
  recipes(): readonly RecipeLedgerEntry[];
  devRoute(recipeId: string): string | undefined;
  launch(recipeId: string, navigator: WorkflowNavigator): boolean;
}

export function createWorkflowRegistry(): WorkflowRegistry {
  return {
    recipes: () => RECIPE_LEDGER,
    devRoute: (recipeId) => workflowDevRoute(recipeId),
    launch(recipeId, navigator) {
      const route = workflowDevRoute(recipeId);
      if (route === undefined) return false;
      navigator.openRoute(route);
      return true;
    },
  };
}
