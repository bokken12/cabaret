Correct the make-permanent CLI spelling

Expose make-permanent as the canonical command and retain make-permament as a hidden compatibility alias for existing callers.

Validation: CLI builds; change help lists the corrected spelling; both spellings accept --help with --change and --undo.