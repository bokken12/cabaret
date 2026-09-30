Declare RevisionId for the node bindings

The napi `dtsHeader` declared `Revision`, but the generated bindings use `RevisionId`. With `skipLibCheck` on, the unknown name quietly became `any`, so no revision the extension handled was type-checked. The header now declares `RevisionId`, and `skipLibCheck` is off so a gap like this fails the typecheck.