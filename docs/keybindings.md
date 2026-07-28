# Keybindings

Cabaret is a keyboard-centric app. This enables users to navigate it and review files faster.

## Vim

Users to whom this keyboard-centric mindset appeals are likely to already use vim. Therefore we work to avoid conflicting too badly with vim keybindings, particularly those for navigation, selection, and search, all of which are useful in Cabaret. We can however conflict with keybindings that are mainly for editing (our buffers are read-only) or even some horizontal navigation (we really only need vertical navigation). We will provide reimplementations of the basic vim keybindings for frontends which lack them (e.g. cabaret-tui or cabaret-web).

## Simplicity

We hope to have a simple and intuitive set of keybindings. This means the chords should ideally map fairly onto the words we think of for their commands, and we should avoid overlap where multiple bindings mean the same thing in different contexts. We reserve short chords for common operations, and attempt to distinguish mutating actions with the `!` prefix.

## Onboarding

It can be hard to get new users fluent with a set of keybindings. Where possible, we should make it easy to learn and search through the keybindings (e.g. with the `?` menu), and even sometimes even hint/remind users more proactively.
