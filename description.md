Dispose VS Code page resources on extension shutdown

Register PageProvider with the extension subscriptions and dispose its event emitter and text decorations, clearing cached pages along with them.

Validation: TypeScript typecheck, oxlint, formatting, and diff whitespace checks pass. Extension-host shutdown was not exercised interactively.