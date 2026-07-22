import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import {
  ArchivedParentError,
  DirtyWorkspaceError,
  DivergedParentError,
  NotOwnerError,
  NotReviewingError,
  UnreviewedParentError,
  UnsatisfiedObligationsError,
  UserError,
  VERSION,
} from "cabaret-core";
import { approve } from "./commands/approve.js";
import { archive } from "./commands/archive.js";
import { comment } from "./commands/comment.js";
import { commit } from "./commands/commit.js";
import { config } from "./commands/config.js";
import { conflicts } from "./commands/conflicts.js";
import { create } from "./commands/create.js";
import { dev } from "./commands/dev.js";
import { diff } from "./commands/diff.js";
import { fetch } from "./commands/fetch.js";
import { forget } from "./commands/forget.js";
import { home } from "./commands/home.js";
import { land } from "./commands/land.js";
import { mark } from "./commands/mark.js";
import { owner } from "./commands/owner.js";
import { permanent } from "./commands/permanent.js";
import { rebase } from "./commands/rebase.js";
import { reparent } from "./commands/reparent.js";
import { review } from "./commands/review.js";
import { reviewers } from "./commands/reviewers.js";
import { reviewing } from "./commands/reviewing.js";
import { setup } from "./commands/setup.js";
import { show } from "./commands/show.js";
import { sync } from "./commands/sync.js";
import { todos } from "./commands/todos.js";
import { tui } from "./commands/tui.js";
import { workspace } from "./commands/workspace.js";

/** A `UserError`'s message, with this frontend's remedy attached to the overridable checks. */
function userMessage(error: UserError): string {
  if (error instanceof NotOwnerError) {
    return `${error.message}; pass --even-though-not-owner to override`;
  }
  if (error instanceof NotReviewingError) {
    return `${error.message}; pass --even-though-not-reviewing to override`;
  }
  if (error instanceof DivergedParentError) {
    return `${error.message}, or pass --even-though-parent-diverged to proceed on the local reading`;
  }
  if (error instanceof ArchivedParentError) {
    return `${error.message}, or pass --even-though-parent-archived to proceed`;
  }
  if (error instanceof UnsatisfiedObligationsError) {
    return `review obligations are unsatisfied; pass --even-though-unreviewed to override:\n${error.details.join("\n")}`;
  }
  if (error instanceof UnreviewedParentError) {
    return (
      `parent ${JSON.stringify(error.parent)} has unsatisfied review obligations; ` +
      `pass --even-though-parent-unreviewed to override:\n${error.details.join("\n")}`
    );
  }
  if (error instanceof DirtyWorkspaceError) {
    return `${error.message}; pass --even-though-dirty to override`;
  }
  return error.message;
}

const routes = buildRouteMap({
  docs: {
    brief: "Diff-based distributed code review built on top of your version control",
  },
  routes: {
    approve,
    archive,
    comment,
    commit,
    config,
    conflicts,
    create,
    dev,
    diff,
    fetch,
    forget,
    home,
    land,
    mark,
    owner,
    permanent,
    rebase,
    reparent,
    review,
    reviewers,
    reviewing,
    setup,
    show,
    sync,
    todos,
    tui,
    workspace,
  },
});

export const app = buildApplication(routes, {
  name: "cab",
  versionInfo: { currentVersion: VERSION },
  // Display flags as kebab-case (matching the CLI-wide convention) while still
  // accepting the camelCase spelling of each flag name.
  scanner: { caseStyle: "allow-kebab-for-camel" },
  localization: {
    text: {
      ...text_en,
      // A `UserError`'s message is the complete diagnostic, so it prints
      // bare. Any other exception is a bug in Cabaret, where the default
      // stack-bearing rendering earns its keep.
      formatException: (exc) =>
        exc instanceof UserError ? userMessage(exc) : exc instanceof Error ? (exc.stack ?? String(exc)) : String(exc),
      exceptionWhileRunningCommand(exc, ansiColor) {
        return exc instanceof UserError
          ? userMessage(exc)
          : text_en.exceptionWhileRunningCommand.call(this, exc, ansiColor);
      },
    },
  },
});
