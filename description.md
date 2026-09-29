Bulk actions over a home selection skip changes shown as context

Home rows now carry whether they are context (an ancestor drawn only to place the selected
changes), and a selection spanning one leaves it out, so e.g. `! w d` across a stack no longer
fails on a parent that has no workspace. The cursor alone on a context row still acts on it.