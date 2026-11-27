Metadata::reviewed borrows a reviewer's marks, empty for one who never marked, replacing five clones of review.get(..).cloned().unwrap_or_default() at the review_files call sites.
