# Identity

When we record the review that some user has performed, we must associate it with some identity so that they can resume at that state later. What should that identity be? Let's consider some options.

## Possible Identities

### GitHub Accounts

GitHub already has a strong version of identity through its accounts, which would work well here. However this is not something we can validate offline, and it ties us too closely to a single forge.

### Git `user.name`

Git allows you to configure a `user.name` to associate with your commits. This would fit neatly in our data model as simple and configurable, but can be set arbitrarily to be non-unique, impersonate others, or have awkward formatting (e.g. include spaces).

### Git `user.email`

When representing a user's real email, `user.email` is more likely to be unique, although at the same time may be more unwieldy to type. It still suffers from impersonation and similar.

### Public Key Cryptography

Public key crypography could provide a method of distributed identity verification, but may be more intimidating for users.

## Proposed

My leaning is towards basing identity on `user.email`. Although it would require some trust, git is already fairly permissive by default.

