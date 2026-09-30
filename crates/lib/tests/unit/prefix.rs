use cabaret_lib::Prefix;
use expect_test::{Expect, expect};
use jiff::{Timestamp, tz::TimeZone};

/// `template` applied to `foo` on 2026-09-24 at 15:04:05 UTC, or why it cannot be.
fn check(template: &str, expected: &Expect) {
    let now = "2026-09-24T15:04:05Z".parse::<Timestamp>().unwrap().to_zoned(TimeZone::UTC);
    let applied = template.parse::<Prefix>().and_then(|prefix| prefix.apply("foo", &now));
    expected.assert_eq(&match applied {
        Ok(id) => id.to_string(),
        Err(error) => format!("{error:?}"),
    });
}

#[test]
fn literal_prefix_is_prepended() { check("joel-", &expect!["joel-foo"]); }

#[test]
fn prefix_may_namespace_ids() { check("joel/", &expect!["joel/foo"]); }

#[test]
fn date_escapes_expand_to_creation_time() { check("%Y%m%d-", &expect!["20260924-foo"]); }

#[test]
fn month_name_escape_expands() { check("joel/%b%d-", &expect!["joel/Sep24-foo"]); }

#[test]
fn escape_to_invalid_ref_name_is_refused() {
    check("%H:%M-", &expect![[r#""%H:%M-" cannot prefix a change id: Reference name contains invalid byte: ":""#]]);
}

#[test]
fn unknown_escape_is_refused() {
    check(
        "%J-",
        &expect![[
            r#""%J-" cannot prefix a change id: strftime formatting failed: found unrecognized specifier directive `J`"#
        ]],
    );
}

#[test]
fn empty_prefix_leaves_name() { check("", &expect!["foo"]); }
