//! Pull request histories as the events importing records, read from responses GitHub gave.

use std::fmt::Write;

use cabaret_forge::github::{GitHub, Response};
use cabaret_types::log;
use expect_test::{Expect, expect};

/// The events of the pull request in `response`, each as its id, time, and author over its actions.
fn events(response: &str) -> String {
    let response: Response = serde_json::from_str(response).unwrap();
    let pull_request = response.data.repository.pull_request;
    let mut out = format!("change {}\n", pull_request.change().unwrap());
    for event in pull_request.events().unwrap() {
        writeln!(out, "{} at {} by {}", event.id, event.time, event.author).unwrap();
        for action in log::render(&event.actions).unwrap().lines() {
            writeln!(out, "  {action}").unwrap();
        }
    }
    out
}

fn check(response: &str, expected: &Expect) { expected.assert_eq(&events(response)); }

#[test]
fn reviewed() {
    check(
        include_str!("github_responses/reviewed.json"),
        &expect![[r#"
            change highlight-next-step
            PR_kwDOSmvcWM8AAAABG1q_Gg at 1791258786 by github:alice
              {"action":"add-owner","owner":"github:alice"}
              {"action":"set-title","title":"Highlight the next action beneath the lump of metadata"}
              {"action":"add-parent","parent":"main"}
              {"action":"set-reviewing","reviewing":"owners"}
            PRR_kwDOSmvcWM8AAAABQ6TD9w at 1791296599 by github:bob
              {"action":"add-owner","owner":"github:bob"}
              {"action":"unendorse","endorser":"github:bob"}
            RRE_lADOSmvcWM8AAAABVRjCz88AAAAHmPYP5g at 1791314837 by github:alice
              {"action":"add-owner","owner":"github:bob"}
            PRR_kwDOSmvcWM8AAAABRIX4EA at 1791387272 by github:bob
              {"action":"add-owner","owner":"github:bob"}
              {"action":"endorse","endorser":"github:bob"}
            ME_lADOSmvcWM8AAAABVRjCz88AAAAHnURKJw at 1791387281 by github:bob
              {"action":"set-archived","archived":true}
            CE_lADOSmvcWM8AAAABVRjCz88AAAAHnURKuA at 1791387281 by github:bob
              {"action":"set-archived","archived":true}
        "#]],
    );
}

#[test]
fn renamed_and_retargeted() {
    check(
        include_str!("github_responses/renamed_and_retargeted.json"),
        &expect![[r#"
            change rebase-outcome
            PR_kwDOSmvcWM71arpc at 1784817105 by github:carol
              {"action":"add-owner","owner":"github:carol"}
              {"action":"set-title","title":"rebase-outcome"}
              {"action":"add-parent","parent":"fix-and-commit"}
              {"action":"set-reviewing","reviewing":"owners"}
            RTE_lADOSmvcWM8AAAABJ6GDic8AAAAGnAhnkg at 1784817126 by github:carol
              {"action":"set-title","title":"Report a conflicted rebase as its outcome, not a failure"}
            BRCE_lADOSmvcWM8AAAABJ6GDic8AAAAGnAvzwQ at 1784817398 by github:bob
              {"action":"remove-parent","parent":"fix-and-commit"}
              {"action":"add-parent","parent":"main"}
            ME_lADOSmvcWM8AAAABJ6GDic8AAAAGnEdBOQ at 1784821941 by github:bob
              {"action":"set-archived","archived":true}
            CE_lADOSmvcWM8AAAABJ6GDic8AAAAGnEdBeQ at 1784821941 by github:bob
              {"action":"set-archived","archived":true}
        "#]],
    );
}

#[test]
fn drafted_dismissed_reopened() {
    check(
        include_str!("github_responses/drafted_dismissed_reopened.json"),
        &expect![[r#"
            change drafted
            PR_drafted at 1767225600 by github:ghost
              {"action":"add-owner","owner":"github:ghost"}
              {"action":"set-title","title":"Drafted"}
              {"action":"add-parent","parent":"main"}
              {"action":"set-reviewing","reviewing":"none"}
            RFRE_1 at 1767312000 by github:alice
              {"action":"set-reviewing","reviewing":"owners"}
            RRE_1 at 1767312001 by github:alice
              {"action":"add-owner","owner":"github:bob"}
            RDE_1 at 1767484800 by github:alice
              {"action":"unendorse","endorser":"github:bob"}
            RRRE_1 at 1767484801 by github:alice
              {"action":"remove-owner","owner":"github:bob"}
            CTDE_1 at 1767571200 by github:alice
              {"action":"set-reviewing","reviewing":"none"}
            CE_1 at 1767657600 by github:alice
              {"action":"set-archived","archived":true}
            RE_1 at 1767744000 by github:ghost
              {"action":"set-archived","archived":false}
        "#]],
    );
}

#[test]
fn repository_is_read_from_github_urls_only() {
    let urls = [
        "git@github.com:owner/name",
        "git@github.com:owner/name.git",
        "ssh://git@github.com/owner/name.git",
        "https://github.com/owner/name/",
        "https://gitlab.com/owner/name",
        "https://github.com/owner",
        "https://github.com/owner/name/tree",
        "/srv/git/name.git",
    ];
    let repositories: Vec<_> = urls.map(|url| format!("{url} {:?}\n", GitHub::repository(url))).into_iter().collect();
    expect![[r#"
        git@github.com:owner/name Some(("owner", "name"))
        git@github.com:owner/name.git Some(("owner", "name"))
        ssh://git@github.com/owner/name.git Some(("owner", "name"))
        https://github.com/owner/name/ Some(("owner", "name"))
        https://gitlab.com/owner/name None
        https://github.com/owner None
        https://github.com/owner/name/tree None
        /srv/git/name.git None
    "#]]
    .assert_eq(&repositories.concat());
}
