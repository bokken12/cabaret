Previously, when a change's workspace was deleted, that would also remove the attached agent sessions since they were tied to the workspace location.

Now, even after the workspace is deleted, sessions are associated based on what the change's default workspace location would be, in case it existed and was deleted.