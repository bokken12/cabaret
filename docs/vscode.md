# VSCode

I expect the primary interface to Cabaret to be its VSCode extension. I think being in-editor is a valuable benefit over GitHub/GitLab, and VSCode and its derivatives are by far the most popular.

## Interface

VSCode extensions run on NodeJS, which doesn't fit in with Cabaret's core Rust code. There are a number of possible directions:

### (Re)Implementation in TypeScript

Core Cabaret logic could be written in JavaScript/TypeScript. However, as we saw in the initial implementation, this would require subprocesses or isomorphic-git, both of which impose a substantial performance cost which we are not willing to eat.

### Cabaret Daemon

We could run a Cabaret server as a sort of sidecar, sending requests to the Rust process from the extension via json-rpc or a socket (Cabaret is not LSP-shaped, and so can't build on the many Rust LSPs). This would work fairly well, but creates some coordination problems to solve. Can we do better?

### NAPI-RS

NAPI-RS builds Node-API add-ons from Rust code, which we could deploy together with our extension. This would allow us to call Rust directly without coordinating processes. Then we could have just a thin TypeScript shell to interface with VSCode decorations, around the Rust core logic.

I should note though, that there does not seem to be substantial prior art in using NAPI-RS for VSCode extensions. Therefore, if we begin to encounter too many footguns, we may revert to some daemon-shaped approach.
