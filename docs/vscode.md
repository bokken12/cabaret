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

## UI

Cabaret's UI in VSCode faces some choices. In particular, whether it should feel more like a text buffer or more like a web page.

## Web

VSCode is built on Node.js and Electron. It has an easy time just embedding websites into its app. HTML & CSS allow for expansive design, and doing so would enable sharing between Cabaret's VSCode extension and a future standalone website. In many ways this would be convenient.

However, the downside of using a proper website would be that it would feel less native to VSCode. Users of say, VSCodeVim could not use their keybindings to navigate around its interface. Cabaret wants to appeal to those who care about their custom setups.

### Text Buffers

To fit into native VSCode, Cabaret would have to provide normal text buffers, with plain monospaced ASCII/Unicode for its UIs. This would provide far fewer options for prettifying than web.

VSCode does expose some decoration options: we could define custom languages or schemes and give highlights, bolding, gutter info, and similar. These would be all we'd need for nice diffs, but somewhat lacking for menus.

### Notebooks

VSCode has a few unusual features that could blend between these. E.g., it has a special mode for notebooks (such as Jupyter) that combines text buffers with other generated elements. However, these largely add complication and don't seem to fit Cabaret's model very well.

### Decision

Ultimately, I think that I care more about the in-editor native feel than making the Cabaret extension super pretty. Especially when its predominant view would be of diffs, which in the web I'd just want to open up Shiki to recreate VSCode to view, but would lose the user's settings in the process.

I believe we could augment this somewhat by equipping the Cabaret extension with a sidebar element. This should ideally not be required for use, but could be e.g. status/info adjacent to whatever currently has your focus, and would have more freedom in its layout.
