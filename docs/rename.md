# Renaming

Why can't Cabaret rename my change? This feels like a core functionality which should be present and must represent an oversight.

Well, unfortunately Cabaret is somewhat constrained here by its goal of interoperability with GitHub and similar forges. Their PRs/MRs are inextricably tied to fixed branch names.

Cabaret could create some other form of identity and then upon a rename delete and recreate forge changes: but this is antithetical to its goals of being a good review tool that plays nicely with others.

Therefore, the names of branches/changes must be thought of as kinds of immutable IDs, with titles being used for friendlier names when preferred.

<!-- Maybe someday we should swap "name" -> ID? we should also support/use titles. -->
